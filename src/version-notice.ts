import { USER_AGENT } from "./api";
import {
  type InstallRecord,
  ringAssetUrl,
  stripTrailingSlashes,
} from "./ring-follow";

/**
 * Proactive "a newer release exists" notice — the pull side of the release
 * channel's `VERSION` object.
 *
 * Until now an installed binary only learned about a new release if the user
 * thought to run `wego update --check`, so installs drifted silently. That check
 * is also checksum-based (`update.ts`): it hashes the running 60–95 MB binary and
 * cannot name the newer version, because the channel published no version string.
 * The release now writes a tiny `VERSION` object next to `SHA256SUMS.txt`, and
 * this module reads it in the background and hands the caller one stderr line.
 *
 * Deliberate constraints, because this runs after every command:
 *  - **Throttled**, per flavor: `wegostaging` hourly (its channel carries the
 *    prerelease line), `wego` daily (stable tags only).
 *  - **Persist, then nag.** The channel's answer is stored, so the notice keeps
 *    printing on every command until the user updates — with no further network
 *    calls. A once-per-window notice is trivially missed, and the whole point is
 *    that the user cannot miss it.
 *  - **stdout is untouched.** It is a JSON contract for the agent funnels, so the
 *    message is RETURNED, never written, and the caller puts it on stderr. The
 *    exit code never changes.
 *  - **Fail-safe, never fail-loud.** An unparseable version on either side, a
 *    timeout, or a 5xx produces no notice — never a guess and never an error.
 *  - **Escapable** via `WEGO_CLI_NO_UPDATE_NOTICE`, for CI images, containers,
 *    and harnesses that must not write into `$HOME` or reach the network.
 *
 * Written against injected deps (like `skill-refresh.ts`) and returning its
 * decision as a union, so every guard is testable on a path that otherwise has no
 * symptom at all.
 */

/** Whether an opt-out env var is set to anything meaning "yes". Unset, empty,
 *  `0` and `false` all mean "not opted out"; any other value opts out.
 *
 *  Lived in `skill-refresh.ts` in wego-ai, which used it for the background
 *  refresh's kill switch. That module went with the skill channel; this module
 *  (`WEGO_CLI_NO_UPDATE_NOTICE`) and `index.ts` (`WEGO_CLI_NO_SESSION`) are its
 *  remaining callers, so it lives here rather than in a module of its own. */
export function isOptedOut(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v !== undefined && v !== "" && v !== "0" && v !== "false";
}

/** The from-source version stamp (matches `index.ts`'s `VERSION` fallback). */
const DEV_VERSION = "0.0.0-dev";

/** The staging build flavor. Its channel carries the prerelease line, which moves
 *  far more often than prod's, so a tester can be a day behind on a 24h window. */
const STAGING_FLAVOR = "wegostaging";

export const NOTICE_INTERVAL_PROD_MS = 24 * 60 * 60 * 1000;
export const NOTICE_INTERVAL_STAGING_MS = 60 * 60 * 1000;

/** How long a stored answer is trusted before the channel is read again. */
export function noticeIntervalMs(flavor: string): number {
  return flavor === STAGING_FLAVOR
    ? NOTICE_INTERVAL_STAGING_MS
    : NOTICE_INTERVAL_PROD_MS;
}

/** Per-request deadline for the channel read. Two seconds, matching the
 *  background skill refresh's tightened budget rather than `update`'s 30s: this is
 *  pure added latency on someone else's command, and giving up costs a skipped
 *  notice, nothing more. */
export const NOTICE_FETCH_TIMEOUT_MS = 2000;

/** Longest `VERSION` body worth reading. A deadline bounds *time*, not *bytes*, so
 *  a mis-pointed channel base (a 95 MB binary object) would otherwise be buffered
 *  into the hot path. A semver string plus a newline is well under this. */
export const MAX_VERSION_BYTES = 64;

/**
 * Commands that must never carry the notice:
 *  - `update` — the running process's baked version is stale relative to the
 *    binary it just wrote, so it would nag on the very run that fixed the problem.
 *  - `uninstall` — telling a user to upgrade software they just removed.
 *  - `skill` — `skill list` / `skill path` are documented offline and auth-free,
 *    the same reason the background skill refresh skips them.
 * `skill install` is also the `curl … | bash` installer's last step, so without it
 * a fresh install could print an upgrade notice seconds after installing.
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

/** A numeric identifier, or null when it isn't a legal one. Leading zeros are
 *  semver-invalid, and past ~9 digits `Number()` starts losing precision — both
 *  mean "don't guess", which the caller turns into "no notice". */
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
 *  ASCII, and a numeric identifier always ranks BELOW an alphanumeric one. */
function compareId(x: string | number, y: string | number): number {
  if (x === y) return 0;
  const xNum = typeof x === "number";
  if (xNum !== (typeof y === "number")) return xNum ? -1 : 1;
  return x < y ? -1 : 1;
}

/** Semver §11.4: a version WITHOUT a prerelease outranks one with; otherwise the
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
 * True only when both sides parse AND `remote` is *strictly* greater. The two
 * halves are what make this safe to run unattended: unparseable input never
 * becomes a guess, and "strictly greater" keeps a channel rollback (or a staging
 * binary built ahead of its channel) silent instead of advertising a downgrade.
 */
export function isNewerVersion(remote: string, current: string): boolean {
  const [r, c] = [parseSemver(remote), parseSemver(current)];
  return r !== null && c !== null && compareSemver(r, c) > 0;
}

/** Version-SHAPED, which is a weaker question than `parseSemver`'s.
 *
 *  The gate on a fetched body exists to reject a captive-portal page or a proxy
 *  error, not to adjudicate semver legality — and `X.Y.Z-edge.0123456` is a real
 *  build this channel really serves while being semver-INVALID (§9 forbids a
 *  leading zero on a numeric identifier, so `parseSemver` returns null for it).
 *  Gating the read on strict parsing therefore silences the notice permanently
 *  for whichever edge builds happen to draw an all-numeric sha with a leading
 *  zero. Shape is the property the guard actually needs. */
export function looksLikeVersion(raw: string): boolean {
  return SEMVER.test(raw.trim());
}

/**
 * Whether the channel is serving something this install should be told about.
 *
 * ONE ORACLE: *different*, not *greater*. It is the same question `update`
 * itself asks when it compares checksums rather than versions, which is what
 * makes the notice and the command agree about whether there is anything to do.
 *
 * This used to split by shape. A prerelease (`edge`'s `X.Y.Z-edge.<sha>`) was
 * compared for difference, because semver orders prerelease identifiers
 * lexically and a git sha carries no chronological order at all:
 * `0.7.2-edge.4aeec3a2f` is the SUCCESSOR of `0.7.2-edge.e30454f2a` and sorts
 * below it, so "is it greater" answers a coin flip. A plain `X.Y.Z` was compared
 * for strict ordering, so that "a rollback stays silent rather than advertising
 * a downgrade".
 *
 * THE ROLLBACK HALF OF THAT WAS WRONG, and this release is what proved it. A
 * rollback is a deliberate act to get people OFF a build, and silence defeats
 * the act: `cli/stable` was rolled back from 1.2.0 to 1.1.0 on 2026-09-14 and
 * nobody who was not already pinned to the bridge was told anything. `update`
 * follows bytes in BOTH directions - `currentHash === expected`, no ordering
 * anywhere - so a user whose channel moved under them has something to do
 * regardless of which way it moved, and the only effect of the old rule was that
 * nobody told them.
 *
 * "Advertising a downgrade" was a real concern and it is a WORDING concern, which
 * is why `formatChannelChangedNotice` already exists: it states what is known
 * (the channel serves other bytes) and claims no ordering. The caller picks it
 * whenever `isNewerVersion` is false, so a rollback now says "your channel now
 * serves 1.2.2 (you have 1.2.3)" rather than calling it new.
 *
 * Unparseable on either side is still no notice, never a guess.
 */
export function shouldNotify(latest: string, current: string): boolean {
  const [l, c] = [latest.trim(), current.trim()];
  if (!looksLikeVersion(l) || !looksLikeVersion(c)) return false;
  return l !== c;
}

/** The one stderr line. Pinned by a test so humans see a stable shape — an agent
 *  is told to treat its PRESENCE as the signal and never parse it.
 *
 *  The two names are deliberately separate. `flavor` is the RELEASE identity, so a
 *  renamed install still says which release line it is on. `command` is what the
 *  user must actually TYPE, which is the name the binary was invoked as: an
 *  install renamed by `WEGO_CLI_BIN` would otherwise be told to run a command that
 *  does not exist on its machine. They are the same string on a default install. */
export function formatVersionNotice(
  flavor: string,
  current: string,
  latest: string,
  command: string = flavor,
): string {
  return `A new ${flavor} is available: ${current} -> ${latest}. Run \`${command} update -y\`.`;
}

/** The line for a ring that MOVED without moving forward — the prerelease case,
 *  where "newer" is not a question the version strings can answer (see
 *  `shouldNotify`). Saying "a new version is available" there would claim an
 *  ordering nothing established; this says only what is known, which is that the
 *  channel is serving other bytes than the ones running. */
export function formatChannelChangedNotice(
  flavor: string,
  current: string,
  latest: string,
  command: string = flavor,
): string {
  return `Your ${flavor} channel now serves ${latest} (you have ${current}). Run \`${command} update -y\`.`;
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/** Why the notice did (or didn't) reach the channel.
 *
 *  A message accompanies exactly one of these: `checked`, and only when the read
 *  succeeded. Every other outcome is silent, because every other outcome means we
 *  did not ask — and this file says nothing it has not just been told.
 *
 *  It used to nag from a STORED answer on `throttled` and `skipped-unclaimable`
 *  too, on the reasoning that "a stale install keeps being told, for free". Free
 *  in network terms, expensive in correctness terms: the stored answer is half of
 *  a comparison whose OTHER half — the running version — changes underneath it on
 *  every update and every reinstall, and neither event is something this file can
 *  observe. Three defects in one afternoon came out of defending that position
 *  (wego/cli#33, #35). The cache is gone; only the timestamp remains. */
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
  /** The stderr line, present only when a strictly newer version is known. */
  message?: string;
}

/** What the throttle file records: WHEN we last asked, and nothing else.
 *
 *  Deliberately not the answer. The file's only job is to keep this off the
 *  network on every command; storing what the channel said would make it half of
 *  a stale comparison (see `NoticeOutcome`). The file's content is unused and its
 *  mtime is the whole record. */
export interface UpdateCheckState {
  checkedAt: number;
}

export interface VersionNoticeDeps {
  /** `process.argv[2]` — the subcommand, for the suppression set. */
  command: string | undefined;
  /** True when running from source (a runtime exec-path signal, NOT the
   *  env-stamped version which a stray `WEGO_BUILD_VERSION` can spoof). */
  fromSource: boolean;
  /** The running binary's version (matches `wego version`). */
  version: string;
  /** The baked build flavor — `wego` | `wegostaging`. Drives the cadence, the
   *  state path, and the wording, so a RENAMED binary keeps its own identity
   *  instead of following whatever name it was invoked under. */
  flavor: string;
  /** The name the binary was invoked as (`programName()`). Separate from `flavor`
   *  on purpose: the flavor names the release, this names the command the user has
   *  to type, and `WEGO_CLI_BIN` lets an install carry a different one. */
  invokedAs: string;
  /** The installer's ring record — the same one `update` follows. Absent,
   *  unreadable and malformed all arrive as `null`, and `null` REFUSES: the
   *  notice goes quiet rather than guessing a channel.
   *
   *  foundations#74 rung 3 is explicit that "a missing record refuses rather than
   *  guesses", and it is the rung that exists to make silent channel drift
   *  impossible. A baked-URL fallback is the drift: a binary baked with the
   *  retired `cli/latest` would compare against a prefix nothing advances and
   *  report "up to date" forever. The cost of refusing is one missing sentence on
   *  a pre-record install, which `wego update` already refuses for anyway. */
  readInstallRecord: () => Promise<InstallRecord | null>;
  /** Process env, read only for the `WEGO_CLI_NO_UPDATE_NOTICE` escape. */
  env: Record<string, string | undefined>;
  /** Wall clock, ms. */
  now: number;
  /** The stored answer + stamp, or null when absent or unreadable. */
  readState: () => Promise<UpdateCheckState | null>;
  /** Stamp the throttle window to now, creating the file if needed. Returns
   *  whether the stamp actually landed — the throttle is only real if it is
   *  durable (see `maybeNotifyNewVersion`). */
  claimWindow: () => Promise<boolean>;
  /** `fetch`, injectable for tests. */
  fetch: typeof fetch;
}

/**
 * Decode at most `limit` bytes of a response body, and CANCEL the transfer the
 * moment it goes over. Returns `null` for an over-limit body - the caller reads
 * that as "learned nothing", the same as a transport failure.
 *
 * Counts real bytes, not `string.length`: the limit exists to keep a mis-pointed
 * base out of memory, and UTF-16 code units are not what arrives on the socket. A
 * null stream is an EMPTY body, not a failure.
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

/** Where the notice reads `VERSION` from: the ring this install FOLLOWS, always
 *  from the installer's record. There is no second source. */
export interface NoticeChannel {
  /** `<api>/install`, from the record. */
  base: string;
  /** The recorded ring. Required: a channel without one cannot be resolved, and
   *  guessing which prefix to read is the thing rung 3 forbids. */
  ring: string;
}

/**
 * Resolve which channel to ask. ONE source: the installer's record.
 *
 * The record is the same fact `update` follows (`ring-follow.ts`), so the notice
 * and `update` cannot disagree about which ring an install is on — previously they
 * could, and on `edge` they always did: every prod build baked `…/cli/stable`, so
 * an edge install read the stable version, found a plain `X.Y.Z` outranking its own
 * `X.Y.Z-edge.<sha>` (semver §11.3: a prerelease sorts below its release) and
 * advertised an "update" that `update` itself then correctly refused to install.
 *
 * `null` when there is no record, which the caller reports as `skipped-no-record`.
 * No fallback: see `readInstallRecord` for why rung 3 rules one out.
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

/** The `VERSION` URL for a channel: always the ring-qualified `?dl=` form `update`
 *  uses, so both resolve one pointer through one first-party host. */
function versionUrl(channel: NoticeChannel): string {
  return ringAssetUrl(channel.base, "VERSION", channel.ring);
}

/**
 * Read the channel's advertised version, or `null` for every way of not knowing:
 * a transport failure, any non-2xx, an oversized body, or a `200` whose body is
 * not version-SHAPED.
 *
 * This used to distinguish `404` (`""`, an authoritative absence) from everything
 * else (`null`), because only the first was allowed to erase a STORED answer.
 * Nothing is stored now, so both mean the same thing to the one caller: say
 * nothing. A distinction that no longer changes behaviour is worse than no
 * distinction, so it is gone.
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
    // Includes the `404` of a pre-`VERSION` tag or a channel that never published
    // one, and the `403` of an edge rule on a public store. They differed only in
    // what they were permitted to overwrite; now neither says anything.
    if (!res.ok) return null;
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_VERSION_BYTES) return null;
    // Chunked responses declare no length, so the cap has to apply WHILE reading:
    // `res.text()` buffers the whole object before any check can reject it, and a
    // CDN delivers tens of megabytes well inside the 2s deadline.
    const body = await readBounded(res.body, MAX_VERSION_BYTES);
    if (body === null) return null;
    const trimmed = body.trim();
    // Only a version-SHAPED body counts as an answer: a `200` carrying a
    // captive-portal page, a proxy error or an empty body is not one, and this
    // file never repeats anything it cannot read as a version.
    //
    // SHAPE, not `parseSemver`: see `looksLikeVersion` — a semver-invalid but real
    // edge build is a real build.
    return looksLikeVersion(trimmed) ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Decide whether to tell the user about a newer release, refreshing the stored
 * answer at most once per window. Never throws, never writes to a stream.
 */
export async function maybeNotifyNewVersion(
  deps: VersionNoticeDeps,
): Promise<NoticeResult> {
  // First guard: never nag on a command that is itself about this binary's
  // lifecycle — see SELF_MANAGEMENT_COMMANDS for why each one is in the set.
  if (isSelfManagementCommand(deps.command)) {
    return { outcome: "skipped-explicit-command" };
  }
  // Gate on the exec-path signal AND the dev stamp, exactly as `update.ts` does:
  // a locally compiled binary with a baked channel base but no `RELEASE_TAG`
  // passes the exec-path test and would otherwise nag `0.0.0-dev -> …` forever.
  if (deps.fromSource || deps.version === DEV_VERSION) {
    return { outcome: "skipped-from-source" };
  }
  // The ring this install FOLLOWS, falling back to the baked base. Read before
  // the opt-out only would waste a file read, so it stays after it.
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
    // Two wordings, because only one of them is a claim the versions support:
    // "newer" when the ordering is real, "your channel now serves" when all that
    // is known is that the bytes differ (`shouldNotify`).
    const message = isNewerVersion(latest, deps.version)
      ? formatVersionNotice(deps.flavor, deps.version, latest, deps.invokedAs)
      : formatChannelChangedNotice(
          deps.flavor,
          deps.version,
          latest,
          deps.invokedAs,
        );
    return { outcome, message };
  };

  // A stamp in the FUTURE (clock set backwards, or a bad write) must not throttle
  // forever, so only a non-negative age inside the window counts as fresh.
  const age = state ? deps.now - state.checkedAt : Number.POSITIVE_INFINITY;
  if (age >= 0 && age < noticeIntervalMs(deps.flavor))
    return { outcome: "throttled" };

  // Claim the window BEFORE the fetch, and only proceed if the claim LANDED. An
  // unwritable state file (read-only `$HOME`, immutable home) otherwise means
  // every single command pays the full fetch deadline forever — one unwritable
  // dir turning into a per-invocation network call.
  if (!(await deps.claimWindow())) return { outcome: "skipped-unclaimable" };

  const fresh = await readChannelVersion(deps, channel);
  // `null` = we learned nothing (a failure, or a body that is not a version), and
  // this file never says anything it has not just been told.
  if (fresh === null) return { outcome: "checked" };
  return result(fresh, "checked");
}
