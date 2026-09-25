import type { CliConfig } from "./config";

/**
 * The shared async-search core. Both `wego flights search` and
 * `wego hotels search` front an asynchronous metasearch: the API returns a
 * `searchId` immediately and results accrue upstream over the next few seconds.
 * The lifecycle is the same for both verticals:
 *
 *   ① CREATE  POST /searches → { searchId, … }                immediate · mutation
 *   ② READ    GET /searches/:id/results → one stateless read
 *   ③ SETTLE  block to settled, then stamp `settled`
 *   ④ DRILL / ⑤ HANDOFF                                       (per-vertical)
 *
 * Stages ①②③ live here, generic over the snapshot shape `S`; each vertical
 * supplies its request wiring and `SettleSignals`. Stages ④/⑤ are not modelled
 * here because the drill funnels differ (flights has an extra fare-family hop).
 * The rooms rates read settles through its own `settleRates` (`commands.ts`)
 * because its rule differs (stable item count over four reads, and an empty
 * page needs `searchComplete` twice).
 */

/**
 * Stamped onto every `search`/`results` payload so a machine reading stdout
 * cannot mistake an empty page for a definitive no-results:
 *
 * - `converged`: the settle reached a terminal signal (a completion flag, or a
 *   stable non-zero count on a snapshot that holds items).
 * - `budget_exhausted`: the re-read budget ran out while the snapshot was still
 *   moving (a heuristic terminal, not one the upstream confirmed).
 * - `unsettled`: a single un-waited `results` read (no settle attempted); an
 *   empty page is "not ready yet", never "genuinely none".
 */
export type SettleState = "converged" | "budget_exhausted" | "unsettled";

/** {@link settle} always attempts to settle, so it never returns `unsettled`
 *  (that marks a bare read at the call site). */
export type TerminalState = Exclude<SettleState, "unsettled">;

/**
 * How to read the settle signals off a snapshot. `isComplete` is optional
 * because flights has no completion flag: it settles on `count` alone (with
 * `hasItems` as the fallback), while hotels supplies it (`searchComplete`).
 * Making completion optional means code cannot ask "is flights complete?".
 *
 * No-match (a completed zero-candidate search) is not a settle signal: it
 * changes the empty-page message, not the terminal state, so it lives with the
 * vertical's note logic.
 */
export interface SettleSignals<S> {
  /** The upstream aggregation counter (flights `snapshotFareCount` / hotels
   *  `snapshotCandidateCount`), or `undefined` when the API omits it. */
  count(s: S): number | undefined;
  /** The fallback when `count` is absent (an older API that omits the
   *  counter). */
  hasItems(s: S): boolean;
  /** Items in the raw snapshot, pre-filter/page. Defaults to {@link hasItems},
   *  which sees only the filtered page. */
  hasSnapshotItems?(s: S): boolean;
  /** Hotels only: an authoritative early terminal (`searchComplete === true`). */
  isComplete?(s: S): boolean;
}

/** At most `maxRereads` re-reads on a rising `(n+1)·base` delay capped at
 *  `maxDelay`. */
export interface SettleBudget {
  maxRereads: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/** About 22 s worst case. Count convergence almost always stops far sooner; the
 *  cap is a backstop for a cold upstream. */
export const DEFAULT_SETTLE_BUDGET: SettleBudget = {
  maxRereads: 12,
  baseDelayMs: 300,
  maxDelayMs: 3000,
};

/**
 * The settle rule, with no per-vertical branching:
 *
 * - an authoritative `isComplete` (hotels) is `converged` once `count` also
 *   holds steady (the flag can flip true a beat early);
 * - a non-zero `count` equal across two reads, on a snapshot that holds items
 *   (`hasSnapshotItems`), is `converged` (the counter runs ahead of the items);
 * - when `count` is absent, item-presence (`hasItems`) is the fallback;
 * - otherwise `settle` keeps reading until the budget is spent
 *   (`budget_exhausted`).
 */
function hasConverged<S>(
  sig: SettleSignals<S>,
  snapshot: S,
  count: number | undefined,
  prevCount: number | undefined,
): boolean {
  // The flag can flip true early, so also require a steady count.
  if (
    sig.isComplete?.(snapshot) === true &&
    (count === undefined || count === prevCount)
  ) {
    return true;
  }
  if (count === undefined) return sig.hasItems(snapshot);
  // Both halves required: the counter can hold steady over an empty snapshot.
  return (
    count > 0 &&
    count === prevCount &&
    (sig.hasSnapshotItems ?? sig.hasItems)(snapshot)
  );
}

export async function settle<S>(
  read: (attempt: number) => Promise<S>,
  sig: SettleSignals<S>,
  budget: SettleBudget,
  sleep: (ms: number) => Promise<void>,
): Promise<{ snapshot: S; state: TerminalState }> {
  // `attempt` is the 0-based read index (0 = the first read, right after a
  // create), so a vertical can handle a first-read failure differently from a
  // mid-settle one (see `readAfterCreate`).
  let snapshot = await read(0);
  let prevCount: number | undefined;
  for (let reread = 0; ; reread++) {
    const count = sig.count(snapshot);
    if (hasConverged(sig, snapshot, count, prevCount)) {
      return { snapshot, state: "converged" };
    }
    if (reread >= budget.maxRereads) {
      return { snapshot, state: "budget_exhausted" };
    }
    prevCount = count;
    await sleep(Math.min((reread + 1) * budget.baseDelayMs, budget.maxDelayMs));
    snapshot = await read(reread + 1);
  }
}

/** Both `FlightsDeps` and `HotelsDeps` structurally satisfy this, so a
 *  vertical's own deps bag passes straight through as the engine's `deps`. */
export interface EngineDeps {
  log: (message: string) => void;
  error: (message: string) => void;
  /** Injected so tests drive the settle without timers. */
  sleep: (ms: number) => Promise<void>;
}

/** The outcome of an authed call via `withAccessToken`: the value, or an exit
 *  code. */
export type EngineOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; code: number };

/**
 * `withAccessToken` is injected rather than imported so the engine has no
 * dependency back on `commands.ts`.
 */
export interface Engine<D extends EngineDeps> {
  config: CliConfig;
  deps: D;
  withAccessToken: <T>(
    call: (accessToken: string, market: string | undefined) => Promise<T>,
  ) => Promise<EngineOutcome<T>>;
}

/** `extra` holds the fields to surface in the printed snapshot
 *  (siteCode/occupancy…); `readQuery` is the query for the post-create settle
 *  read (currency/locale carried from the search inputs). */
export interface Created<Query> {
  searchId: string;
  extra: Record<string, unknown>;
  readQuery: Query;
}

/**
 * A vertical owns its request wiring (create and the two read contexts) and its
 * presentation differences (the empty-page hint, the create-recovery hint); the
 * engine owns create, settle and stamp.
 */
export interface SearchVertical<S, Input, Query, D extends EngineDeps> {
  readonly signals: SettleSignals<S>;
  /** ① CREATE: POST the search (resolving `--site`) in its own authed call, so
   *  a mid-settle 401 never re-POSTs a second search. */
  create(eng: Engine<D>, input: Input): Promise<EngineOutcome<Created<Query>>>;
  /** ② READ used by `runSearch`'s post-create settle. `attempt` is the 0-based
   *  read index (0 = the first read, right after create). Flights turns only
   *  the attempt-0 failure into the create-recovery hint (a mid-settle failure
   *  surfaces with its real exit code); hotels lets the raw error surface, then
   *  adds the hint. */
  readAfterCreate(
    eng: Engine<D>,
    searchId: string,
    token: string,
    query: Query,
    attempt: number,
  ): Promise<S>;
  /** ② READ used by `runResults`. Translates a 404 into the vertical's
   *  "search expired" hint (re-throwing 401 for the refresh path). */
  readResults(
    eng: Engine<D>,
    searchId: string,
    token: string,
    query: Query,
  ): Promise<S>;
  /** The stderr hint for a `search` snapshot. It takes no `state`: a `search`
   *  always attempts a settle, and both verticals key their note off the
   *  snapshot's own fields, not the terminal label. */
  searchNote(snapshot: S, searchId: string): string | undefined;
  /** The stderr hint for a `results` snapshot (bare or `--wait`). */
  resultsNote(
    snapshot: S,
    searchId: string,
    state: SettleState,
    wait: boolean,
  ): string | undefined;
  /** The recovery hint when the post-create settle read fails (the searchId is
   *  still valid to re-poll). `undefined` when the vertical already folded it
   *  into `readAfterCreate` (flights). */
  createdRecoveryHint(searchId: string): string | undefined;
}

/** ①+③ create, block to settled, stamp. An empty settled page means different
 *  things per vertical; see the vertical's `searchNote`. */
export async function runSearch<S, Input, Query, D extends EngineDeps>(
  vertical: SearchVertical<S, Input, Query, D>,
  input: Input,
  budget: SettleBudget,
  eng: Engine<D>,
): Promise<number> {
  const created = await vertical.create(eng, input);
  if (!created.ok) return created.code;
  const { searchId, extra, readQuery } = created.value;
  // The settle read runs in a separate authed call from the create, so a
  // mid-settle 401 refresh retries only the (idempotent) read, never the create.
  const settled = await eng.withAccessToken((token) =>
    settle(
      (attempt) =>
        vertical.readAfterCreate(eng, searchId, token, readQuery, attempt),
      vertical.signals,
      budget,
      eng.deps.sleep,
    ),
  );
  if (!settled.ok) {
    const hint = vertical.createdRecoveryHint(searchId);
    if (hint) eng.deps.error(hint);
    return settled.code;
  }
  const { snapshot, state } = settled.value;
  eng.deps.log(
    JSON.stringify({ ...snapshot, settled: state, ...extra }, null, 2),
  );
  const note = vertical.searchNote(snapshot, searchId);
  if (note) eng.deps.error(note);
  return 0;
}

/**
 * ②+③ `--wait` blocks to settled; a bare read is one snapshot stamped
 * `unsettled`. There is no `--no-wait` flag: the bare read is the opt-out.
 *
 * `extra` is the read-path counterpart of `Created.extra`: fields the CLI
 * resolved itself, merged into the printed payload. A read has no create to
 * carry them, so the command passes them in. The merge order matches
 * `runSearch`, so a field means the same thing whichever command printed it.
 */
export async function runResults<S, Input, Query, D extends EngineDeps>(
  vertical: SearchVertical<S, Input, Query, D>,
  searchId: string,
  query: Query,
  wait: boolean,
  budget: SettleBudget,
  eng: Engine<D>,
  extra: Record<string, unknown> = {},
): Promise<number> {
  const outcome = await eng.withAccessToken(
    async (token): Promise<{ snapshot: S; state: SettleState }> => {
      const read = () => vertical.readResults(eng, searchId, token, query);
      // The whole `--wait` settle stays inside one authed call: reads are
      // idempotent, so a mid-settle 401 refresh safely restarts the poll.
      return wait
        ? await settle(read, vertical.signals, budget, eng.deps.sleep)
        : { snapshot: await read(), state: "unsettled" };
    },
  );
  if (!outcome.ok) return outcome.code;
  const { snapshot, state } = outcome.value;
  eng.deps.log(
    JSON.stringify({ ...snapshot, settled: state, ...extra }, null, 2),
  );
  const note = vertical.resultsNote(snapshot, searchId, state, wait);
  if (note) eng.deps.error(note);
  return 0;
}
