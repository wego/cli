import { isHelpArg } from "./commands";
import { assertSecureUrl } from "./config";
import { EXIT, exitCodeForError } from "./error-report";
import {
  identitiesForRing,
  MANIFEST_ASSET,
  SIGNATURE_ASSET,
  SIGNING_OIDC_ISSUER,
  verifySignedManifest,
} from "./release-signing";
import {
  followRecordedRing,
  type InstallRecord,
  ringAssetUrl,
  ringRecordUrl,
} from "./ring-follow";
import { usage, usageErrorLabel } from "./usage";

/**
 * `wego update` — replace the installed binary in place with the latest release
 * from its own channel.
 *
 * The CLI ships as a self-contained single-file binary published to a public
 * Vercel Blob store under a ring pointer (`cli/edge`, `cli/next`, `cli/stable`),
 * named `<flavor>-<os>-<arch>`, with a per-ring `SHA256SUMS.txt`. This command
 * mirrors the `curl … | bash` installer (`apps/api` `renderInstallScript`) in
 * TypeScript: platform-detect → fetch the checksums → compare against the running
 * binary → download → verify fail-closed → atomically swap `process.execPath`.
 *
 * Where it fetches from is the **ring the installer recorded** on this machine
 * (`~/.config/<scope>/install.json`, `ring-follow.ts`), never a URL baked into
 * the binary: self-update compares checksums rather than versions, so the pointer
 * is the whole policy and it has to be a fact on the machine rather than a build
 * argument (foundations#74 rung 3). Assets are fetched through the recorded
 * endpoint's own `?dl=` branch, so the release store stays server-side here too.
 * **No record is a refusal**, not a fallback: guessing a ring is the drift this
 * design removes. A from-source run still degrades to a "reinstall" hint — there
 * is no installed binary to replace, so there is nothing to record.
 *
 * Written against injected deps so the flow is unit-testable without touching the
 * network or the real filesystem; `index.ts` wires the concrete implementations.
 */

/** The from-source version stamp (matches `index.ts`'s `VERSION` fallback). */
const DEV_VERSION = "0.0.0-dev";

export interface UpdateIo {
  log: (message: string) => void;
  error: (message: string) => void;
}

export interface UpdateDeps extends UpdateIo {
  /** The running binary's version (matches `wego version`); `0.0.0-dev` from source. */
  version: string;
  /** True when running from source (a runtime exec-path signal, NOT the
   *  env-stamped version which a stray `WEGO_BUILD_VERSION` can spoof). When true,
   *  self-update refuses: `execPath` is the Bun/Node runtime, not an installed
   *  binary to replace. */
  fromSource: boolean;
  /** The install record this binary follows, or `null` when there is none, it is
   *  unreadable, or it is malformed (`ring-follow.ts` folds all three into one
   *  `null` — every one of them refuses). */
  readInstallRecord: () => Promise<InstallRecord | null>;
  /** Where that record lives, named in the refusal so the user can see what is
   *  missing. */
  installRecordPath: string;
  /** Where this install's files lived before the config scope became the command
   *  name (`config.ts` `legacyScopeDir`); `undefined` for every install whose name
   *  still matches its release. Only ever printed, in the no-record refusal. */
  legacyScopeDir?: string;
  /** The asset-name prefix / build flavor: `wego` | `wegostaging`. */
  flavor: string;
  /** `<apiBase>/install` for the reinstall hint; undefined when unbaked. */
  installUrl?: string;
  /** `process.platform`. */
  platform: NodeJS.Platform;
  /** `process.arch`. */
  arch: string;
  /** Absolute path of the running binary (`process.execPath`). */
  execPath: string;
  /** `fetch`, injectable for tests. */
  fetch: typeof fetch;
  /** Gunzip a gzip member in-process (`Bun.gunzipSync`). Injectable for tests. */
  gunzip: (data: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>;
  /** Lowercase hex sha256 of the file at `path`. */
  hashFile: (path: string) => Promise<string>;
  /** Write bytes to `path`. */
  writeFile: (path: string, data: Uint8Array) => Promise<void>;
  /** `chmod path mode`. */
  chmod: (path: string, mode: number) => Promise<void>;
  /** Atomic rename `from` → `to`. */
  rename: (from: string, to: string) => Promise<void>;
  /** Best-effort remove (force). */
  rm: (path: string) => Promise<void>;
  /** Best-effort clear the macOS `com.apple.quarantine` xattr; no-op elsewhere. */
  clearQuarantine: (path: string) => Promise<void>;
  /** Confirm the in-place replace; bypassed by `-y`. */
  confirm: (question: string) => Promise<boolean>;
  /** A per-run-unique temp path, a sibling of `execPath` on the same filesystem
   *  (so the final rename stays atomic and two concurrent runs can't collide on
   *  one predictable name — the post-verify swap TOCTOU). */
  tempPath: string;
  /** Best-effort remove any stale temp siblings an interrupted run left behind. */
  sweepTemps: () => Promise<void>;
  /** The Sigstore roots a signed build record must chain to (foundations#74 rung
   *  9). Injected like every other dep here so a test can pin its own throwaway
   *  root; `index.ts` wires the real pinned Fulcio anchors. Not a user-reachable
   *  switch — there is no flag or env var that reaches it. */
  trustedRootsPem: string;
  /** Run the freshly swapped binary's own `skill install --owned-only`.
   *
   *  Optional: absent ⇒ the step is skipped, which is what every unit test
   *  that builds these deps by hand wants. `index.ts` wires the real spawn. */
  spawnSkillInstall?: (execPath: string) => Promise<void>;
}

interface UpdateOptions {
  check: boolean;
  yes: boolean;
  force: boolean;
}

export const UPDATE_USAGE = usage({
  cmd: "update",
  what: "Replace this binary with the latest release from its ring. Checksum verified.",
  flags: [
    ["--check", "Only report whether an update exists."],
    ["-y", "Skip the confirm."],
    ["--force", "Download again even when already up to date."],
  ],
  note: "An install with no recorded ring refuses. Not available when running from source.",
});

/**
 * Parse `wego update` argv (everything after `update`). Every flag is a valueless
 * boolean; anything else (an unknown flag or a stray positional) is a usage
 * error. Throws a usage `Error` the caller renders on stderr with exit 2.
 */
export function parseUpdateArgs(args: string[]): UpdateOptions {
  const opts: UpdateOptions = { check: false, yes: false, force: false };
  for (const arg of args) {
    switch (arg) {
      case "--check":
        opts.check = true;
        break;
      case "-y":
      case "--yes":
        opts.yes = true;
        break;
      case "--force":
        opts.force = true;
        break;
      default:
        throw new Error(`${usageErrorLabel(arg)}: ${arg}\n${UPDATE_USAGE}`);
    }
  }
  return opts;
}

/** The `curl … | bash` reinstall one-liner, naming the deploy's install URL when
 *  it was baked, else a placeholder. */
function reinstallHint(deps: UpdateDeps): string {
  return `curl -fsSL ${deps.installUrl ?? "<your-api-host>/install"} | bash`;
}

// The installer's asset scheme: the same {darwin,linux}/{arm64,x64} set the
// install script's `uname` mapping produces (`apps/api` `renderInstallScript`).
const OS_BY_PLATFORM: Partial<Record<NodeJS.Platform, "darwin" | "linux">> = {
  darwin: "darwin",
  linux: "linux",
};
const ARCH_BY_NODE_ARCH: Record<string, "arm64" | "x64" | undefined> = {
  arm64: "arm64",
  x64: "x64",
};

/** Map `process.platform`/`arch` to the installer's asset scheme, or null when
 *  unsupported. */
function assetOsArch(
  deps: UpdateDeps,
): { os: "darwin" | "linux"; arch: "arm64" | "x64" } | null {
  const os = OS_BY_PLATFORM[deps.platform];
  const arch = ARCH_BY_NODE_ARCH[deps.arch];
  return os && arch ? { os, arch } : null;
}

/** Pull the sha256 for `asset` out of a `SHA256SUMS.txt` body (`<hash>␠␠<name>`
 *  lines, as `sha256sum` writes them), or null when absent. */
function expectedSum(sums: string, asset: string): string | null {
  for (const line of sums.split("\n")) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (match && match[2].trim() === asset) return match[1].toLowerCase();
  }
  return null;
}

// Network deadlines, mirroring the install script's `curl --connect-timeout 15
// --max-time 600`: the small checksums read gets a short deadline; the 60–95 MB
// binary download a long one. Without a signal a stalled blob would hang the
// self-update forever (a `TimeoutError` maps to the timeout/network exit class).
const SUMS_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 600_000;

/** `fetch` under a hard deadline, throwing on a non-2xx so the caller's catch
 *  maps it to an exit class. */
async function fetchOk(
  deps: UpdateDeps,
  url: string,
  timeoutMs: number,
): Promise<Response> {
  const res = await deps.fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`failed to fetch ${url} (HTTP ${res.status})`);
  return res;
}

/** Map a download/replace failure to an actionable stderr line + exit code,
 *  keeping the errno branches out of `downloadAndReplace`'s complexity budget. */
function classifyReplaceError(
  deps: UpdateDeps,
  err: unknown,
): { message: string; code: number } {
  const errno = (err as NodeJS.ErrnoException | undefined)?.code;
  if (errno === "EACCES" || errno === "EPERM") {
    return {
      message: `cannot write ${deps.execPath} (permission denied). Re-run with write access to that path, or reinstall:\n  ${reinstallHint(deps)}`,
      code: EXIT.ERROR,
    };
  }
  if (errno === "EXDEV") {
    return {
      message: `cannot replace ${deps.execPath} across filesystems. Reinstall instead:\n  ${reinstallHint(deps)}`,
      code: EXIT.ERROR,
    };
  }
  if (errno === "ENOSPC") {
    return {
      message: `not enough disk space to download the new ${deps.flavor} binary. Free up space and retry.`,
      code: EXIT.ERROR,
    };
  }
  if (errno === "EROFS") {
    return {
      message: `${deps.execPath} is on a read-only filesystem – cannot update it in place. Reinstall instead:\n  ${reinstallHint(deps)}`,
      code: EXIT.ERROR,
    };
  }
  return {
    message: `update failed: ${err instanceof Error ? err.message : String(err)}`,
    code: exitCodeForError(err),
  };
}

/** Fetch the new binary's bytes, preferring the gzipped asset (issue #1235): it
 *  is ~2.7× smaller (63.8 → 24.0 MB) and the download is the whole update cost.
 *  Decompress it in-process, and fall back to the raw asset ONLY when the archive
 *  is absent — HTTP 404, the state of a channel frozen from a pre-#1235 tag, which
 *  carries no `.gz`. A gz that is present but malformed (or a non-404 error)
 *  throws rather than silently retrying the raw asset — a tampered archive must
 *  not degrade into a different download. The caller's fail-closed hash check then
 *  rejects any decompressed binary that doesn't match the raw checksum, so the gz
 *  is never trusted beyond decompression. */
async function fetchNewBinary(
  deps: UpdateDeps,
  base: string,
  ring: string,
  asset: string,
): Promise<Uint8Array> {
  const gzUrl = ringAssetUrl(base, `${asset}.gz`, ring);
  const gz = await deps.fetch(gzUrl, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (gz.status === 404) {
    const raw = await fetchOk(
      deps,
      ringAssetUrl(base, asset, ring),
      DOWNLOAD_TIMEOUT_MS,
    );
    return new Uint8Array(await raw.arrayBuffer());
  }
  if (!gz.ok) {
    throw new Error(`failed to fetch ${gzUrl} (HTTP ${gz.status})`);
  }
  return deps.gunzip(new Uint8Array(await gz.arrayBuffer()));
}

/** Download the asset, verify it against `expected`, and atomically swap it over
 *  the running binary. Returns an exit code; leaves no partial file behind. */
async function downloadAndReplace(
  deps: UpdateDeps,
  base: string,
  ring: string,
  asset: string,
  expected: string,
  os: "darwin" | "linux",
): Promise<number> {
  // A per-run-unique sibling of the running binary: same filesystem (so the final
  // rename stays atomic, never EXDEV) and non-shared (two concurrent runs can't
  // race on one predictable path, defeating the fail-closed check). Swept and
  // cleaned up on every failure path.
  const tmp = deps.tempPath;
  await deps.sweepTemps();
  try {
    await deps.writeFile(tmp, await fetchNewBinary(deps, base, ring, asset));
    const got = await deps.hashFile(tmp);
    if (got !== expected) {
      // Guard the cleanup so a failed `rm` can't swallow the security-relevant
      // "refusing to install" signal + its stable exit code (fall into catch).
      await deps.rm(tmp).catch(() => {});
      deps.error(
        `checksum mismatch for ${asset} (expected ${expected}, got ${got}) – refusing to install`,
      );
      return EXIT.PERMANENT;
    }
    await deps.chmod(tmp, 0o755);
    // Clear the Gatekeeper quarantine on a freshly downloaded binary (macOS).
    if (os === "darwin") await deps.clearQuarantine(tmp);
    await deps.rename(tmp, deps.execPath);
  } catch (err) {
    await deps.rm(tmp).catch(() => {});
    const { message, code } = classifyReplaceError(deps, err);
    deps.error(message);
    return code;
  }
  // The binary that just landed carries its own embedded SKILL.md, so the skill
  // on disk is now the previous build's. Re-run the NEW binary's installer to
  // bring them back in step – `--owned-only`, so it refreshes the folders this
  // machine already has and never creates one the user never asked for.
  //
  // Outside the try above on purpose: that catch classifies REPLACE failures,
  // and a spawn problem is not one. Best-effort, and after the swap is already
  // durable – a skill that fails to refresh must never turn a completed binary
  // swap into a failed update. The next update tries again.
  try {
    await deps.spawnSkillInstall?.(deps.execPath);
  } catch {
    /* Swap already succeeded; the skill refreshes on the next update. */
  }
  deps.log(
    `Updated ${deps.flavor} from ring ${ring} → ${deps.execPath}. Run \`${deps.flavor} version\` to confirm.`,
  );
  return EXIT.OK;
}

/** Resolved fetch target, or a terminal exit code when this install can't
 *  self-update (from source, no recorded ring, Windows, unsupported platform). */
type Preflight =
  | number
  | { base: string; ring: string; asset: string; os: "darwin" | "linux" };

/** Vet the running install before any network call: it must know which ring it
 *  follows, and it must be replaceable in place (the guards the install script
 *  applies — platform support; a `.exe` can't be swapped while it runs). */
async function preflight(deps: UpdateDeps): Promise<Preflight> {
  // From source there is nothing to fetch from and nothing meaningful to replace,
  // so no ring is recorded and none is needed. Gate on the exec-path signal
  // first: under `bun run src/index.ts` the later rename would target
  // `process.execPath` (the Bun runtime), and a stray `WEGO_BUILD_VERSION` in the
  // environment can make `version` non-dev, so version alone is unsafe.
  if (deps.fromSource || deps.version === DEV_VERSION) {
    deps.log(
      `Self-update applies to installed release binaries (running from source – use \`git pull\`). Reinstall the latest with:\n  ${reinstallHint(deps)}`,
    );
    return EXIT.OK;
  }
  // The ring the INSTALLER recorded decides where the bytes come from. Absent,
  // unreadable or malformed all refuse: `update` replaces the running binary on a
  // checksum difference alone, so a guessed pointer is a guessed payload.
  const followed = followRecordedRing({
    record: await deps.readInstallRecord(),
    recordPath: deps.installRecordPath,
    reinstallHint: reinstallHint(deps),
    movedFrom: deps.legacyScopeDir,
  });
  if (!followed.ok) {
    deps.error(followed.message);
    return EXIT.PERMANENT;
  }
  const { base, ring } = followed;
  // Defense-in-depth: the record is a plain local file, so anyone able to write
  // it could otherwise point the download (binary + its checksums) at a
  // plaintext, attacker-controlled host. Re-assert transport before any fetch
  // (loopback http stays allowed for local dev, matching config.ts's OAuth rule).
  try {
    assertSecureUrl(base, `the recorded ${ring} install URL`);
  } catch (err) {
    deps.error(err instanceof Error ? err.message : String(err));
    return EXIT.PERMANENT;
  }
  // A running .exe can't be overwritten in place on Windows the way POSIX allows;
  // point the user at the manual download, as the installer already does.
  if (deps.platform === "win32") {
    const winAsset = `${deps.flavor}-windows-x64.exe`;
    deps.log(
      `Self-update isn't supported on Windows. Download ${ringAssetUrl(base, winAsset, ring)} and replace ${deps.execPath}.`,
    );
    return EXIT.OK;
  }
  const target = assetOsArch(deps);
  if (!target) {
    deps.error(
      `unsupported platform ${deps.platform}/${deps.arch} – no matching release binary`,
    );
    return EXIT.ERROR;
  }
  return {
    base,
    ring,
    asset: `${deps.flavor}-${target.os}-${target.arch}`,
    os: target.os,
  };
}

/**
 * Fetch the ring's signed build record and decide whether it vouches for these
 * manifest bytes. Returns a stderr-ready refusal, or `null` when the manifest may
 * be trusted (foundations#74 rung 9).
 *
 * Fail-closed on every branch, including an ABSENT record. That is deliberate and
 * it is the one decision here worth defending: treating "no record" as "not signed
 * yet, carry on" would hand any store writer a downgrade — delete the record, and
 * verification turns itself off. It costs nothing in practice, because a binary
 * that contains this code can only have been built by the workflow that publishes
 * the record: there is no install in the field that would start refusing.
 *
 * The record is fetched from the ring's `cli-sig/` prefix through the same
 * first-party `?dl=` endpoint the binary already uses, so the release store's
 * hostname stays server-side here too.
 */
/**
 * A refusal, plus the error that CAUSED it when the cause was transport rather
 * than a verdict.
 *
 * Both outcomes refuse — fail-closed is the whole point — but they are not the same
 * event, and `EXIT.PERMANENT` for both told a caller that a timeout on the record
 * URL is as final as a forged record. `src/error-report.ts` owns a stable exit-code
 * taxonomy precisely so a wrapper can retry the temporary and stop on the permanent.
 */
interface RecordRefusal {
  reason: string;
  /**
   * Set only when the record could not be READ because the host was not reached —
   * a DNS/connect/reset failure or the deadline firing. Deliberately NOT set for an
   * HTTP status: a `404` on the record URL means this ring carries no record, which
   * is the permanent, fail-closed case this rung exists for, not a blip to retry.
   */
  unreachable?: unknown;
}

async function verifyRingManifest(
  deps: UpdateDeps,
  base: string,
  ring: string,
  manifest: Uint8Array<ArrayBuffer>,
): Promise<RecordRefusal | null> {
  const recordUrl = ringRecordUrl(base, SIGNATURE_ASSET, ring);
  let body: string;
  try {
    body = await (await fetchOk(deps, recordUrl, SUMS_TIMEOUT_MS)).text();
  } catch (err) {
    return {
      reason:
        `could not fetch the signed build record for ring ${ring} ` +
        `(${err instanceof Error ? err.message : String(err)}) – refusing to install ` +
        "an unverified binary",
      // Only the not-reached classes; an HTTP status stays permanent.
      unreachable: exitCodeForError(err) === EXIT.TIMEOUT ? err : undefined,
    };
  }
  let bundle: unknown;
  try {
    bundle = JSON.parse(body);
  } catch {
    return {
      reason: `the signed build record for ring ${ring} is not JSON – refusing it`,
    };
  }
  const result = await verifySignedManifest({
    bundle,
    payload: manifest,
    // Which workflow is allowed to have signed THIS ring: the edge lane's records
    // are not release records, and vice versa.
    identity: identitiesForRing(ring),
    issuer: SIGNING_OIDC_ISSUER,
    rootsPem: deps.trustedRootsPem,
  });
  if (!result.ok) {
    return {
      reason: `${MANIFEST_ASSET} on ring ${ring} is not vouched for: ${result.reason}`,
    };
  }
  return null;
}

/** Fetch the checksums, decide against the running binary, confirm, and apply. */
async function runUpdate(
  deps: UpdateDeps,
  opts: UpdateOptions,
  base: string,
  ring: string,
  asset: string,
  os: "darwin" | "linux",
): Promise<number> {
  const sumsUrl = ringAssetUrl(base, MANIFEST_ASSET, ring);
  let expected: string | null;
  let currentHash: string;
  try {
    const sumsBytes = new Uint8Array(
      await (await fetchOk(deps, sumsUrl, SUMS_TIMEOUT_MS)).arrayBuffer(),
    );
    // VERIFY BEFORE TRUSTING. Everything below this point treats the manifest as
    // authority — it decides whether to replace the running binary, and with what.
    // Fetching it over TLS proves only that the store served it, and the threat
    // this answers is someone who can WRITE that store, who would replace the
    // binary and the manifest together. So the manifest's signed build record is
    // checked first, and a manifest without a good one is not read at all.
    const refusal = await verifyRingManifest(deps, base, ring, sumsBytes);
    if (refusal) {
      deps.error(refusal.reason);
      // A record that fails VERIFICATION - or is absent, or unreadable - is
      // permanent. Only a host we never reached is temporary, and it keeps the
      // taxonomy's own code so a wrapper can retry it. Refusing is not in question
      // either way; only the exit code differs.
      return refusal.unreachable === undefined
        ? EXIT.PERMANENT
        : exitCodeForError(refusal.unreachable);
    }
    const sums = new TextDecoder().decode(sumsBytes);
    expected = expectedSum(sums, asset);
    currentHash = await deps.hashFile(deps.execPath);
  } catch (err) {
    deps.error(
      `could not check for updates: ${err instanceof Error ? err.message : String(err)}`,
    );
    return exitCodeForError(err);
  }
  // Fail-closed: an absent sums line means we can't verify the download, so we
  // refuse rather than install something unverified.
  if (!expected) {
    deps.error(
      `${asset} is not listed in ${sumsUrl} – refusing to install an unverified binary`,
    );
    return EXIT.PERMANENT;
  }

  const upToDate = currentHash === expected;
  if (opts.check) {
    deps.log(
      upToDate
        ? `Already up to date (${deps.version}, ring ${ring}).`
        : `An update is available on ring ${ring}. Run the command without --check to install it.`,
    );
    return EXIT.OK;
  }
  if (upToDate && !opts.force) {
    deps.log(`Already up to date (${deps.version}, ring ${ring}).`);
    return EXIT.OK;
  }
  if (!opts.yes) {
    const ok = await deps.confirm(
      `Update ${deps.flavor} from ring ${ring} now? This replaces ${deps.execPath}.`,
    );
    if (!ok) {
      deps.log("Skipped.");
      return EXIT.OK;
    }
  }
  return downloadAndReplace(deps, base, ring, asset, expected, os);
}

/** `wego update [--check] [-y] [--force]`. */
export async function update(
  args: string[],
  deps: UpdateDeps,
): Promise<number> {
  if (isHelpArg(args)) {
    deps.log(UPDATE_USAGE);
    return EXIT.OK;
  }
  let opts: UpdateOptions;
  try {
    opts = parseUpdateArgs(args);
  } catch (err) {
    deps.error(err instanceof Error ? err.message : String(err));
    return EXIT.USAGE;
  }
  const pre = await preflight(deps);
  if (typeof pre === "number") return pre;
  return runUpdate(deps, opts, pre.base, pre.ring, pre.asset, pre.os);
}
