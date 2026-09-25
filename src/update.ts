import { USER_AGENT } from "./api";
import { isHelpArg } from "./commands";
import { assertSecureUrl } from "./config";
import { EXIT, exitCodeForError } from "./error-report";
import {
  identitiesForRing,
  MANIFEST_ASSET,
  SIGNATURE_ASSET,
  SIGNING_OIDC_ISSUER,
  type VerifyFailure,
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
 * `wego update`: replace the installed binary in place with the latest release
 * from its own ring.
 *
 * Releases are single-file binaries named `wego-<os>-<arch>` in a public Vercel
 * Blob store under a ring pointer (`cli/edge`, `cli/next`, `cli/stable`), with a
 * per-ring `SHA256SUMS.txt`. This mirrors the `curl … | bash` installer
 * (`apps/api` `renderInstallScript`): detect the platform, fetch the checksums,
 * compare against the running binary, download, verify fail-closed, then
 * atomically swap `process.execPath`.
 *
 * The ring comes from the install record the installer wrote
 * (`~/.config/<scope>/install.json`, see `ring-follow.ts`), never from a URL baked
 * into the binary. Self-update compares checksums rather than versions, so the
 * ring pointer is the whole policy and must be a fact on the machine rather than
 * a build argument (foundations#74 rung 3). Assets are fetched through the
 * recorded endpoint's `?dl=` branch so the release store stays server-side. No
 * record means refusal, not a guessed ring. A from-source run gets a reinstall
 * hint instead, since there is no installed binary to replace.
 */

/** Matches `index.ts`'s `VERSION` fallback. */
const DEV_VERSION = "0.0.0-dev";

export interface UpdateIo {
  log: (message: string) => void;
  error: (message: string) => void;
}

export interface UpdateDeps extends UpdateIo {
  /** `0.0.0-dev` from source. */
  version: string;
  /** A runtime exec-path signal, not the env-stamped version, which a stray
   *  `WEGO_BUILD_VERSION` can spoof. When true, self-update refuses: `execPath`
   *  is the Bun/Node runtime, not an installed binary. */
  fromSource: boolean;
  /** `null` when the record is missing, unreadable or malformed
   *  (`ring-follow.ts` folds all three together); each one refuses. */
  readInstallRecord: () => Promise<InstallRecord | null>;
  /** Named in the refusal so the user can see what is missing. */
  installRecordPath: string;
  /** `<apiBase>/install` for the reinstall hint; undefined when unbaked. */
  installUrl?: string;
  platform: NodeJS.Platform;
  arch: string;
  execPath: string;
  fetch: typeof fetch;
  gunzip: (data: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>;
  /** Lowercase hex sha256 of the file at `path`. */
  hashFile: (path: string) => Promise<string>;
  writeFile: (path: string, data: Uint8Array) => Promise<void>;
  chmod: (path: string, mode: number) => Promise<void>;
  /** Must be atomic. */
  rename: (from: string, to: string) => Promise<void>;
  /** Best-effort remove (force). */
  rm: (path: string) => Promise<void>;
  /** Best-effort clear the macOS `com.apple.quarantine` xattr; no-op elsewhere. */
  clearQuarantine: (path: string) => Promise<void>;
  /** Bypassed by `-y`. */
  confirm: (question: string) => Promise<boolean>;
  /** A per-run-unique sibling of `execPath` on the same filesystem, so the final
   *  rename stays atomic and two concurrent runs cannot collide on one
   *  predictable name (a post-verify swap TOCTOU). */
  tempPath: string;
  /** Best-effort remove stale temp siblings an interrupted run left behind. */
  sweepTemps: () => Promise<void>;
  /** The Sigstore roots a signed build record must chain to (foundations#74 rung
   *  9). Injected so a test can pin its own throwaway root; no flag or env var
   *  reaches it. */
  trustedRootsPem: string;
  /** Runs the freshly swapped binary's own `skill install --owned-only`. When
   *  absent the step is skipped, which hand-built unit test deps rely on. */
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

/** Throws a usage `Error` on an unknown flag or a stray positional. */
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

function assetOsArch(
  deps: UpdateDeps,
): { os: "darwin" | "linux"; arch: "arm64" | "x64" } | null {
  const os = OS_BY_PLATFORM[deps.platform];
  const arch = ARCH_BY_NODE_ARCH[deps.arch];
  return os && arch ? { os, arch } : null;
}

/** Parses `<hash>␠␠<name>` lines as `sha256sum` writes them. */
function expectedSum(sums: string, asset: string): string | null {
  for (const line of sums.split("\n")) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (match && match[2].trim() === asset) return match[1].toLowerCase();
  }
  return null;
}

// Mirrors the install script's `curl --connect-timeout 15 --max-time 600`: a
// short deadline for the small checksums read, a long one for the 60–95 MB
// binary. Without a deadline a stalled blob would hang the update forever (a
// `TimeoutError` maps to the timeout/network exit class).
const SUMS_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 600_000;

/** Throws on a non-2xx so the caller's catch maps it to an exit class. */
async function fetchOk(
  deps: UpdateDeps,
  url: string,
  timeoutMs: number,
): Promise<Response> {
  const res = await deps.fetch(url, {
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`failed to fetch ${url} (HTTP ${res.status})`);
  return res;
}

/** Split out to keep the errno branches out of `downloadAndReplace`'s
 *  complexity budget. */
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
      message:
        "not enough disk space to download the new wego binary. Free up space and retry.",
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

/** Prefers the gzipped asset (issue #1235): it is ~2.7× smaller (63.8 → 24.0 MB)
 *  and the download is the whole update cost. Falls back to the raw asset only on
 *  HTTP 404, which is what a ring frozen from a pre-#1235 tag returns. A gz that
 *  is present but malformed, or any other error, throws instead of retrying the
 *  raw asset, so a tampered archive cannot degrade into a different download.
 *  The caller's hash check against the raw checksum means the gz is never
 *  trusted beyond decompression. */
async function fetchNewBinary(
  deps: UpdateDeps,
  base: string,
  ring: string,
  asset: string,
): Promise<Uint8Array> {
  const gzUrl = ringAssetUrl(base, `${asset}.gz`, ring);
  const gz = await deps.fetch(gzUrl, {
    headers: { "user-agent": USER_AGENT },
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

/** Returns an exit code; leaves no partial file behind. */
async function downloadAndReplace(
  deps: UpdateDeps,
  base: string,
  ring: string,
  asset: string,
  expected: string,
  os: "darwin" | "linux",
): Promise<number> {
  const tmp = deps.tempPath;
  await deps.sweepTemps();
  try {
    await deps.writeFile(tmp, await fetchNewBinary(deps, base, ring, asset));
    const got = await deps.hashFile(tmp);
    if (got !== expected) {
      // A failed `rm` must not fall into the catch and swallow the "refusing to
      // install" message and its stable exit code.
      await deps.rm(tmp).catch(() => {});
      deps.error(
        `checksum mismatch for ${asset} (expected ${expected}, got ${got}) – refusing to install`,
      );
      return EXIT.PERMANENT;
    }
    await deps.chmod(tmp, 0o755);
    if (os === "darwin") await deps.clearQuarantine(tmp);
    await deps.rename(tmp, deps.execPath);
  } catch (err) {
    await deps.rm(tmp).catch(() => {});
    const { message, code } = classifyReplaceError(deps, err);
    deps.error(message);
    return code;
  }
  // The new binary embeds its own SKILL.md, so the skill on disk is now the
  // previous build's. Re-run the new binary's installer with `--owned-only` so it
  // refreshes the folders this machine already has and creates none.
  //
  // Outside the try above because that catch classifies replace failures. This
  // is best-effort: a skill that fails to refresh must not turn a completed swap
  // into a failed update. The next update tries again.
  try {
    await deps.spawnSkillInstall?.(deps.execPath);
  } catch {
    /* Swap already succeeded; the skill refreshes on the next update. */
  }
  deps.log(
    `Updated wego from ring ${ring} → ${deps.execPath}. Run \`wego version\` to confirm.`,
  );
  return EXIT.OK;
}

/** A number is a terminal exit code: this install cannot self-update. */
type Preflight =
  | number
  | { base: string; ring: string; asset: string; os: "darwin" | "linux" };

/** Runs before any network call: the install must know which ring it follows
 *  and be replaceable in place (the install script's guards: platform support,
 *  and a `.exe` cannot be swapped while it runs). */
async function preflight(deps: UpdateDeps): Promise<Preflight> {
  // Gate on the exec-path signal first: under `bun run src/index.ts` the rename
  // would target the Bun runtime, and a stray `WEGO_BUILD_VERSION` can make
  // `version` non-dev, so version alone is unsafe.
  if (deps.fromSource || deps.version === DEV_VERSION) {
    deps.log(
      `Self-update applies to installed release binaries (running from source – use \`git pull\`). Reinstall the latest with:\n  ${reinstallHint(deps)}`,
    );
    return EXIT.OK;
  }
  // A missing, unreadable or malformed record refuses: `update` replaces the
  // binary on a checksum difference alone, so a guessed ring is a guessed payload.
  const followed = followRecordedRing({
    record: await deps.readInstallRecord(),
    recordPath: deps.installRecordPath,
    reinstallHint: reinstallHint(deps),
  });
  if (!followed.ok) {
    deps.error(followed.message);
    return EXIT.PERMANENT;
  }
  const { base, ring } = followed;
  // Defense in depth: the record is a plain local file, so anyone able to write
  // it could point the binary and its checksums at a plaintext, attacker-
  // controlled host. Loopback http stays allowed for local dev, matching
  // config.ts's OAuth rule.
  try {
    assertSecureUrl(base, `the recorded ${ring} install URL`);
  } catch (err) {
    deps.error(err instanceof Error ? err.message : String(err));
    return EXIT.PERMANENT;
  }
  // Windows cannot overwrite a running .exe in place; point at the manual
  // download, as the installer does.
  if (deps.platform === "win32") {
    const winAsset = "wego-windows-x64.exe";
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
    asset: `wego-${target.os}-${target.arch}`,
    os: target.os,
  };
}

/**
 * A refusal, plus the error that caused it when the cause was transport rather
 * than a verdict. Both refuse, but a timeout on the record URL is not as final as
 * a forged record, and `src/error-report.ts` keeps a stable exit-code taxonomy so
 * a wrapper can retry the temporary and stop on the permanent.
 */
interface RecordRefusal {
  reason: string;
  /**
   * Set only when the host was not reached (DNS, connect, reset, or the deadline).
   * Not set for an HTTP status: a `404` on the record URL means this ring carries
   * no record, which is the permanent fail-closed case, not a blip to retry.
   */
  unreachable?: unknown;
  /** Why verification refused, when it got that far. Absent on a fetch failure,
   *  which `unreachable` classifies. */
  kind?: VerifyFailure;
}

/**
 * Returns a stderr-ready refusal, or `null` when the ring's signed build record
 * vouches for these manifest bytes (foundations#74 rung 9).
 *
 * Fail-closed on every branch, including an absent record. Treating "no record"
 * as "not signed yet" would hand any store writer a downgrade: delete the record
 * and verification turns itself off. It costs nothing in practice, because a
 * binary containing this code can only have been built by the workflow that
 * publishes the record.
 *
 * The record is fetched from the ring's `cli-sig/` prefix through the same
 * first-party `?dl=` endpoint, so the release store's hostname stays server-side.
 */
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
    // The edge lane's records are not release records, and vice versa.
    identity: identitiesForRing(ring),
    issuer: SIGNING_OIDC_ISSUER,
    rootsPem: deps.trustedRootsPem,
  });
  if (!result.ok) {
    return {
      kind: result.kind,
      reason: `${MANIFEST_ASSET} on ring ${ring} is not vouched for: ${result.reason}`,
    };
  }
  return null;
}

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
    // Verify before trusting: everything below treats the manifest as authority
    // over whether and with what to replace the binary. TLS proves only that the
    // store served it, and the threat is someone who can write that store and
    // would replace the binary and manifest together. So a manifest without a
    // good signed build record is not read at all.
    const refusal = await verifyRingManifest(deps, base, ring, sumsBytes);
    if (refusal) {
      // Every branch refuses; they differ in the exit code a wrapper branches on
      // and the advice a person reads.
      //
      //  unreachable  the host was never reached. Keeps the taxonomy's code so a
      //               caller retries, with no advice: a network blip is no
      //               reason to touch the install.
      //  inconsistent the record and manifest disagree. A ring mid-promote does
      //               this (the publisher writes the two separately and a cache
      //               can straddle them), so it clears on its own. RETRYABLE,
      //               not PERMANENT, so a wrapper keeps retrying.
      //  identity     the ring serves a record this binary's trust set can never
      //               accept. The only class reinstalling fixes, since a newer
      //               build carries a different trust set. Without this advice
      //               every 1.2.0 and 1.2.1 install was stranded (wego/cli#29).
      //  invalid      not a Fulcio record at all. Permanent, and reinstalling
      //               does not help, so it gets the reason and no advice.
      if (refusal.unreachable !== undefined) {
        deps.error(refusal.reason);
        return exitCodeForError(refusal.unreachable);
      }
      if (refusal.kind === "inconsistent") {
        deps.error(
          `${refusal.reason}\nThe ${ring} channel may be mid-update: its manifest and its signed record do not yet agree. Nothing was installed. Try again in a minute.`,
        );
        return EXIT.RETRYABLE;
      }
      deps.error(
        refusal.kind === "identity"
          ? `${refusal.reason}\nThis binary cannot install what ring ${ring} is serving, and retrying will not change that. Reinstall the latest with:\n  ${reinstallHint(deps)}`
          : refusal.reason,
      );
      return EXIT.PERMANENT;
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
  // Fail-closed: without a sums line the download cannot be verified.
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
      `Update wego from ring ${ring} now? This replaces ${deps.execPath}.`,
    );
    if (!ok) {
      deps.log("Skipped.");
      return EXIT.OK;
    }
  }
  return downloadAndReplace(deps, base, ring, asset, expected, os);
}

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
