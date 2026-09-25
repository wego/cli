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
 * The two `SearchVertical` configs for the shared engine (`search-engine.ts`).
 * Each wraps its vertical's request wiring and declares its `SettleSignals`.
 * Whether the optional `isComplete` accessor is present is the main difference
 * between them:
 *
 * - HOTELS supplies it: `searchComplete` is an authoritative terminal.
 * - FLIGHTS omits it: the metasearch envelope has no completion flag, so it
 *   settles on `snapshotFareCount` alone (with item-presence as the fallback),
 *   and an empty flights page is never classified as "genuinely none".
 *
 * The hotels completed-zero-candidate no-match is phrased by `hotelEmptyNote`
 * rather than modelled as a settle signal: it changes the empty-page message,
 * not the terminal state.
 */

// The command name the user actually invoked (`wego` / `wegostaging` / renamed),
// so hints tell them what to type. Comments keep the literal `wego`.
const PROG = programName();

// --- flights ----------------------------------------------------------------

type FlightsSnapshot = FlightCardsResult;

/** The settle convergence signal. Only an older API that omits it yields
 *  `undefined`, which routes the settle to the item-presence fallback. */
function flightSnapshotCount(s: FlightsSnapshot): number | undefined {
  return s.metadata.snapshotFareCount;
}

/** An empty flights page is either "upstream has nothing yet" or "your filters
 *  excluded everything". `snapshotTripCount` is the only field that tells them
 *  apart, so the hint branches on it. */
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
  },
  async create(
    eng,
    input,
  ): Promise<EngineOutcome<Created<FlightResultsQuery>>> {
    // Resolve --site once: explicit → the stored `site` setting → id_token-derived
    // market (account) → nothing (the API floors to US). The source is reported
    // by the CLI because only the CLI knows a market came from a setting or was
    // derived. `--currency` is resolved here for the same reason: the command
    // merges only `locale` before the engine runs, so the currency's source is
    // still known here.
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
    // Read the first page in the search's currency/locale, not the API defaults,
    // so the settle read cannot come back in a different unit than the search
    // was priced in.
    const readQuery: FlightResultsQuery = {};
    if (currency.currency) readQuery.currency = currency.currency;
    if (input.locale) readQuery.locale = input.locale;
    // Emit the site pair together: an older API omits the echo, so drop both
    // rather than print an orphan source. The currency source needs no pair: it
    // labels what the CLI resolved, not something the API echoed back.
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
    // Only the attempt-0 (right after create) failure becomes the "Search
    // created, re-run" hint: the search may simply not be ready yet, so the raw
    // 5xx is noise. A mid-settle failure (attempt > 0) comes after the search
    // was already returning snapshots, so it is a real transient or upstream
    // fault and propagates with its exit code and trace id. A 401 always
    // re-throws so the refresh path retries the read against the same id.
    // Hotels handles this differently: it surfaces the error plus a
    // `createdRecoveryHint`.
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

/** Authoritative "genuinely none": a completed search with an explicit zero
 *  candidate count. No `?? 0` fallback: an omitted count stays indeterminate,
 *  never a no-match. It only shapes the empty-page message; the settle engine
 *  converges on `isComplete`, so this is not a `SettleSignals` accessor. */
function hotelIsNoMatch(snapshot: HotelsResultsResponse): boolean {
  return (
    snapshot.searchComplete === true && snapshot.metadata?.totalCandidates === 0
  );
}

function hotelEmptyNote(
  snapshot: HotelsResultsResponse,
  searchId: string,
): string | undefined {
  const meta = snapshot.metadata;
  if (hotelIsNoMatch(snapshot)) {
    const before = meta?.totalBeforeFilters;
    if (before !== undefined && before > 0) {
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
  },
  async create(eng, input): Promise<EngineOutcome<Created<HotelResultsQuery>>> {
    // Same site resolution as flights: explicit → stored setting → account
    // market → the API's US floor. Currency: explicit → stored setting → the
    // API's USD default.
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
    // The currency source is always present (it labels the CLI's own
    // resolution). The echoed occupancy (resolved child ages, including the
    // age-8 fallback) and the site pair are added when the API returns them.
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
    // Same guidance whether bare or `--wait`: the message keys off the
    // snapshot's own completion fields, not the settle mode.
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

export type { SettleState };
