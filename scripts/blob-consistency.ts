/**
 * Channel consistency barrier for the release publisher (`upload-release-blob.ts`).
 *
 * A moving channel (`cli/latest` / `cli/staging`) is advanced by copying ~11
 * blobs — the binaries AND their `SHA256SUMS.txt` manifest — onto MUTABLE
 * pathnames. That is a non-atomic multi-object update over a CDN with per-object
 * propagation, so for a brief window a reader can observe the fresh manifest next
 * to a still-cached previous binary. Every verifying consumer (`wego update`, the
 * `curl | bash` installer, the release workflow's self-update smoke) fetches
 * manifest-then-binary and cross-checks them, so that window surfaces as a
 * checksum mismatch → fail-closed refusal (see the promote ordering in
 * `upload-release-blob.ts`).
 *
 * The publisher closes the window from its side: it copies the manifest LAST, and
 * then calls `waitChannelConsistent` to poll the channel's OWN served URLs — the
 * exact plain GETs a consumer makes — until the served manifest equals the tag's
 * and every binary it lists hash-matches. Only then does `--promote` return, so a
 * channel is never reported advanced while a reader could still see a mismatch.
 *
 * Pure and dependency-injected (fetch / hash / sleep / log) so it unit-tests
 * without network, Bun, or a real Blob store.
 */

/** `deps` for {@link waitChannelConsistent} — injected so tests supply fakes. */
export interface ConsistencyDeps {
  /** `fetch`, injectable for tests. Called with `cache: "no-store"` so the
   *  barrier's own loop is never fooled by a runtime HTTP cache — it still rides
   *  the CDN like a fresh consumer process would. */
  fetch: typeof fetch;
  /** Lowercase hex sha256 of a downloaded body. */
  hash: (body: ArrayBuffer) => Promise<string>;
  /** Sleep between polls. */
  sleep: (ms: number) => Promise<void>;
  /** Progress line. */
  log: (message: string) => void;
  /** Poll budget (default 24). 24 × 5s = 120s comfortably exceeds the channel's
   *  60s `cacheControlMaxAge`, so an edge serving a stale cached copy revalidates
   *  well within budget. */
  maxAttempts?: number;
  /** Delay between polls in ms (default 5000). */
  delayMs?: number;
  /** Per-request deadline for the small manifest fetch (default 30_000), matching
   *  `update.ts`'s SUMS timeout — without it a stalled connection would hang the
   *  whole barrier, defeating the "fails rather than hangs" budget. */
  manifestTimeoutMs?: number;
  /** Per-request deadline for a (60–95 MB) binary fetch (default 600_000), matching
   *  `update.ts`'s download timeout / verify-published.sh's `--max-time 600`. */
  assetTimeoutMs?: number;
  /** Asset names whose served BODY is not checked on this pass. The manifest
   *  comparison always uses the FULL expected map: dropping a name from it makes
   *  the served manifest a permanent size mismatch (`sameSums`), which can never
   *  converge. The publisher's first barrier uses this to certify the deliverable
   *  channel before `VERSION` - which that manifest already vouches for - has been
   *  copied; its second barrier then runs with no skips. */
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

/** Two manifests describe the same assets iff they have identical name→hash maps. */
export function sameSums(
  a: Map<string, string>,
  b: Map<string, string>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [name, hash] of b) if (a.get(name) !== hash) return false;
  return true;
}

/** Human string for a fetch OR body-read failure — never re-thrown. A deadline
 *  fires an `AbortSignal.timeout` → `TimeoutError`; that same signal can abort a
 *  body transfer mid-stream (plausible for a 60–95 MB asset near its timeout), so
 *  both the request and the body read funnel through this so every failure becomes
 *  a retryable per-poll issue, never an uncaught throw out of the barrier. */
function fetchErrorText(err: unknown, timeoutMs?: number): string {
  if (err instanceof Error && err.name === "TimeoutError") {
    return timeoutMs ? `timed out (>${timeoutMs}ms)` : "timed out mid-body";
  }
  return err instanceof Error ? err.message : "fetch failed";
}

/**
 * `deps.fetch` under a per-request deadline. Returns the `Response`, or an error
 * STRING (never throws) so a stalled/timed-out request becomes a retryable issue
 * for THIS poll rather than aborting the whole barrier — the maxAttempts budget
 * is what ultimately fails a channel that never converges. `cache: "no-store"`
 * keeps the loop from being fooled by a runtime HTTP cache while still riding the
 * CDN like a fresh consumer.
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

/** Fetch + READ the channel manifest under one deadline; return its parsed sums,
 *  or an issue string. The body read (`.text()`) is inside the try/catch so an
 *  abort mid-transfer is a retryable issue, not an uncaught throw. */
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

/** Fetch + READ + hash one asset under one deadline; return null when it matches
 *  `want` (caller marks it verified), else an issue string. The body read
 *  (`.arrayBuffer()` + `deps.hash`) is inside the try/catch — a mid-stream abort
 *  on a large binary becomes a retryable issue, honoring the "never throws"
 *  contract the earlier version broke by reading the body outside timedFetch. */
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
 *     manifest. Since the publisher copies the manifest LAST, its appearance
 *     means the binaries were copied first — so a matching manifest is the signal
 *     to check the bytes. A missing/stale manifest short-circuits (no point
 *     downloading binaries yet).
 *  2. Every asset the manifest vouches for must serve bytes hashing to the
 *     expected value.
 *
 * Every network op (request AND body read) is funneled through `fetchManifest` /
 * `checkAsset`, which convert any failure to an issue string — so a poll never
 * throws and a transient stall is retried, not fatal.
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

/** Render up to four issues for a progress line, summarizing any overflow. */
function summarizeIssues(issues: string[]): string {
  const shown = issues.slice(0, 4).join("; ");
  return issues.length > 4 ? `${shown} (+${issues.length - 4} more)` : shown;
}

/**
 * Block until `base` (a channel URL like `https://…/cli/staging`) is
 * self-consistent to a plain reader: its served `SHA256SUMS.txt` equals
 * `expected` (the tag's manifest) AND every binary the manifest lists serves
 * bytes hashing to the expected value. Resolves once consistent; throws after the
 * bounded budget so a channel that never converges (a genuinely mismatched
 * publish, not mere propagation lag) fails the release rather than hanging.
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
