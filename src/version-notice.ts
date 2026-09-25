import { USER_AGENT } from "./api";
import {
  type InstallRecord,
  ringAssetUrl,
  stripTrailingSlashes,
} from "./ring-follow";

/**
 * "A newer release exists" notice, read from the ring's `VERSION` object.
 *
 * `wego update --check` compares checksums (`update.ts`) and cannot name the newer
 * version, and users rarely run it, so installs drifted silently. The release
 * writes a small `VERSION` object next to `SHA256SUMS.txt`; this module reads it
 * and hands the caller one stderr line.
 *
 * Constraints, because this runs after every command:
 *  - Throttled to once a day.
 *  - stdout is untouched: it is a JSON contract for agents, so the message is
 *    returned and the caller puts it on stderr. The exit code never changes.
 *  - Fail-safe: an unparseable version on either side, a timeout or a 5xx
 *    produces no notice, never a guess and never an error.
 *  - `WEGO_CLI_NO_UPDATE_NOTICE` turns it off, for CI images, containers and
 *    harnesses that must not write into `$HOME` or reach the network.
 *
 * The decision is returned as a union so every guard is testable on a path that
 * otherwise has no visible symptom.
 */

/** Unset, empty, `0` and `false` mean "not opted out"; any other value opts out.
 *  Also used by `index.ts` for `WEGO_CLI_NO_SESSION`. */
export function isOptedOut(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v !== undefined && v !== "" && v !== "0" && v !== "false";
}

/** Matches `index.ts`'s `VERSION` fallback. */
const DEV_VERSION = "0.0.0-dev";

export const NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Two seconds rather than `update`'s 30s: this is added latency on someone
 *  else's command, and giving up only costs a skipped notice. */
export const NOTICE_FETCH_TIMEOUT_MS = 2000;

/** A deadline bounds time, not bytes, so a mis-pointed base (a 95 MB binary)
 *  would otherwise be buffered into the hot path. A semver string plus a newline
 *  is well under this. */
export const MAX_VERSION_BYTES = 64;

/**
 * Commands that must never carry the notice:
 *  - `update`: the running process's version is stale relative to the binary it
 *    just wrote, so it would nag on the run that fixed the problem.
 *  - `uninstall`: the user just removed the software.
 *  - `skill`: `skill list` and `skill path` are documented offline and auth-free,
 *    and `skill install` is the installer's last step, so a fresh install would
 *    otherwise print an upgrade notice seconds after installing.
 */
const SELF_MANAGEMENT_COMMANDS = new Set(["update", "uninstall", "skill"]);

export function isSelfManagementCommand(command: string | undefined): boolean {
  return command !== undefined && SELF_MANAGEMENT_COMMANDS.has(command);
}

// ---------------------------------------------------------------------------
// Version precedence (semver §11)
// ---------------------------------------------------------------------------

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers; numeric ones already coerced. */
  pre: readonly (string | number)[];
}

// Build metadata is captured and discarded: it is explicitly excluded from
// precedence, so `0.4.3+a` and `0.4.3+b` must compare equal.
const SEMVER =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Null for a leading zero (semver-invalid) or more than 9 digits (where
 *  `Number()` starts losing precision). The caller turns null into no notice. */
function numericId(raw: string): number | null {
  if (raw.length > 1 && raw.startsWith("0")) return null;
  if (raw.length > 9) return null;
  return Number(raw);
}

export function parseSemver(raw: string): Semver | null {
  const match = SEMVER.exec(raw.trim());
  if (!match) return null;
  const [major, minor, patch] = [match[1], match[2], match[3]].map(numericId);
  if (major === null || minor === null || patch === null) return null;
  const pre: (string | number)[] = [];
  for (const id of match[4] === undefined ? [] : match[4].split(".")) {
    if (id === "") return null; // `1.0.0-` or `1.0.0-a..b`
    if (!/^\d+$/.test(id)) {
      pre.push(id);
      continue;
    }
    const n = numericId(id);
    if (n === null) return null; // `rc.01`
    pre.push(n);
  }
  return { major, minor, patch, pre };
}

/** Semver §11.4.1–3: numeric identifiers compare numerically, alphanumeric ones by
 *  ASCII, and a numeric identifier always ranks below an alphanumeric one. */
function compareId(x: string | number, y: string | number): number {
  if (x === y) return 0;
  const xNum = typeof x === "number";
  if (xNum !== (typeof y === "number")) return xNum ? -1 : 1;
  return x < y ? -1 : 1;
}

/** Semver §11.4: a version without a prerelease outranks one with; otherwise the
 *  identifiers compare field by field, and on an equal prefix the longer set wins. */
function comparePre(
  a: readonly (string | number)[],
  b: readonly (string | number)[],
): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const cmp = compareId(a[i], b[i]);
    if (cmp !== 0) return cmp;
  }
  return a.length - b.length;
}

export function compareSemver(a: Semver, b: Semver): number {
  return (
    a.major - b.major ||
    a.minor - b.minor ||
    a.patch - b.patch ||
    comparePre(a.pre, b.pre)
  );
}

/**
 * True only when both sides parse and `remote` is strictly greater. Unparseable
 * input never becomes a guess. Used to choose the wording, not whether to notify
 * (see `shouldNotify`).
 */
export function isNewerVersion(remote: string, current: string): boolean {
  const [r, c] = [parseSemver(remote), parseSemver(current)];
  return r !== null && c !== null && compareSemver(r, c) > 0;
}

/** Version-shaped, a weaker test than `parseSemver`.
 *
 *  The gate on a fetched body exists to reject a captive-portal page or a proxy
 *  error, not to judge semver legality. `X.Y.Z-edge.0123456` is a real build the
 *  ring serves, but semver §9 forbids a leading zero on a numeric identifier, so
 *  `parseSemver` rejects it. Strict parsing would permanently silence the notice
 *  for any edge build whose sha is all digits with a leading zero. */
export function looksLikeVersion(raw: string): boolean {
  return SEMVER.test(raw.trim());
}

/**
 * Different, not greater: the same question `update` asks when it compares
 * checksums, so the notice and the command agree on whether there is anything
 * to do.
 *
 * Ordering fails both ways. Semver orders prerelease identifiers lexically and a
 * git sha has no chronological order, so `0.7.2-edge.4aeec3a2f` can succeed
 * `0.7.2-edge.e30454f2a` and still sort below it. And a rollback is a deliberate
 * move to get people off a build: `update` follows bytes in both directions, so
 * a user whose ring moved backwards still has something to do and must be told
 * (when `cli/stable` was rolled back from 1.2.0 to 1.1.0, a greater-than rule
 * told nobody).
 *
 * Not claiming a downgrade is new is a wording concern, handled by the caller
 * choosing `formatChannelChangedNotice` whenever `isNewerVersion` is false.
 *
 * Unparseable on either side is no notice, never a guess.
 */
export function shouldNotify(latest: string, current: string): boolean {
  const [l, c] = [latest.trim(), current.trim()];
  if (!looksLikeVersion(l) || !looksLikeVersion(c)) return false;
  return l !== c;
}

/** Pinned by a test so humans see a stable shape; an agent is told to treat its
 *  presence as the signal and never parse it.
 *
 *  `wego` names the release. `command` is what the user must type, the name the
 *  binary was invoked as: an install renamed by `WEGO_CLI_BIN` would otherwise be
 *  told to run a command that does not exist on its machine. */
export function formatVersionNotice(
  current: string,
  latest: string,
  command = "wego",
): string {
  return `A new wego is available: ${current} -> ${latest}. Run \`${command} update -y\`.`;
}

/** For a ring that moved but not provably forward: a prerelease, where the
 *  version strings cannot say which is newer, or a rollback (see `shouldNotify`).
 *  Claims no ordering, only that the ring serves other bytes than the ones
 *  running. */
export function formatChannelChangedNotice(
  current: string,
  latest: string,
  command = "wego",
): string {
  return `Your wego channel now serves ${latest} (you have ${current}). Run \`${command} update -y\`.`;
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/** Why the notice did or did not reach the channel.
 *
 *  Only `checked` can carry a message, and only when the read succeeded. Every
 *  other outcome is silent because nothing was asked, and this file says nothing
 *  it has not just been told. A stored answer is not reused: it is half of a
 *  comparison whose other half, the running version, changes on every update and
 *  reinstall without this file seeing it (wego/cli#33, #35). */
export type NoticeOutcome =
  | "skipped-explicit-command"
  | "skipped-from-source"
  | "skipped-no-record"
  | "skipped-opt-out"
  | "skipped-unclaimable"
  | "throttled"
  | "checked";

export interface NoticeResult {
  outcome: NoticeOutcome;
  /** Present only when the channel serves a different version. */
  message?: string;
}

/** When the channel was last asked, and deliberately not what it said (see
 *  `NoticeOutcome`). The throttle file's content is unused; its mtime is the
 *  whole record. */
export interface UpdateCheckState {
  checkedAt: number;
}

export interface VersionNoticeDeps {
  /** `process.argv[2]`, for the suppression set. */
  command: string | undefined;
  /** A runtime exec-path signal, not the env-stamped version, which a stray
   *  `WEGO_BUILD_VERSION` can spoof. */
  fromSource: boolean;
  version: string;
  /** `programName()`: the command the user has to type, which `WEGO_CLI_BIN`
   *  can make differ from `wego`. */
  invokedAs: string;
  /** The same record `update` follows. Missing, unreadable and malformed all
   *  arrive as `null`, and `null` goes quiet rather than guessing a channel
   *  (foundations#74 rung 3). A fallback URL could point at a retired prefix
   *  nothing advances and report "up to date" forever; refusing costs one
   *  sentence on a pre-record install, which `wego update` refuses anyway. */
  readInstallRecord: () => Promise<InstallRecord | null>;
  env: Record<string, string | undefined>;
  /** Wall clock, ms. */
  now: number;
  /** Null when absent or unreadable. */
  readState: () => Promise<UpdateCheckState | null>;
  /** Stamps the throttle window to now, creating the file if needed. Returns
   *  whether the stamp landed: the throttle is only real if it is durable. */
  claimWindow: () => Promise<boolean>;
  fetch: typeof fetch;
}

/**
 * Cancels the transfer as soon as the body exceeds `limit`, returning `null`,
 * which the caller treats like a transport failure. Counts bytes on the wire,
 * not UTF-16 code units. A null stream is an empty body, not a failure.
 */
async function readBounded(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<string | null> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) return null;
      chunks.push(value);
    }
  } finally {
    // Releases the connection on the over-limit path; a no-op once drained.
    await reader.cancel().catch(() => {});
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export interface NoticeChannel {
  /** `<api>/install`, from the record. */
  base: string;
  ring: string;
}

/**
 * The installer's record is the only source, the same one `update` follows
 * (`ring-follow.ts`), so the two cannot disagree about which ring an install is
 * on. `null` without a record; see `readInstallRecord` for why there is no
 * fallback.
 */
export function noticeChannel(
  record: InstallRecord | null,
): NoticeChannel | null {
  if (!record) return null;
  // `stripTrailingSlashes`, not `/\/+$/`: SonarQube flags that regex as
  // `typescript:S5852` (super-linear backtracking) on every URL string in this
  // repo, and `ring-follow.ts` already owns the loop that answers it.
  return { base: stripTrailingSlashes(record.installUrl), ring: record.ring };
}

/** The same ring-qualified `?dl=` form `update` uses, so both resolve one pointer
 *  through one first-party host. */
function versionUrl(channel: NoticeChannel): string {
  return ringAssetUrl(channel.base, "VERSION", channel.ring);
}

/**
 * `null` for every way of not knowing: a transport failure, any non-2xx, an
 * oversized body, or a `200` whose body is not version-shaped.
 */
async function readChannelVersion(
  deps: VersionNoticeDeps,
  channel: NoticeChannel,
): Promise<string | null> {
  try {
    const res = await deps.fetch(versionUrl(channel), {
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(NOTICE_FETCH_TIMEOUT_MS),
    });
    // Includes the `404` of a tag or ring that never published `VERSION`, and the
    // `403` of an edge rule on a public store.
    if (!res.ok) return null;
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_VERSION_BYTES) return null;
    // Chunked responses declare no length, so the cap has to apply while reading:
    // `res.text()` buffers the whole object first, and a CDN delivers tens of
    // megabytes well inside the 2s deadline.
    const body = await readBounded(res.body, MAX_VERSION_BYTES);
    if (body === null) return null;
    const trimmed = body.trim();
    // Rejects a `200` carrying a captive-portal page, a proxy error or an empty
    // body. Shape rather than `parseSemver`: see `looksLikeVersion`.
    return looksLikeVersion(trimmed) ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Reads the channel at most once per window. Never throws, never writes to a
 * stream.
 */
export async function maybeNotifyNewVersion(
  deps: VersionNoticeDeps,
): Promise<NoticeResult> {
  if (isSelfManagementCommand(deps.command)) {
    return { outcome: "skipped-explicit-command" };
  }
  // Both checks, as in `update.ts`: a locally compiled binary without
  // `RELEASE_TAG` passes the exec-path test and would otherwise nag
  // `0.0.0-dev -> …` forever.
  if (deps.fromSource || deps.version === DEV_VERSION) {
    return { outcome: "skipped-from-source" };
  }
  // Before the record read, so an opted-out run skips the file read.
  if (isOptedOut(deps.env.WEGO_CLI_NO_UPDATE_NOTICE)) {
    return { outcome: "skipped-opt-out" };
  }
  const record = await deps.readInstallRecord().catch(() => null);
  const channel = noticeChannel(record);
  if (!channel) return { outcome: "skipped-no-record" };

  const state = await deps.readState();
  const result = (
    latest: string | undefined,
    outcome: NoticeOutcome,
  ): NoticeResult => {
    if (!latest || !shouldNotify(latest, deps.version)) return { outcome };
    // "New" only when the ordering is real; otherwise all that is known is that
    // the versions differ (`shouldNotify`).
    const message = isNewerVersion(latest, deps.version)
      ? formatVersionNotice(deps.version, latest, deps.invokedAs)
      : formatChannelChangedNotice(deps.version, latest, deps.invokedAs);
    return { outcome, message };
  };

  // A stamp in the future (clock set backwards, or a bad write) must not throttle
  // forever, so only a non-negative age inside the window counts as fresh.
  const age = state ? deps.now - state.checkedAt : Number.POSITIVE_INFINITY;
  if (age >= 0 && age < NOTICE_INTERVAL_MS) return { outcome: "throttled" };

  // Claim the window before the fetch, and only proceed if the claim landed.
  // Otherwise an unwritable state file (read-only `$HOME`) makes every command
  // pay the full fetch deadline.
  if (!(await deps.claimWindow())) return { outcome: "skipped-unclaimable" };

  const fresh = await readChannelVersion(deps, channel);
  if (fresh === null) return { outcome: "checked" };
  return result(fresh, "checked");
}
