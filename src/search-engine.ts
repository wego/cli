import type { CliConfig } from "./config";

/**
 * The unified async-search core (issue #1084). Both `wego flights search` and
 * `wego hotels search` front an asynchronous metasearch: the API returns a
 * `searchId` immediately and results accrue upstream over the next few seconds.
 * The lifecycle is identical for both verticals —
 *
 *   ① CREATE  POST /searches → { searchId, … }                immediate · mutation
 *   ② READ    GET /searches/:id/results → one stateless read
 *   ③ SETTLE  block to settled, then stamp `settled`
 *   ④ DRILL / ⑤ HANDOFF                                       (per-vertical)
 *
 * — so stages ①②③ live here ONCE, generic over the snapshot shape `S`, and each
 * vertical supplies only what genuinely differs (its request wiring + the small
 * `SettleSignals`). Stages ④/⑤ stay per-vertical (the drill funnels legitimately
 * differ — flights has an extra fare-family hop) and are NOT modelled here.
 * The rooms rates read settles through its own `settleRates` (`commands.ts`):
 * its rule differs materially (stable-4 item count, empty needs done twice).
 */

/**
 * The honest state marker stamped onto every `search`/`results` payload so a
 * machine reading stdout can never mistake an empty page for a definitive
 * no-results:
 *
 * - `converged` — the settle reached a terminal signal (a completion flag, or a
 *   stable non-zero count on a snapshot that holds items).
 * - `budget_exhausted` — the re-read budget ran out while the snapshot was still
 *   moving (a heuristic terminal, not a state the upstream confirmed).
 * - `unsettled` — a single, deliberately un-waited `results` read (no settle
 *   attempted); an empty such page is "not ready yet", never "genuinely none".
 */
export type SettleState = "converged" | "budget_exhausted" | "unsettled";

/** The two states {@link settle} can return — it always attempts to settle, so
 *  it never returns `unsettled` (that marks a bare read at the call site). */
export type TerminalState = Exclude<SettleState, "unsettled">;

/**
 * How to read the settle signals off a snapshot. `isComplete` is OPTIONAL — its
 * absence *is* the flights↔hotels difference. Hotels supplies it (`done` →
 * `searchComplete`); flights genuinely has no completion flag, so its accessor is
 * simply `undefined` and it rides `count` (with `hasItems` as the fallback)
 * alone. Modelling completion as an optional capability makes the difference
 * unrepresentable as a bug: you cannot ask "is flights complete?".
 *
 * (No-match — a completed zero-candidate search — is NOT a settle signal: it
 * changes the empty-page *message*, not the terminal *state*, so it lives with
 * the vertical's note logic, not here.)
 */
export interface SettleSignals<S> {
  /** The upstream aggregation counter (flights `snapshotFareCount` / hotels
   *  `snapshotCandidateCount`), or `undefined` when the API omits it. */
  count(s: S): number | undefined;
  /** Whether the snapshot carries any results — the fallback when `count` is
   *  absent (a legacy API that omits the counter). */
  hasItems(s: S): boolean;
  /** Items in the raw snapshot, pre-filter/page. Defaults to {@link hasItems},
   *  which sees only the filtered page. */
  hasSnapshotItems?(s: S): boolean;
  /** Hotels only — an authoritative early terminal (`searchComplete === true`). */
  isComplete?(s: S): boolean;
}

/** The bounded block-to-settled budget: at most `maxRereads` re-reads on a
 *  rising `(n+1)·base` delay capped at `maxDelay` (issue #1084: 12 / 300ms / 3s,
 *  ~22s worst case, matching the Roxana-style budget). */
export interface SettleBudget {
  maxRereads: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/** The one shared budget both verticals settle on (Decision: "12 re-reads on a
 *  300ms→3s rising delay"). The count convergence almost always stops far sooner
 *  — the cap is only the cold-upstream backstop. */
export const DEFAULT_SETTLE_BUDGET: SettleBudget = {
  maxRereads: 12,
  baseDelayMs: 300,
  maxDelayMs: 3000,
};

/**
 * The ONE settle loop — generic over the snapshot `S`, zero per-vertical
 * branching. Re-reads on the budget until the snapshot reaches a terminal
 * signal, then returns it with the honest terminal label:
 *
 * - an authoritative `isComplete` (hotels) is a terminal `converged` once
 *   `count` also holds steady (the flag can flip true a beat early);
 * - a non-zero `count` equal across two reads, on a snapshot that holds items
 *   (`hasSnapshotItems`), is `converged` — the counter runs ahead of the items;
 * - when `count` is absent, item-presence (`hasItems`) is the `converged`
 *   fallback;
 * - otherwise the budget is spent → `budget_exhausted`.
 *
 * Consolidates the two former per-vertical helpers into one: the flights `--wait`
 * count-convergence loop (`settleFlightResults`, #1112) and the hotels
 * candidate-count loop (`settleHotelResults`, #1113/#1172). Their rules are now a
 * single generic loop — see the PR body for the behavior delta this bundles when
 * shipped to `main` (flights `search` gains blocking; hotels moves from a 4-read
 * item-presence settle to this 12-reread count-convergence).
 */
function hasConverged<S>(
  sig: SettleSignals<S>,
  snapshot: S,
  count: number | undefined,
  prevCount: number | undefined,
): boolean {
  // hotels-only terminal; needs a steady count — the flag can flip true early
  if (
    sig.isComplete?.(snapshot) === true &&
    (count === undefined || count === prevCount)
  ) {
    return true;
  }
  // No count signal (legacy API omitting the counter) → item-presence fallback.
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
  // create). A vertical can key its read-failure handling off it — e.g. flights
  // folds only the attempt-0 failure into the create-recovery hint, and lets a
  // mid-settle (attempt > 0) failure surface with its real exit-code taxonomy.
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

/** The command IO + injected timer the engine needs. Both `FlightsDeps` and
 *  `HotelsDeps` structurally satisfy this, so a vertical's own deps bag flows
 *  straight through as the engine's `deps`. */
export interface EngineDeps {
  log: (message: string) => void;
  error: (message: string) => void;
  /** Delay between re-reads (injected so tests drive the settle without timers). */
  sleep: (ms: number) => Promise<void>;
}

/** The uniform outcome of an authed call: the value, or a stable taxonomy exit
 *  code (the shared `withAccessToken` contract). */
export type EngineOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; code: number };

/**
 * The engine's execution context: config, the vertical's deps bag (its api
 * functions + IO + `sleep`), and the shared credential dance. `withAccessToken`
 * is injected (not imported) so the engine stays a pure base layer with no
 * dependency back on `commands.ts`.
 */
export interface Engine<D extends EngineDeps> {
  config: CliConfig;
  deps: D;
  withAccessToken: <T>(
    call: (accessToken: string, market: string | undefined) => Promise<T>,
  ) => Promise<EngineOutcome<T>>;
}

/** What a `create` returns: the id, the fields to surface in the printed
 *  snapshot (siteCode/occupancy…), and the query for the post-create settle read
 *  (currency/locale threaded from the search inputs). */
export interface Created<Query> {
  searchId: string;
  extra: Record<string, unknown>;
  readQuery: Query;
}

/**
 * A vertical = the small config that specializes the shared engine. It owns its
 * request wiring (create + the two read contexts) and the tiny presentation
 * differences (the empty-page hint, the create-recovery hint) that genuinely
 * differ; the engine owns create-then-settle-then-stamp.
 */
export interface SearchVertical<S, Input, Query, D extends EngineDeps> {
  readonly signals: SettleSignals<S>;
  /** ① CREATE — POST the search (resolving `--site`), in its OWN authed call so
   *  a mid-settle 401 never re-POSTs a second search. */
  create(eng: Engine<D>, input: Input): Promise<EngineOutcome<Created<Query>>>;
  /** ② READ used by `runSearch`'s post-create settle. `attempt` is the 0-based
   *  read index the settle loop is on (0 = the first read, right after create).
   *  Error handling is per-vertical: flights folds only the **attempt-0** failure
   *  into the create-recovery hint (a mid-settle failure surfaces with its real
   *  exit-code taxonomy); hotels lets the raw error surface then adds the hint. */
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
  /** The stderr hint for a `search` snapshot (empty-page guidance), or
   *  `undefined` when nothing should print. (No `state`: a `search` always
   *  attempts a settle, and both verticals key their note off the snapshot's own
   *  fields, not the terminal label.) */
  searchNote(snapshot: S, searchId: string): string | undefined;
  /** The stderr hint for a `results` snapshot (bare or `--wait`), or `undefined`. */
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

/** ①+③ create, block-to-settled, stamp. An empty settled page means different
 *  things per vertical — read the vertical's `searchNote`. */
export async function runSearch<S, Input, Query, D extends EngineDeps>(
  vertical: SearchVertical<S, Input, Query, D>,
  input: Input,
  budget: SettleBudget,
  eng: Engine<D>,
): Promise<number> {
  const created = await vertical.create(eng, input);
  if (!created.ok) return created.code;
  const { searchId, extra, readQuery } = created.value;
  // The settle read runs in a SEPARATE authed call from the create, so a
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
 * ②+③ — `--wait` blocks to settled; a bare read is one snapshot stamped
 * `unsettled`. There is no `--no-wait` flag: the bare read IS the opt-out. Every
 * payload carries a `settled` field either way.
 *
 * `extra` is the read-path twin of `Created.extra`: fields the CLI resolved
 * itself and owes the caller, merged into the printed payload. A read has no
 * create to hang them on, so the command passes them in. Same merge order as
 * `runSearch`, so one field cannot mean two things depending on which command
 * produced it.
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
      // The whole `--wait` settle stays inside ONE authed call: reads are
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
