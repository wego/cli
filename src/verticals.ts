import {
  type CreateFlightSearchBody,
  type FlightCardsResult,
  type FlightResultsQuery,
  type HotelResultsQuery,
  type HotelsResultsResponse,
  type HotelsSearchBody,
  UnauthorizedError,
} from "./api";
import {
  type CliSiteSource,
  type FlightsDeps,
  type HotelsDeps,
  resolveCliCurrency,
  resolveCliSite,
  stripMetadataSources,
  translateNotFound,
} from "./commands";
import { programName } from "./program-name";
import type {
  Created,
  EngineOutcome,
  SearchVertical,
  SettleState,
} from "./search-engine";

/**
 * The two `SearchVertical` configs that specialize the shared engine
 * (`search-engine.ts`). Each wraps the existing per-vertical request wiring (the
 * `create*`/`fetch*` deps + the arg parsers' output) and declares its
 * `SettleSignals`; the presence/absence of the optional `isComplete` accessor
 * *is* the flights↔hotels difference (issue #1084):
 *
 * - HOTELS supplies it — `searchComplete` is an authoritative terminal.
 * - FLIGHTS omits it — the metasearch envelope carries no completion flag, so
 *   it rides `snapshotFareCount` (with item-presence as the fallback) alone, and
 *   an empty flights page can never be classified as "genuinely none".
 *
 * The completed-zero-candidate *no-match* (hotels) is phrased by
 * `hotelEmptyNote`, not modelled as a settle signal — it changes the empty-page
 * message, not the terminal state.
 */

// The command name the user actually invoked (`wego` / `wegostaging` / renamed),
// so hints tell them what to type. Comments keep the literal `wego`.
const PROG = programName();

// --- flights ----------------------------------------------------------------

/** The flights results snapshot the CLI branches on: the fares-less card
 *  projection, which is the only shape the results read answers with (#1308). */
type FlightsSnapshot = FlightCardsResult;

/** Read `snapshotFareCount` off the metadata — the settle convergence signal.
 *  Only a legacy API that omits it yields `undefined`, which routes the settle to
 *  the item-presence fallback. */
function flightSnapshotCount(s: FlightsSnapshot): number | undefined {
  return s.metadata.snapshotFareCount;
}

/** An empty flights page is either "upstream has nothing yet" or "your filters
 *  excluded everything" — `snapshotTripCount` is the only field that tells them
 *  apart, so the hint must branch on it rather than always saying "poll again". */
function emptyFlightsNote(s: FlightsSnapshot, searchId: string): string {
  return (s.metadata.snapshotTripCount ?? 0) > 0
    ? `The snapshot has trips but none match these filters – check metadata.filterOptions for the codes this snapshot carries, then widen or drop them, or re-run: ${PROG} flights results ${searchId}`
    : `No trips have settled yet – re-run: ${PROG} flights results ${searchId} --wait`;
}

export const FLIGHTS: SearchVertical<
  FlightsSnapshot,
  CreateFlightSearchBody,
  FlightResultsQuery,
  FlightsDeps
> = {
  signals: {
    count: flightSnapshotCount,
    hasItems: (s) => s.results.length > 0,
    // Pre-filter count: `results` is the page after filter/sort/slice.
    hasSnapshotItems: (s) =>
      s.metadata.snapshotTripCount === undefined
        ? s.results.length > 0
        : s.metadata.snapshotTripCount > 0,
    // Flights omits isComplete — it has no completion flag.
  },
  async create(
    eng,
    input,
  ): Promise<EngineOutcome<Created<FlightResultsQuery>>> {
    // Resolve --site once: explicit → the stored `site` setting → id_token-derived
    // market (account) → nothing (the API floors to US → default). Reported back
    // as the CLI's OWN source below (only the CLI knows a market came from a
    // setting or was auto-derived). `--currency` rides the same path, for the same
    // reason (issue #1400): the command merges only `locale` before the engine
    // runs, so the currency's rung is still legible here.
    const settings = await eng.deps.loadSettings();
    let siteSource: CliSiteSource = "default";
    const currency = resolveCliCurrency(input.currency, settings.currency);
    const created = await eng.withAccessToken((token, market) => {
      const resolved = resolveCliSite(input.siteCode, settings.site, market);
      siteSource = resolved.source;
      return eng.deps.createFlightSearch(eng.config.apiBaseUrl, token, {
        ...input,
        siteCode: resolved.siteCode,
        currency: currency.currency,
      });
    });
    if (!created.ok) return created;
    // Read the first page in the search's currency/locale (not the API defaults).
    // The SAME resolved currency the create used, so the settle read cannot come
    // back in a different unit than the search was priced in.
    const readQuery: FlightResultsQuery = {};
    if (currency.currency) readQuery.currency = currency.currency;
    if (input.locale) readQuery.locale = input.locale;
    // Emit the site pair atomically: a legacy API omits the echo, so drop both
    // rather than print an orphan source. The currency source needs no such pair:
    // it labels what the CLI resolved, not something the API echoed back.
    const extra: Record<string, unknown> = {
      currencyCodeSource: currency.source,
    };
    if (created.value.siteCode !== undefined) {
      extra.siteCode = created.value.siteCode;
      extra.siteCodeSource = siteSource;
    }
    return {
      ok: true,
      value: { searchId: created.value.searchId, extra, readQuery },
    };
  },
  readAfterCreate(eng, searchId, token, query, attempt) {
    const read = eng.deps
      .fetchFlightResults(eng.config.apiBaseUrl, token, searchId, query)
      .then(stripMetadataSources);
    // Fold ONLY the attempt-0 (immediately-post-create) failure into the single
    // "Search created — re-run" recovery hint: right after create the search may
    // simply not be ready, so the raw 5xx is noise and the clean hint (matching
    // the pre-#1084 `flights search` UX) is what the user needs. A mid-settle
    // failure (attempt > 0) is different — the search was already returning
    // snapshots, so a later error is a genuine transient/upstream fault worth
    // surfacing with its real exit-code taxonomy + trace-id; let it propagate
    // unfolded (only the exit-code class/trace-id an operator needs to triage).
    // 401 always re-throws so the refresh path retries the read against the same
    // id. Per-vertical by design (recovery messaging is out of the unification
    // scope — issue #1084); hotels surfaces the taxonomy + a `createdRecoveryHint`.
    if (attempt > 0) return read;
    return read.catch((err: unknown) => {
      if (err instanceof UnauthorizedError) throw err;
      // `--wait` re-settles (preserving `search`'s block-to-settled contract);
      // a bare re-run is the single un-waited read.
      throw new Error(
        `Search created – re-run: ${PROG} flights results ${searchId} --wait`,
      );
    });
  },
  readResults(eng, searchId, token, query) {
    return eng.deps
      .fetchFlightResults(eng.config.apiBaseUrl, token, searchId, query)
      .then(stripMetadataSources)
      .catch(
        translateNotFound(
          `This search has expired or was not found – run \`${PROG} flights search\` again.`,
        ),
      );
  },
  searchNote(snapshot, searchId) {
    if (snapshot.results.length > 0) return undefined;
    return emptyFlightsNote(snapshot, searchId);
  },
  resultsNote(snapshot, searchId, state, wait) {
    if (wait && state === "budget_exhausted") {
      return `Results were still accruing after the re-read budget – re-run: ${PROG} flights results ${searchId} --wait`;
    }
    return snapshot.results.length === 0
      ? emptyFlightsNote(snapshot, searchId)
      : undefined;
  },
  createdRecoveryHint() {
    // Folded into readAfterCreate above (so only the one hint line prints).
    return undefined;
  },
};

// --- hotels ------------------------------------------------------------------

/** Authoritative "genuinely none": a COMPLETED search with an explicit zero
 *  candidate count. No `?? 0` fallback — an OMITTED count stays INDETERMINATE,
 *  never a no-match (issue #1113 review). The sole consumer is `hotelEmptyNote`
 *  (the empty-page message); the settle engine converges on `isComplete`, so
 *  this is deliberately NOT a `SettleSignals` accessor. */
function hotelIsNoMatch(snapshot: HotelsResultsResponse): boolean {
  return (
    snapshot.searchComplete === true && snapshot.metadata?.totalCandidates === 0
  );
}

/** stderr note for an empty hotels page. */
function hotelEmptyNote(
  snapshot: HotelsResultsResponse,
  searchId: string,
): string | undefined {
  const meta = snapshot.metadata;
  if (hotelIsNoMatch(snapshot)) {
    const before = meta?.totalBeforeFilters;
    if (before !== undefined && before > 0) {
      // Filters emptied a non-empty snapshot.
      return `Search complete – none of the ${before} hotels found match these filters. The hotels exist; the filters excluded them.`;
    }
    if (before === 0) {
      return "Search complete – no Book-on-Wego bookable hotels surfaced for these dates.";
    }
    return "Search complete – no hotels match these dates/filters.";
  }
  if (snapshot.searchComplete !== true) {
    // `--wait` re-settles the existing search; a bare re-run is the single
    // un-waited read, so it would only fetch one more still-settling snapshot.
    return `No hotels have settled yet – re-run: ${PROG} hotels results ${searchId} --wait`;
  }
  return undefined;
}

export const HOTELS: SearchVertical<
  HotelsResultsResponse,
  HotelsSearchBody,
  HotelResultsQuery,
  HotelsDeps
> = {
  signals: {
    count: (s) => s.metadata?.snapshotCandidateCount,
    hasItems: (s) => (s.results?.length ?? 0) > 0,
    isComplete: (s) => s.searchComplete === true,
    // No `isNoMatch` signal: a completed zero-candidate search is a no-match
    // *message*, not a distinct terminal state — the engine converges on
    // `isComplete`, and `hotelEmptyNote` (via `hotelIsNoMatch`) phrases it.
  },
  async create(eng, input): Promise<EngineOutcome<Created<HotelResultsQuery>>> {
    // Same four-rung site resolution as flights: explicit → stored setting →
    // account market → the API's US floor. And the same three-rung currency
    // resolution: explicit → stored setting → the API's USD default (issue #1400).
    const settings = await eng.deps.loadSettings();
    let siteSource: CliSiteSource = "default";
    const currency = resolveCliCurrency(input.currency, settings.currency);
    const created = await eng.withAccessToken((token, market) => {
      const resolved = resolveCliSite(input.siteCode, settings.site, market);
      siteSource = resolved.source;
      return eng.deps.createHotelSearch(eng.config.apiBaseUrl, token, {
        ...input,
        siteCode: resolved.siteCode,
        currency: currency.currency,
      });
    });
    if (!created.ok) return created;
    // Same resolved currency as the create, so the settle read is priced in the
    // unit the search was created in.
    const readQuery: HotelResultsQuery = {};
    if (currency.currency) readQuery.currency = currency.currency;
    if (input.locale) readQuery.locale = input.locale;
    // Surface the currency source (always: it labels the CLI's own resolution),
    // the create's echoed occupancy (resolved child ages incl. the age-8
    // fallback, issue #1114) + the site pair (atomically), when present.
    const extra: Record<string, unknown> = {
      currencyCodeSource: currency.source,
    };
    if (created.value.occupancy !== undefined) {
      extra.occupancy = created.value.occupancy;
    }
    if (created.value.siteCode !== undefined) {
      extra.siteCode = created.value.siteCode;
      extra.siteCodeSource = siteSource;
    }
    return {
      ok: true,
      value: { searchId: created.value.searchId, extra, readQuery },
    };
  },
  readAfterCreate(eng, searchId, token, query) {
    // Raw read: on failure `withAccessToken` prints the taxonomy message and
    // `runSearch` adds `createdRecoveryHint` (the id is still valid to re-poll).
    return eng.deps
      .fetchHotelResults(eng.config.apiBaseUrl, token, searchId, query)
      .then(stripMetadataSources);
  },
  readResults(eng, searchId, token, query) {
    return eng.deps
      .fetchHotelResults(eng.config.apiBaseUrl, token, searchId, query)
      .then(stripMetadataSources)
      .catch(
        translateNotFound(
          `Search expired – run \`${PROG} hotels search\` again.`,
        ),
      );
  },
  searchNote(snapshot, searchId) {
    return (snapshot.results?.length ?? 0) === 0
      ? hotelEmptyNote(snapshot, searchId)
      : undefined;
  },
  resultsNote(snapshot, searchId) {
    // Same empty-page guidance whether bare or `--wait` — the message keys off
    // the snapshot's own completion fields, not the settle mode.
    return (snapshot.results?.length ?? 0) === 0
      ? hotelEmptyNote(snapshot, searchId)
      : undefined;
  },
  createdRecoveryHint(searchId) {
    // `--wait` re-settles (preserving `search`'s block-to-settled contract);
    // a bare re-run is the single un-waited read.
    return `Search created – re-run: ${PROG} hotels results ${searchId} --wait`;
  },
};

// Re-export the shared state marker so consumers can import it alongside the
// verticals (kept here for convenient one-import access in commands.ts).
export type { SettleState };
