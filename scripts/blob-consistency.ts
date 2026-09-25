/**
 * Channel consistency barrier for the release publisher (`upload-release-blob.ts`).
 *
 * A moving channel (`cli/next` / `cli/stable`, and `cli/edge` through
 * `publish-edge-blob.ts`) is advanced by copying ~11 blobs (the binaries and
 * their `SHA256SUMS.txt` manifest) onto mutable pathnames. That is a non-atomic
 * multi-object update over a CDN with per-object propagation, so for a brief
 * window a reader can see the fresh manifest next to a still-cached previous
 * binary. Every verifying consumer (`wego update`, the `curl | bash` installer,
 * the release workflow's self-update smoke) fetches manifest-then-binary and
 * cross-checks them, so that window shows up as a checksum mismatch and a
 * fail-closed refusal (see the promote ordering in `upload-release-blob.ts`).
 *
 * The publisher copies the manifest last, then calls `waitChannelConsistent` to
 * poll the channel's own served URLs (the same plain GETs a consumer makes)
 * until the served manifest equals the tag's and every binary it lists
 * hash-matches. Only then does `--promote` return, so a channel is never
 * reported advanced while a reader could still see a mismatch.
 *
 * Dependency-injected (fetch / hash / sleep / log) so it unit-tests without
 * network, Bun, or a real Blob store.
 */

export interface ConsistencyDeps {
  fetch: typeof fetch;
  /** Lowercase hex sha256 of a downloaded body. */
  hash: (body: ArrayBuffer) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
  /** Poll budget (default 24). 24 × 5s = 120s exceeds the channel's 60s
   *  `cacheControlMaxAge`, so an edge serving a stale copy revalidates within
   *  budget. */
  maxAttempts?: number;
  /** Delay between polls in ms (default 5000). */
  delayMs?: number;
  /** Per-request deadline for the manifest fetch (default 30_000), matching
   *  `update.ts`'s SUMS timeout. Without it a stalled connection would hang the
   *  barrier instead of failing within budget. */
  manifestTimeoutMs?: number;
  /** Per-request deadline for a (60-95 MB) binary fetch (default 600_000),
   *  matching `update.ts`'s download timeout and verify-published.sh's
   *  `--max-time 600`. */
  assetTimeoutMs?: number;
  /** Asset names whose served body is not checked on this pass. The manifest
   *  comparison always uses the full expected map: dropping a name from it
   *  makes the served manifest a permanent size mismatch (`sameSums`) that can
   *  never converge. The publisher's first barrier uses this to certify the
   *  channel before `VERSION` (which that manifest already vouches for) has
   *  been copied; its second barrier runs with no skips. */
  skipAssets?: ReadonlySet<string>;
}

/**
 * Parse a `sha256sum`-style manifest body into `{ assetName → lowercase hex }`.
 * Accepts both the GNU `<hash>␠␠<name>` and BSD `<hash>␠*<name>` line shapes.
 * Lines that aren't a hash+name pair (blank lines, stray text) are ignored.
 */
export function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (match) sums.set(match[2].trim(), match[1].toLowerCase());
  }
  return sums;
}

export function sameSums(
  a: Map<string, string>,
  b: Map<string, string>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [name, hash] of b) if (a.get(name) !== hash) return false;
  return true;
}

/** Text for a fetch or body-read failure, never re-thrown. The
 *  `AbortSignal.timeout` deadline can also abort a body mid-stream (plausible
 *  for a 60-95 MB asset near its timeout), so both the request and the body
 *  read go through this and every failure becomes a retryable per-poll issue. */
function fetchErrorText(err: unknown, timeoutMs?: number): string {
  if (err instanceof Error && err.name === "TimeoutError") {
    return timeoutMs ? `timed out (>${timeoutMs}ms)` : "timed out mid-body";
  }
  return err instanceof Error ? err.message : "fetch failed";
}

/**
 * Returns an error string instead of throwing, so a stalled request becomes a
 * retryable issue for this poll rather than aborting the barrier; the
 * maxAttempts budget is what fails a channel that never converges.
 * `cache: "no-store"` bypasses any runtime HTTP cache while still going through
 * the CDN like a fresh consumer.
 */
async function timedFetch(
  deps: ConsistencyDeps,
  url: string,
  timeoutMs: number,
): Promise<Response | string> {
  try {
    return await deps.fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return fetchErrorText(err, timeoutMs);
  }
}

/** The body read is inside the try/catch so an abort mid-transfer is a
 *  retryable issue, not an uncaught throw. */
async function fetchManifest(
  base: string,
  deps: ConsistencyDeps,
): Promise<Map<string, string> | string> {
  const timeoutMs = deps.manifestTimeoutMs ?? 30_000;
  const res = await timedFetch(deps, `${base}/SHA256SUMS.txt`, timeoutMs);
  if (typeof res === "string") return `manifest ${res}`;
  if (!res.ok) return `manifest HTTP ${res.status}`;
  try {
    return parseSums(await res.text());
  } catch (err) {
    return `manifest ${fetchErrorText(err, timeoutMs)}`;
  }
}

/** Returns null when the asset matches `want`, else an issue string. The body
 *  read and hash are inside the try/catch so a mid-stream abort on a large
 *  binary is a retryable issue, not a throw. */
async function checkAsset(
  base: string,
  name: string,
  want: string,
  deps: ConsistencyDeps,
): Promise<string | null> {
  const timeoutMs = deps.assetTimeoutMs ?? 600_000;
  const res = await timedFetch(deps, `${base}/${name}`, timeoutMs);
  if (typeof res === "string") return `${name} ${res}`;
  if (!res.ok) return `${name} HTTP ${res.status}`;
  let got: string;
  try {
    got = await deps.hash(await res.arrayBuffer());
  } catch (err) {
    return `${name} ${fetchErrorText(err, timeoutMs)}`;
  }
  return got === want
    ? null
    : `${name} ${got.slice(0, 12)}≠${want.slice(0, 12)}`;
}

/**
 * One consistency poll of `base`. Returns the problems observed this attempt
 * (empty = the channel is fully consistent right now); mutates `verified` with
 * the assets confirmed matching so a later poll skips re-downloading them.
 *
 *  1. The channel's `SHA256SUMS.txt` must already equal the tag's `expected`
 *     manifest. The publisher copies the manifest last, so a matching manifest
 *     means the binaries were copied first and it is time to check the bytes.
 *     A missing or stale manifest short-circuits.
 *  2. Every asset the manifest vouches for must serve bytes hashing to the
 *     expected value.
 *
 * A poll never throws: a transient stall is retried, not fatal.
 */
async function pollChannel(
  base: string,
  expected: Map<string, string>,
  verified: Set<string>,
  deps: ConsistencyDeps,
): Promise<string[]> {
  const manifest = await fetchManifest(base, deps);
  if (typeof manifest === "string") return [manifest];
  if (!sameSums(manifest, expected)) return ["manifest not yet advanced"];

  const issues: string[] = [];
  for (const [name, want] of expected) {
    if (verified.has(name) || deps.skipAssets?.has(name)) continue;
    const issue = await checkAsset(base, name, want, deps);
    if (issue === null) verified.add(name);
    else issues.push(issue);
  }
  return issues;
}

function summarizeIssues(issues: string[]): string {
  const shown = issues.slice(0, 4).join("; ");
  return issues.length > 4 ? `${shown} (+${issues.length - 4} more)` : shown;
}

/**
 * Block until `base` (a channel URL like `https://…/cli/next`) is
 * self-consistent to a plain reader: its served `SHA256SUMS.txt` equals
 * `expected` (the tag's manifest) and every binary it lists serves bytes
 * hashing to the expected value. Throws after the bounded budget so a channel
 * that never converges (a genuinely mismatched publish, not propagation lag)
 * fails the release rather than hanging.
 *
 * A binary that has matched once is not re-fetched on later attempts, so a slow
 * convergence downloads each large asset a bounded number of times, not
 * maxAttempts × every asset.
 */
export async function waitChannelConsistent(
  base: string,
  expected: Map<string, string>,
  deps: ConsistencyDeps,
): Promise<void> {
  const maxAttempts = deps.maxAttempts ?? 24;
  const delayMs = deps.delayMs ?? 5000;
  const verified = new Set<string>();
  // Skipped names still have to appear in the manifest comparison, so count the
  // bodies this pass is actually responsible for rather than the manifest size.
  const wanted = [...expected.keys()].filter(
    (name) => !deps.skipAssets?.has(name),
  ).length;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const issues = await pollChannel(base, expected, verified, deps);
    if (issues.length === 0 && verified.size === wanted) {
      deps.log(
        `✓ ${base} self-consistent (${wanted} assets; manifest matches the tag).`,
      );
      return;
    }
    deps.log(
      `… ${base} settling [${attempt}/${maxAttempts}]: ${summarizeIssues(issues)}`,
    );
    if (attempt < maxAttempts) await deps.sleep(delayMs);
  }

  throw new Error(
    `${base} did not converge to the published manifest after ${maxAttempts} attempts — ` +
      "the channel's manifest and binaries still disagree, so it is NOT safe to certify as advanced.",
  );
}
