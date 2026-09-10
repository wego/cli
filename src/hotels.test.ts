import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiHttpError, UnauthorizedError } from "./api";
import { type HotelsDeps, hotels } from "./commands";
import type { CliConfig } from "./config";
import { EXIT } from "./error-report";
import { refreshTokens } from "./oauth";
import type { UserSettings } from "./settings";
import { loadCredentials, saveCredentials } from "./storage";
import { loadTestCliConfig } from "./test-config";

/**
 * Behavioral tests for `wego hotels …` (issues #1041 + #1042). The API is a
 * local HTTP server (real network boundary); credentials are a real on-disk
 * seed. Assertions are on what a user/agent observes: exit code, stdout JSON,
 * stderr hints, and the requests the CLI actually makes (incl. the settle).
 */

const TOKEN = "tok-1";
const RATE_ID = "sid-1:hotels.wego.com:85481:abc123:7";

type Stub = { url: string; stop: () => void };
const running: Stub[] = [];

/** No socket is opened for `apps/api` any more, so the base URL only has to be the
 *  value the deps receive. */
const API = "https://api.wego.test";

/**
 * One call the CLI made into an `apps/api` dep (#1341).
 *
 * This suite used to drive a hand-written `Bun.serve` stand-in for `apps/api` and
 * assert on the HTTP requests it received. That fake could only fail when it
 * disagreed with itself — the defect #1328 exists to remove — and #1341 owns
 * collapsing it. The five api calls `hotels` already takes as deps are stubbed
 * instead, so the suite opens no socket and records what the CLI actually passed.
 *
 * `body` stays a JSON string: it is the create body the CLI built, serialized, so
 * the assertions that read it as text still read the thing they always did.
 */
interface Recorded {
  fn:
    | "create"
    | "results"
    | "details"
    | "rates"
    | "reviews"
    | "bookingLink"
    | "searchLink";
  token: string;
  body?: string;
  searchId?: string;
  hotelId?: number;
  rateId?: string;
  query?: Record<string, unknown>;
}

interface ApiOpts {
  /** Snapshot per results read, so a test drives the settle. */
  resultsFor?: (n: number) => unknown;
  /** Snapshot per rates read. */
  ratesFor?: (n: number) => unknown;
  /** Fail every results read with this status, as the API would. */
  resultsStatus?: number;
  /** Fail every rates read with this status. */
  ratesStatus?: number;
  /** The machine `code` on that failure, where a command branches on it. */
  ratesCode?: string;
  /**
   * Reject a call with `UnauthorizedError` — what `api.ts` raises on a 401 — so a
   * test can expire a token mid-settle and watch `withAccessToken` refresh and
   * retry. `reads` counts results reads so far, matching the old fake's counter.
   */
  unauthorized?: (call: {
    fn: string;
    token: string;
    reads: number;
  }) => boolean;
  /** Fail every reviews read with this status. */
  reviewsStatus?: number;
}

/** The echo contract 0.6.0 (#1522) put on every priced read, as the API really
 *  answers it: `explicit` for anything the request carried, a stored currency
 *  included. Both `*Source` copies are what the CLI strips at print time
 *  (#1400 for `localeSource`, #1534 for the rest); the echoes stay. */
const API_PRICED_ECHO = {
  currencyCode: "USD",
  currencyCodeSource: "explicit",
  locale: "en",
  localeSource: "explicit",
} as const;

const DEFAULT_RESULTS = {
  searchId: "sid-1",
  searchComplete: true,
  results: [{ hotelId: 1, name: "Grand Hyatt" }],
  metadata: {
    page: 1,
    pageSize: 10,
    resultCount: 1,
    totalCandidates: 1,
    hasMore: false,
    ...API_PRICED_ECHO,
  },
};
const DEFAULT_RATES = {
  hotelId: 85481,
  searchId: "sid-1",
  searchComplete: true,
  rates: [{ id: RATE_ID, roomName: "Classic", refundable: false }],
  metadata: { ...API_PRICED_ECHO },
};
const DEFAULT_DETAIL = { hotelId: 85481, name: "Grand Hyatt", star: 5 };
const DEFAULT_REVIEWS = {
  hotelId: 85481,
  results: [
    {
      rating: 9.2,
      postedAt: "2026-06-14",
      providerCode: "booking.com",
      guestType: "couple",
      pros: ["Breakfast spread was huge"],
      cons: [],
    },
  ],
  metadata: {
    page: 1,
    pageSize: 10,
    resultCount: 1,
    totalCandidates: 49,
    hasMore: true,
    topics: ["breakfast"],
    matchedTerms: ["breakfast", "Breakfast"],
  },
};
const DEFAULT_BOOKING_LINK = {
  bookingUrl: "https://www.wego.com/hotels/booking/checkout?search_id=sid-1",
};
const DEFAULT_SEARCH_LINK = {
  searchUrl:
    "https://www.wego.com/hotels/searches/bkk/2099-09-15/2099-09-17?guests=2&ulang=en",
  expires: false as const,
};

/**
 * An api that fails the test if any call reaches it.
 *
 * Replaces the old "point the config at an unreachable host" trick: a `--help` or
 * usage path that regressed into a real sub-command used to surface as a connection
 * failure, which is indirect. Now it names the call that should not have happened.
 */
function unreachableApi(): ReturnType<typeof hotelsApiStubs>["api"] {
  const boom = (fn: string) => (): never => {
    throw new Error(
      `${fn} must not be called: a usage or --help path reached the API`,
    );
  };
  return {
    createHotelSearch: boom("createHotelSearch"),
    fetchHotelResults: boom("fetchHotelResults"),
    fetchHotelDetails: boom("fetchHotelDetails"),
    fetchHotelRates: boom("fetchHotelRates"),
    fetchHotelReviews: boom("fetchHotelReviews"),
    fetchHotelBookingLink: boom("fetchHotelBookingLink"),
    fetchHotelSearchLink: boom("fetchHotelSearchLink"),
  } as unknown as ReturnType<typeof hotelsApiStubs>["api"];
}

/** The seven hotels api deps, programmable per read and recording every call. */
function hotelsApiStubs(opts: ApiOpts = {}): {
  api: Pick<
    HotelsDeps,
    | "createHotelSearch"
    | "fetchHotelResults"
    | "fetchHotelDetails"
    | "fetchHotelRates"
    | "fetchHotelReviews"
    | "fetchHotelBookingLink"
    | "fetchHotelSearchLink"
  >;
  recorded: Recorded[];
} {
  const recorded: Recorded[] = [];
  const counts = { results: 0, rates: 0 };

  /** Record, then apply the 401 rule the old fake expressed with a status code. */
  const enter = (call: Recorded): void => {
    recorded.push(call);
    if (
      opts.unauthorized?.({
        fn: call.fn,
        token: call.token,
        reads: counts.results,
      })
    ) {
      throw new UnauthorizedError();
    }
  };

  // Every stub is `async`, so an injected failure REJECTS the way the real
  // `api.ts` function does. A synchronous throw would skip the per-call
  // `.catch(translateNotFound(...))` the commands hang off the promise, and a
  // 404 would surface as a raw fault instead of the friendly exit-4 hint.
  return {
    recorded,
    api: {
      createHotelSearch: async (_base, token, body) => {
        enter({ fn: "create", token, body: JSON.stringify(body) });
        // The create echoes the priced occupancy (resolved child ages) the API
        // returns since #1114, so the CLI's surfacing of it is exercised, and
        // the market the search was created for (#1386), which is what `rooms`
        // reports as `siteCode`/`siteCodeSource`.
        const sent = (body as { siteCode?: string }).siteCode;
        return {
          searchId: "sid-1",
          occupancy: { adults: 2, childrenAges: [11], rooms: 1 },
          ...(sent === undefined ? {} : { siteCode: sent }),
        } as Awaited<ReturnType<HotelsDeps["createHotelSearch"]>>;
      },
      fetchHotelResults: async (_base, token, searchId, query) => {
        counts.results += 1;
        enter({ fn: "results", token, searchId, query });
        if (opts.resultsStatus) {
          throw new ApiHttpError(
            opts.resultsStatus,
            "GET /v1/hotels/searches/:searchId/results",
          );
        }
        return (opts.resultsFor?.(counts.results) ??
          DEFAULT_RESULTS) as Awaited<
          ReturnType<HotelsDeps["fetchHotelResults"]>
        >;
      },
      fetchHotelDetails: async (_base, token, hotelId, query) => {
        enter({ fn: "details", token, hotelId, query });
        return DEFAULT_DETAIL as Awaited<
          ReturnType<HotelsDeps["fetchHotelDetails"]>
        >;
      },
      fetchHotelRates: async (_base, token, hotelId, query) => {
        counts.rates += 1;
        enter({ fn: "rates", token, hotelId, query });
        if (opts.ratesStatus) {
          throw new ApiHttpError(
            opts.ratesStatus,
            "GET /v1/hotels/:hotelId/rates",
            opts.ratesCode === undefined ? {} : { code: opts.ratesCode },
          );
        }
        return (opts.ratesFor?.(counts.rates) ?? DEFAULT_RATES) as Awaited<
          ReturnType<HotelsDeps["fetchHotelRates"]>
        >;
      },
      fetchHotelReviews: async (_base, token, hotelId, query) => {
        enter({ fn: "reviews", token, hotelId, query });
        if (opts.reviewsStatus) {
          throw new ApiHttpError(
            opts.reviewsStatus,
            "GET /v1/hotels/:id/reviews",
          );
        }
        return DEFAULT_REVIEWS as Awaited<
          ReturnType<HotelsDeps["fetchHotelReviews"]>
        >;
      },
      fetchHotelBookingLink: async (_base, token, hotelId, rateId, query) => {
        enter({ fn: "bookingLink", token, hotelId, rateId, query });
        return DEFAULT_BOOKING_LINK;
      },
      fetchHotelSearchLink: async (_base, token, query) => {
        enter({ fn: "searchLink", token, query });
        return DEFAULT_SEARCH_LINK;
      },
    },
  };
}

let dir: string;
let credPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wego-hotels-"));
  credPath = join(dir, "credentials.json");
  await saveCredentials(credPath, {
    accessToken: TOKEN,
    expiresAt: Date.now() + 3_600_000,
  });
});
afterEach(async () => {
  while (running.length) running.pop()?.stop();
  await rm(dir, { recursive: true, force: true });
});

const sink = () => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    log: (m: string) => out.push(m),
    error: (m: string) => err.push(m),
  };
};

function config(apiUrl: string, asUrl?: string): CliConfig {
  return loadTestCliConfig({
    WEGO_CLI_CLIENT_ID: "cli-abc",
    WEGO_API_URL: apiUrl,
    WEGO_CREDENTIALS_PATH: credPath,
    // When an auth-server URL is given, point the token/authorize endpoints at
    // it so a reactive-401 refresh actually round-trips (the flights suite wires
    // this the same way; without it the CLI has no live token endpoint to hit).
    ...(asUrl
      ? {
          WEGO_AUTH_AUTHORIZE_URL: `${asUrl}/authorize`,
          WEGO_AUTH_TOKEN_URL: `${asUrl}/token`,
        }
      : {}),
  });
}

/** A bare local server (auth-aware handlers build their own responses). Pushed
 *  to `running` so `afterEach` stops it. */
function serve(handler: (req: Request) => Response | Promise<Response>): Stub {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
  const stub = { url: `http://127.0.0.1:${s.port}`, stop: () => s.stop(true) };
  running.push(stub);
  return stub;
}

/** A fake authorization server: only the `/token` endpoint the refresh calls. */
function authServer(token: () => Response): Stub {
  return serve((req) => {
    const url = new URL(req.url);
    if (url.pathname === "/token" && req.method === "POST") return token();
    return new Response("not found", { status: 404 });
  });
}

function deps(
  io: ReturnType<typeof sink>,
  api: ReturnType<typeof hotelsApiStubs>["api"],
  // Stored travel preferences (issue #1386); none by default, which is the
  // fresh-machine state every pre-existing test here was written against.
  settings: UserSettings = {},
): HotelsDeps {
  return {
    log: io.log,
    error: io.error,
    loadCredentials,
    saveCredentials,
    refreshTokens,
    loadSettings: async () => settings,
    recordAuthFailure: async () => {},
    ...api,
    sleep: () => Promise.resolve(),
  };
}

const lastJson = (io: ReturnType<typeof sink>) =>
  JSON.parse(io.out.at(-1) ?? "null");

describe("wego hotels search", () => {
  it("creates the search then prints the first page (stdout is valid JSON)", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      ["search", "DXB", "2099-03-01", "2099-03-05"],
      deps(io, api),
    );
    expect(code).toBe(0);
    const post = recorded.find((r) => r.fn === "create");
    expect(post?.body).toContain("DXB");
    const printed = lastJson(io);
    expect(printed.results[0].name).toBe("Grand Hyatt");
    // The one stderr line on a fresh machine is the currency-setting hint the
    // search prints while no currency is stored (issue #1386).
    expect(io.err).toEqual([expect.stringContaining("config set currency")]);
  });

  it("names the layer the CURRENCY came from, over all three rungs", async () => {
    // Issue #1400, the hotels half of the same stamp `flights search` makes. The
    // create and the settle read must carry the SAME resolved currency: that is
    // the invariant the old merge-before-create protected, and resolving the
    // currency inside the vertical must not drop it.
    const rung = async (settings: UserSettings, extraArgs: string[]) => {
      const { api, recorded } = hotelsApiStubs();
      const io = sink();
      const code = await hotels(
        config(API),
        ["search", "DXB", "2099-03-01", "2099-03-05", ...extraArgs],
        deps(io, api, settings),
      );
      expect(code).toBe(0);
      const body = JSON.parse(
        recorded.find((r) => r.fn === "create")?.body ?? "{}",
      ) as { currency?: string };
      return {
        source: lastJson(io).currencyCodeSource,
        created: body.currency,
        read: (
          recorded.find((r) => r.fn === "results")?.query as
            | { currency?: string }
            | undefined
        )?.currency,
      };
    };

    expect(await rung({ currency: "SAR" }, ["--currency", "USD"])).toEqual({
      source: "explicit",
      created: "USD",
      read: "USD",
    });
    expect(await rung({ currency: "SAR" }, [])).toEqual({
      source: "setting",
      created: "SAR",
      read: "SAR",
    });
    // Neither rung supplies one, so the request carries no currency and the API's
    // USD default decides — which the label reports rather than leaving implied.
    expect(await rung({}, [])).toEqual({
      source: "default",
      created: undefined,
      read: undefined,
    });
  });

  it("results and both rooms forms name the rung too, not only search", async () => {
    // A `results` page re-prices, and `rooms` is where a room rate is quoted, so
    // each decides its own unit and each owes the label (#1400). `rooms` reports
    // it on BOTH forms - unlike the market, which only the minting form decides.
    const sourceOf = async (argv: string[], settings: UserSettings) => {
      const { api } = hotelsApiStubs();
      const io = sink();
      expect(await hotels(config(API), argv, deps(io, api, settings))).toBe(0);
      return lastJson(io).currencyCodeSource;
    };

    expect(await sourceOf(["results", "sid-1"], { currency: "SAR" })).toBe(
      "setting",
    );
    expect(
      await sourceOf(["results", "sid-1", "--currency", "USD"], {
        currency: "SAR",
      }),
    ).toBe("explicit");
    expect(await sourceOf(["results", "sid-1"], {})).toBe("default");

    // The --search form reuses a search and mints nothing.
    expect(
      await sourceOf(["rooms", "85481", "--search", "sid-1"], {
        currency: "SAR",
      }),
    ).toBe("setting");
    // The scoped form mints its own search.
    expect(
      await sourceOf(
        [
          "rooms",
          "85481",
          "--check-in",
          "2099-03-01",
          "--check-out",
          "2099-03-05",
        ],
        { currency: "SAR" },
      ),
    ).toBe("setting");
  });

  it("the minted rooms search and its rates read go out in ONE currency", async () => {
    // The invariant `applyPreferences` held by filling both from the same file.
    // Resolving the rung moved that decision earlier, so it is pinned here: a
    // create in SAR feeding a rates read in USD prices the room twice.
    const { api, recorded } = hotelsApiStubs();
    expect(
      await hotels(
        config(API),
        [
          "rooms",
          "85481",
          "--check-in",
          "2099-03-01",
          "--check-out",
          "2099-03-05",
        ],
        deps(sink(), api, { currency: "SAR" }),
      ),
    ).toBe(0);
    const created = JSON.parse(
      recorded.find((r) => r.fn === "create")?.body ?? "{}",
    ) as { currency?: string };
    const rates = recorded.find((r) => r.fn === "rates")?.query as
      | { currency?: string }
      | undefined;
    expect(created.currency).toBe("SAR");
    expect(rates?.currency).toBe("SAR");
  });

  it("every priced read prints ONE *Source per knob, top level, CLI vocabulary (hotels four of the eight)", async () => {
    // The #1534 rule (decision Q2: "strip"), hotels half — the flights half is
    // pinned in `commands.test.ts`. The API's request-scoped copies inside
    // `metadata` are stripped at print time, so the CLI's own top-level label
    // (`setting` here, a rung the API cannot see) is the ONE `*Source` a
    // payload carries per knob. The `currencyCode` / `locale` echoes stay.
    for (const argv of [
      ["search", "DXB", "2099-03-01", "2099-03-05"],
      ["results", "sid-1"],
      ["rooms", "85481", "--search", "sid-1"],
      [
        "rooms",
        "85481",
        "--check-in",
        "2099-03-01",
        "--check-out",
        "2099-03-05",
      ],
    ]) {
      const { api } = hotelsApiStubs();
      const io = sink();
      expect(
        await hotels(config(API), argv, deps(io, api, { currency: "SAR" })),
      ).toBe(0);
      const which = argv.join(" ");
      const printed = io.out.at(-1) ?? "";
      expect(printed, which).not.toContain("localeSource");
      expect(printed, which).toContain('"locale": "en"');
      const parsed = JSON.parse(printed) as {
        currencyCodeSource: string;
        metadata?: Record<string, unknown>;
      };
      expect(parsed.currencyCodeSource, which).toBe("setting");
      expect(printed.split('"currencyCodeSource"').length - 1, which).toBe(1);
      expect(
        Object.keys(parsed.metadata ?? {}).filter((k) => k.endsWith("Source")),
        which,
      ).toEqual([]);
    }
  });

  it("accepts --children 0 (forwards an explicit zero, not a positive-int error)", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      ["search", "DXB", "2099-03-01", "2099-03-05", "--children", "0"],
      deps(io, api),
    );
    expect(code).toBe(0);
    const post = recorded.find((r) => r.fn === "create");
    expect(post?.body).toContain('"children":0');
    // The one stderr line on a fresh machine is the currency-setting hint the
    // search prints while no currency is stored (issue #1386).
    expect(io.err).toEqual([expect.stringContaining("config set currency")]);
  });

  it("settles: re-reads while empty, stops when results appear", async () => {
    const { api, recorded } = hotelsApiStubs({
      resultsFor: (n) =>
        n < 2
          ? {
              searchId: "sid-1",
              searchComplete: false,
              results: [],
              metadata: {},
            }
          : {
              searchId: "sid-1",
              searchComplete: true,
              results: [{ hotelId: 1, name: "Later Hotel" }],
              metadata: {},
            },
    });
    const io = sink();
    await hotels(
      config(API),
      ["search", "DXB", "2099-03-01", "2099-03-05"],
      deps(io, api),
    );
    const resultReads = recorded.filter((r) => r.fn === "results").length;
    expect(resultReads).toBe(2);
    expect(lastJson(io).results[0].name).toBe("Later Hotel");
  });

  it("converges on snapshotCandidateCount stabilizing even while searchComplete stays false (issue #1084)", async () => {
    // The core #1113/#1084 fix: `searchComplete` stays false for most of a
    // search's life, but the candidate count stabilizes far sooner. The settle
    // must key off the count, not wait out `searchComplete`.
    const { api, recorded } = hotelsApiStubs({
      resultsFor: (n) => ({
        searchId: "sid-1",
        searchComplete: false, // never flips – the settle must not depend on it
        results: [{ hotelId: 1, name: "Hotel A" }],
        // count grows on read 1, then holds equal on reads 2 & 3 → converged.
        metadata: { snapshotCandidateCount: n === 1 ? 4 : 7 },
      }),
    });
    const io = sink();
    const code = await hotels(
      config(API),
      ["search", "DXB", "2099-03-01", "2099-03-05"],
      deps(io, api),
    );
    expect(code).toBe(0);
    // read1 count=4, read2 count=7, read3 count=7 (== read2) → stop at read 3.
    const resultReads = recorded.filter((r) => r.fn === "results").length;
    expect(resultReads).toBe(3);
    expect(lastJson(io).settled).toBe("converged");
    expect(lastJson(io).searchComplete).toBe(false);
  });

  it("stamps an honest `settled` marker on the search snapshot (issue #1084)", async () => {
    // DEFAULT_RESULTS is searchComplete:true → converged on the first read.
    const { api } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      ["search", "DXB", "2099-03-01", "2099-03-05"],
      deps(io, api),
    );
    expect(code).toBe(0);
    expect(lastJson(io).settled).toBe("converged");
  });

  it("stops early on searchComplete even with zero results", async () => {
    const { api, recorded } = hotelsApiStubs({
      resultsFor: () => ({
        searchId: "sid-1",
        searchComplete: true,
        results: [],
        metadata: {},
      }),
    });
    const io = sink();
    await hotels(
      config(API),
      ["search", "DXB", "2099-03-01", "2099-03-05"],
      deps(io, api),
    );
    expect(recorded.filter((r) => r.fn === "results").length).toBe(1);
    // searchComplete:true + empty is definitive, so the "keep polling" hint is
    // suppressed (would otherwise mislead agents/users into re-running).
    expect(io.err.join("")).not.toContain("No hotels have settled yet");
  });

  it("prints a 'not settled yet' stderr hint when the page stays empty", async () => {
    // Settle exhausts with an empty, still-aggregating snapshot (searchComplete
    // false): exit 0 + JSON on stdout, but a re-poll hint on stderr so an agent
    // reading only exit-code + stdout doesn't treat it as a definitive result.
    const { api, recorded } = hotelsApiStubs({
      resultsFor: () => ({
        searchId: "sid-1",
        searchComplete: false,
        results: [],
        metadata: {},
      }),
    });
    const io = sink();
    const code = await hotels(
      config(API),
      ["search", "DXB", "2099-03-01", "2099-03-05"],
      deps(io, api),
    );
    expect(code).toBe(0);
    expect(io.err.join("")).toContain(
      "No hotels have settled yet – re-run: wego hotels results sid-1 --wait",
    );
  });

  it("reports an authoritative no-match (not a 'still settling' hint) on a completed empty search", async () => {
    // searchComplete:true AND totalCandidates:0 is a definitive no-match — the
    // "re-run, still settling" hint would contradict it (issue #1113 review).
    const { api } = hotelsApiStubs({
      resultsFor: () => ({
        searchId: "sid-1",
        searchComplete: true,
        results: [],
        metadata: { totalCandidates: 0 },
      }),
    });
    const io = sink();
    const code = await hotels(
      config(API),
      ["search", "DXB", "2099-03-01", "2099-03-05"],
      deps(io, api),
    );
    expect(code).toBe(0);
    const err = io.err.join("");
    expect(err).toContain("no hotels match");
    expect(err).not.toContain("No hotels have settled yet");
  });

  it("says the FILTERS emptied it, not that no hotels exist", async () => {
    const { api } = hotelsApiStubs({
      resultsFor: () => ({
        searchId: "sid-1",
        searchComplete: true,
        results: [],
        metadata: { totalCandidates: 0, totalBeforeFilters: 415 },
      }),
    });
    const io = sink();
    const code = await hotels(
      config(API),
      ["search", "DXB", "2099-03-01", "2099-03-05"],
      deps(io, api),
    );
    expect(code).toBe(0);
    const err = io.err.join("");
    expect(err).toContain("none of the 415 hotels found match these filters");
    expect(err).toContain("the filters excluded them");
  });

  it("claims no bookable inventory only when nothing survived the join", async () => {
    const { api } = hotelsApiStubs({
      resultsFor: () => ({
        searchId: "sid-1",
        searchComplete: true,
        results: [],
        metadata: { totalCandidates: 0, totalBeforeFilters: 0 },
      }),
    });
    const io = sink();
    const code = await hotels(
      config(API),
      ["search", "DXB", "2099-03-01", "2099-03-05"],
      deps(io, api),
    );
    expect(code).toBe(0);
    expect(io.err.join("")).toContain(
      "no Book-on-Wego bookable hotels surfaced",
    );
  });

  it("prints no still-settling hint on a completed empty PAGE over existing candidates (paged past the end)", async () => {
    // searchComplete:true but totalCandidates>0 → an empty page is pagination,
    // not a no-match and not still-settling, so neither hint fires.
    const { api } = hotelsApiStubs({
      resultsFor: () => ({
        searchId: "sid-1",
        searchComplete: true,
        results: [],
        metadata: { totalCandidates: 12 },
      }),
    });
    const io = sink();
    const code = await hotels(
      config(API),
      ["search", "DXB", "2099-03-01", "2099-03-05"],
      deps(io, api),
    );
    expect(code).toBe(0);
    const err = io.err.join("");
    expect(err).not.toContain("No hotels have settled yet");
    expect(err).not.toContain("no hotels match");
  });

  it("stays indeterminate (no no-match claim) on a completed empty search whose count is MISSING or malformed", async () => {
    // A completed response with totalCandidates omitted (legacy API) or invalid
    // must NOT be reported as a zero-candidate no-match (issue #1113 review):
    // no `?? 0` fallback, and a fractional/negative count degrades to undefined.
    for (const metadata of [
      {}, // count omitted
      { totalCandidates: -1 }, // negative → degrades to undefined via .catch
      { totalCandidates: 2.5 }, // fractional → degrades to undefined via .catch
    ]) {
      const { api } = hotelsApiStubs({
        resultsFor: () => ({
          searchId: "sid-1",
          searchComplete: true,
          results: [],
          metadata,
        }),
      });
      const io = sink();
      const code = await hotels(
        config(API),
        ["search", "DXB", "2099-03-01", "2099-03-05"],
        deps(io, api),
      );
      expect(code).toBe(0);
      // Indeterminate: neither an authoritative no-match nor a false no-match.
      expect(io.err.join("")).not.toContain("no hotels match");
    }
  });

  it("degrades a malformed snapshotCandidateCount to undefined (settle never trusts it as a count)", async () => {
    // Parity with the totalCandidates test above: the convergence signal
    // (metadata.snapshotCandidateCount, issue #1084) is `.int().nonnegative()
    // .optional().catch(undefined)`, so a negative, fractional, non-numeric, or
    // null value degrades to undefined → the settle falls back to item-presence,
    // never converging on a bogus count and never throwing on a non-numeric value.
    // The `.catch(undefined)` that drops a malformed count lives in `api.ts`'s
    // response schema, so it is asserted there (`api.test.ts` → "drops a malformed
    // snapshotCandidateCount"). What belongs here is the consequence: with no count
    // to trust, the settle falls back to item-presence and still converges.
    const { api } = hotelsApiStubs({
      resultsFor: () => ({
        searchId: "sid-1",
        searchComplete: false,
        results: [{ hotelId: 1, name: "Grand Hyatt" }],
        metadata: {},
      }),
    });
    const io = sink();
    const code = await hotels(
      config(API),
      ["results", "sid-1", "--wait"],
      deps(io, api),
    );
    expect(code).toBe(0);
    expect(lastJson(io).metadata.snapshotCandidateCount).toBeUndefined();
    expect(lastJson(io).settled).toBe("converged");
  });

  it("preserves the searchId with a re-poll hint when the settle read fails", async () => {
    // Create succeeds (201 + searchId) but the immediate results read 5xxs;
    // the id must survive as a `wego hotels results <searchId>` re-run hint.
    const { api, recorded } = hotelsApiStubs({ resultsStatus: 503 });
    const io = sink();
    const code = await hotels(
      config(API),
      ["search", "DXB", "2099-03-01", "2099-03-05"],
      deps(io, api),
    );
    expect(code).toBe(5); // retryable upstream failure (503)
    expect(recorded.some((r) => r.fn === "create")).toBe(true);
    expect(io.err.join("")).toContain("re-run: wego hotels results sid-1");
  });

  it("rejects a bad location before any network call", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      ["search", "not-a-place", "2099-03-01", "2099-03-05"],
      deps(io, api),
    );
    expect(code).toBe(2); // usage error (bad location, no network)
    expect(recorded.length).toBe(0);
    expect(io.err.join("")).toContain("Invalid location");
  });
});

describe("wego hotels results", () => {
  it("re-polls with paging/sort forwarded", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      [
        "results",
        "sid-1",
        "--page",
        "2",
        "--sort",
        "price_asc",
        "--min-star",
        "4",
      ],
      deps(io, api),
    );
    expect(code).toBe(0);
    const read = recorded.find((r) => r.fn === "results");
    expect(read?.query?.page).toBe("2");
    expect(read?.query?.sort).toBe("price_asc");
    expect(read?.query?.["min-star"]).toBe("4");
  });

  it("forwards --refundable as the refundable filter param (issue #1115)", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      ["results", "sid-1", "--refundable", "true"],
      deps(io, api),
    );
    expect(code).toBe(0);
    const read = recorded.find((r) => r.fn === "results");
    expect(read?.query?.refundable).toBe("true");
  });

  // The expired-search 404 moved to `hotels-e2e.test.ts` (issue #1340): there it
  // runs against the 404 the upstream really sends for a stale searchId, recorded,
  // rather than against a status this fake chose to return.

  it("without --wait: a single read (no client-side settle)", async () => {
    const { api, recorded } = hotelsApiStubs({
      // Even if the first page is empty+incomplete, a plain read does NOT re-poll.
      resultsFor: () => ({
        searchId: "sid-1",
        searchComplete: false,
        results: [],
        metadata: {},
      }),
    });
    const io = sink();
    const code = await hotels(config(API), ["results", "sid-1"], deps(io, api));
    expect(code).toBe(0);
    expect(recorded.filter((r) => r.fn === "results").length).toBe(1);
    // A bare read is a single, un-waited snapshot → stamped `unsettled` so an
    // empty page is never mistaken for a definitive no-results (issue #1084).
    expect(lastJson(io).settled).toBe("unsettled");
  });

  it("--wait re-reads while empty, stops when results appear (CLI-5 symmetry)", async () => {
    const { api, recorded } = hotelsApiStubs({
      resultsFor: (n) =>
        n < 2
          ? {
              searchId: "sid-1",
              searchComplete: false,
              results: [],
              metadata: {},
            }
          : {
              searchId: "sid-1",
              searchComplete: true,
              results: [{ hotelId: 1, name: "Later Hotel" }],
              metadata: {},
            },
    });
    const io = sink();
    const code = await hotels(
      config(API),
      ["results", "sid-1", "--wait"],
      deps(io, api),
    );
    expect(code).toBe(0);
    expect(recorded.filter((r) => r.fn === "results").length).toBe(2);
    expect(lastJson(io).results[0].name).toBe("Later Hotel");
    expect(io.err.length).toBe(0);
  });

  it("--wait: a 401 mid-settle refreshes once and restarts the whole poll (parity with flights)", async () => {
    // Mirror of the flights `results --wait` 401-mid-settle test: the whole
    // hotels settle runs inside ONE withAccessToken call, which retries its
    // entire callback once on a 401. So a token expiry partway through the
    // count-convergence re-reads restarts the poll from read #1 against the same
    // searchId — correctness-safe (reads are idempotent), it just re-walks the
    // sequence on the fresh token.
    await saveCredentials(credPath, {
      accessToken: "tok-1",
      refreshToken: "rt",
      expiresAt: Date.now() + 3_600_000, // valid → only a reactive 401 refreshes
    });
    const as = authServer(() => Response.json({ access_token: "fresh" }));
    const { api, recorded } = hotelsApiStubs({
      // 0 on the first read, then 2 — so the count can only hold equal across two
      // reads after the restart.
      resultsFor: (n) => ({
        searchId: "sid-1",
        searchComplete: false, // never flips; the settle keys on the count
        results: [{ hotelId: 1, name: "Grand Hyatt" }],
        metadata: { snapshotCandidateCount: n === 1 ? 0 : 2 },
      }),
      // "tok-1" expires on its third read, mid-settle. `api.ts` raises
      // `UnauthorizedError` on a 401, which is what the dep does here.
      unauthorized: ({ fn, token, reads }) =>
        fn === "results" && token === "tok-1" && reads >= 3,
    });
    const io = sink();
    const code = await hotels(
      config(API, as.url),
      ["results", "sid-1", "--wait"],
      deps(io, api),
    );
    expect(code).toBe(0);
    // The restarted poll converges once the count holds equal on "fresh".
    expect(lastJson(io).settled).toBe("converged");
    expect(lastJson(io).metadata.snapshotCandidateCount).toBe(2);
    const reads = recorded.filter((r) => r.fn === "results");
    // Reads before the 401 count toward the total: the restart re-walks read #1.
    expect(reads.length).toBeGreaterThan(3);
    // And the reads that converged are the ones on the refreshed token — the old
    // HTTP fake could only show that the request succeeded, not which token carried
    // it, because the header never reached an assertion.
    expect(
      reads.filter((r) => r.token === "fresh").length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("--wait prints a 'not settled yet' stderr hint when the page stays empty (stdout stays JSON)", async () => {
    const { api, recorded } = hotelsApiStubs({
      resultsFor: () => ({
        searchId: "sid-1",
        searchComplete: false,
        results: [],
        metadata: {},
      }),
    });
    const io = sink();
    const code = await hotels(
      config(API),
      ["results", "sid-1", "--wait"],
      deps(io, api),
    );
    expect(code).toBe(0);
    // stdout is still a single parseable JSON object, honestly stamped as a
    // spent-budget settle so an empty page is not read as a definitive result.
    expect(lastJson(io).results).toEqual([]);
    expect(lastJson(io).settled).toBe("budget_exhausted");
    expect(io.err.join("")).toContain(
      "No hotels have settled yet – re-run: wego hotels results sid-1 --wait",
    );
  });

  it("--wait suppresses the re-run hint on a completed empty snapshot (searchComplete:true is definitive)", async () => {
    // searchComplete:true with a steady count converges, so the empty page is definitive
    const { api, recorded } = hotelsApiStubs({
      resultsFor: () => ({
        searchId: "sid-1",
        searchComplete: true,
        results: [],
        metadata: {},
      }),
    });
    const io = sink();
    const code = await hotels(
      config(API),
      ["results", "sid-1", "--wait"],
      deps(io, api),
    );
    expect(code).toBe(0);
    expect(lastJson(io).results).toEqual([]);
    expect(io.err.join("")).not.toContain("No hotels have settled yet");
  });

  it("rejects --wait=value (the bool flag takes no value, exit 2)", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      ["results", "sid-1", "--wait=1"],
      deps(io, api),
    );
    expect(code).toBe(2);
    expect(recorded.length).toBe(0);
    expect(io.err.join("")).toContain("--wait takes no value");
  });

  // Client-side guards mirroring flights: the same typo that flights catches
  // locally (exit 2) must not round-trip to the API's 400 → exit 6 here (CLI-1).
  it("rejects a non-numeric --page locally (exit 2, no network call)", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      ["results", "sid-1", "--page", "abc"],
      deps(io, api),
    );
    expect(code).toBe(2);
    expect(recorded.length).toBe(0);
    expect(io.err.join("")).toContain("--page must be a positive integer");
  });

  it("rejects an out-of-range --page-size locally (exit 2, mirrors API max 50)", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      ["results", "sid-1", "--page-size", "500"],
      deps(io, api),
    );
    expect(code).toBe(2);
    expect(recorded.length).toBe(0);
    expect(io.err.join("")).toContain("--page-size must be between 1 and 50");
  });

  it("rejects an unknown --sort value locally (exit 2, no network call)", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      ["results", "sid-1", "--sort", "cheapest"],
      deps(io, api),
    );
    expect(code).toBe(2);
    expect(recorded.length).toBe(0);
    expect(io.err.join("")).toContain("--sort must be one of");
  });

  // foundations#87, raised in review: the guest-cohort flags had no local
  // coverage, so the sort the help advertises and the validation that guards the
  // cohort were both unpinned.
  it("forwards --sort guest_rating_desc with --guest-type as both query keys", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      [
        "results",
        "sid-1",
        "--sort",
        "guest_rating_desc",
        "--guest-type",
        "family",
        "--min-guest-rating",
        "8.5",
      ],
      deps(io, api),
    );
    expect(code).toBe(0);
    const q = recorded[0]?.query;
    // The sort is registered locally as well as published - it used to be
    // advertised in the help while HOTEL_SORTS rejected it before any call.
    expect(q?.sort).toBe("guest_rating_desc");
    expect(q?.["guest-type"]).toBe("family");
    expect(q?.["min-guest-rating"]).toBe("8.5");
  });

  it("rejects an unknown --guest-type locally (exit 2, no network call)", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      // The /reviews spelling: valid on that command, not on this one.
      ["results", "sid-1", "--guest-type", "family_with_children"],
      deps(io, api),
    );
    expect(code).toBe(2);
    expect(recorded.length).toBe(0);
    expect(io.err.join("")).toContain("--guest-type must be one of");
  });

  it("rejects a --min-guest-rating outside 0-10, and a non-numeric one (exit 2)", async () => {
    // A bare `--min-guest-rating` with no value is a different guard entirely
    // ("requires a value"), so it is not in this list - these are the shapes that
    // LOOK like a value and are not one.
    for (const bad of ["abc", "-1", "11", "Infinity"]) {
      const { api, recorded } = hotelsApiStubs();
      const io = sink();
      const code = await hotels(
        config(API),
        [
          "results",
          "sid-1",
          "--guest-type",
          "family",
          "--min-guest-rating",
          bad,
        ],
        deps(io, api),
      );
      expect(code).toBe(2);
      // The point of the local check: no request is spent to be told this.
      expect(recorded.length).toBe(0);
      expect(io.err.join("")).toContain(
        "--min-guest-rating must be a number between 0 and 10",
      );
    }
  });

  it("rejects --view at all: the results read has one projection (issue #1308)", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      // `card` was the one legal value before #1308 - the flag itself is gone now,
      // so the once-valid value is rejected too.
      ["results", "sid-1", "--view", "card"],
      deps(io, api),
    );
    expect(code).toBe(2);
    expect(recorded.length).toBe(0);
    expect(io.err.join("")).toContain("Unknown option: --view");
  });

  it("rejects a non-boolean --refundable locally (exit 2, no network call)", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      ["results", "sid-1", "--refundable", "yes"],
      deps(io, api),
    );
    expect(code).toBe(2);
    expect(recorded.length).toBe(0);
    expect(io.err.join("")).toContain("--refundable must be one of");
  });

  it("rejects an extra positional argument locally (exit 2, no network call)", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      ["results", "sid-1", "extra"],
      deps(io, api),
    );
    expect(code).toBe(2);
    expect(recorded.length).toBe(0);
    expect(io.err.join("")).toContain("Unexpected argument: extra");
  });
});

describe("wego hotels details", () => {
  // The happy-path detail read and the unknown-hotel 404 both live in
  // `hotels-e2e.test.ts` (issues #1340, #1341), against the real recorded body.

  it("rejects an unknown --view value locally (exit 2, prints the message – no swallow, CLI-3)", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      ["details", "85481", "--view", "summary"],
      deps(io, api),
    );
    expect(code).toBe(2); // usage: default|detail guarded before the network call
    expect(recorded.length).toBe(0);
    // The parse error is now printed (was swallowed to bare usage before CLI-3).
    expect(io.err.join("")).toContain("--view must be one of");
  });

  it("surfaces a bad hotelId's explanation instead of swallowing it to bare usage (CLI-3)", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      ["details", "not-a-number"],
      deps(io, api),
    );
    expect(code).toBe(2);
    expect(recorded.length).toBe(0);
    expect(io.err.join("")).toContain("hotelId must be a positive integer");
  });

  it("rejects an extra positional argument locally (exit 2, no network call)", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      ["details", "85481", "extra"],
      deps(io, api),
    );
    expect(code).toBe(2);
    expect(recorded.length).toBe(0);
    expect(io.err.join("")).toContain("Unexpected argument: extra");
  });

  it("reports the extra-positional error before an invalid id (structural error wins, matches hotels results)", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      ["details", "abc", "extra"],
      deps(io, api),
    );
    expect(code).toBe(2);
    expect(recorded.length).toBe(0);
    // The too-many-args error is surfaced, not masked by the bad-hotelId error.
    expect(io.err.join("")).toContain("Unexpected argument: extra");
    expect(io.err.join("")).not.toContain("hotelId must be a positive integer");
  });
});

describe("wego hotels reviews", () => {
  it("prints the review page (stdout is valid JSON)", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(config(API), ["reviews", "85481"], deps(io, api));
    expect(code).toBe(0);
    expect(recorded[0]?.fn).toBe("reviews");
    expect(recorded[0]?.hotelId).toBe(85481);
    expect(lastJson(io).metadata.totalCandidates).toBe(49);
    expect(io.err.join("")).toBe("");
  });

  it("forwards each flag under its published parameter name", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      [
        "reviews",
        "85481",
        "--topics",
        "breakfast,pool",
        "--guest-type",
        "couple",
        "--sort",
        "rating_desc",
        "--page-size",
        "20",
        "--view",
        "detail",
      ],
      deps(io, api),
    );
    expect(code).toBe(0);
    const q = recorded[0]?.query;
    expect(q?.topics).toBe("breakfast,pool");
    // Kebab for the net-new knob, camel for the mirrored one - one request
    // legitimately carries both spellings.
    expect(q?.["guest-type"]).toBe("couple");
    expect(q?.pageSize).toBe("20");
    expect(q?.sort).toBe("rating_desc");
    expect(q?.view).toBe("detail");
  });

  it("rejects an empty --topics locally, before any request (exit 2)", async () => {
    // The API splits this on commas and needs one non-empty term, so `,` reached
    // it as an empty list and 400'd - exit 6 with the round trip already paid,
    // where every sibling flag exits 2 locally.
    for (const value of [",", " ", ",,"]) {
      const io = sink();
      const code = await hotels(
        config(API),
        ["reviews", "85481", "--topics", value],
        deps(io, unreachableApi()),
      );
      expect(code).toBe(2);
      expect(io.err.join("")).toContain("--topics needs at least one");
    }
  });

  it("trims the topics it forwards, so a stray comma costs no request", async () => {
    const { api, recorded } = hotelsApiStubs();
    const code = await hotels(
      config(API),
      ["reviews", "85481", "--topics", " breakfast , ,pool "],
      deps(sink(), api),
    );
    expect(code).toBe(0);
    expect(recorded[0]?.query?.topics).toBe("breakfast,pool");
  });

  it("rejects a bad enum locally, before any request (exit 2)", async () => {
    for (const args of [
      ["--sort", "newest"],
      ["--guest-type", "business"],
      ["--view", "full"],
    ]) {
      const io = sink();
      const code = await hotels(
        config(API),
        ["reviews", "85481", ...args],
        deps(io, unreachableApi()),
      );
      expect(code).toBe(2);
      expect(io.err.join("")).toContain(`${args[0]} must be one of`);
    }
  });

  it("rejects an out-of-range --page-size rather than clamping it", async () => {
    const io = sink();
    const code = await hotels(
      config(API),
      ["reviews", "85481", "--page-size", "500"],
      deps(io, unreachableApi()),
    );
    expect(code).toBe(2);
  });

  it("prints an unknown-hotel hint on 404 (exit 4 not_found)", async () => {
    const { api } = hotelsApiStubs({ reviewsStatus: 404 });
    const io = sink();
    const code = await hotels(
      config(API),
      ["reviews", "999999"],
      deps(io, api),
    );
    expect(code).toBe(4);
    expect(io.err.join("")).toContain("Unknown hotel id");
  });

  it("prints its own scoped usage on --help (exit 0, stdout)", async () => {
    const io = sink();
    const code = await hotels(
      config(API),
      ["reviews", "--help"],
      deps(io, unreachableApi()),
    );
    expect(code).toBe(0);
    expect(io.out.join("")).toContain("hotels reviews <hotelId>");
  });

  it("surfaces a bad hotelId's explanation rather than bare usage", async () => {
    const io = sink();
    const code = await hotels(
      config(API),
      ["reviews", "not-a-number"],
      deps(io, unreachableApi()),
    );
    expect(code).toBe(2);
    expect(io.err.join("")).toContain("hotelId must be a positive integer");
  });
});

describe("wego hotels rooms", () => {
  it("with --search: settles the rates read (no create)", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      ["rooms", "85481", "--search", "sid-1"],
      deps(io, api),
    );
    expect(code).toBe(0);
    expect(recorded.some((r) => r.fn === "create")).toBe(false);
    expect(recorded.filter((r) => r.fn === "rates").length).toBe(4);
    expect(lastJson(io).rates[0].id).toBe(RATE_ID);
    expect(lastJson(io).settled).toBe("converged");
  });

  it("keeps reading while the rate count grows, even past searchComplete:true", async () => {
    const page = (rates: unknown[]) => ({
      hotelId: 85481,
      searchId: "sid-1",
      searchComplete: true,
      rates,
    });
    const one = [{ id: "r-1" }];
    const three = [{ id: "r-1" }, { id: "r-2" }, { id: RATE_ID }];
    const { api, recorded } = hotelsApiStubs({
      ratesFor: (n) => page(n === 1 ? one : three),
    });
    const io = sink();
    const code = await hotels(
      config(API),
      ["rooms", "85481", "--search", "sid-1"],
      deps(io, api),
    );
    expect(code).toBe(0);
    // 1 growing read + 4 steady reads at the full depth.
    expect(recorded.filter((r) => r.fn === "rates").length).toBe(5);
    expect(lastJson(io).rates.length).toBe(3);
    expect(lastJson(io).settled).toBe("converged");
  });

  it("takes the dates as positionals, the same shape as `hotels search`", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      ["rooms", "85481", "2099-03-01", "2099-03-05", "--adults", "3"],
      deps(io, api),
    );
    expect(code).toBe(0);
    const post = recorded.find((r) => r.fn === "create");
    expect(JSON.parse(post?.body ?? "{}")).toMatchObject({
      hotelId: 85481,
      checkIn: "2099-03-01",
      checkOut: "2099-03-05",
      adults: 3,
    });
    expect(recorded.some((r) => r.fn === "rates")).toBe(true);
  });

  it("mints the identical create from the positional and the flag spelling", async () => {
    const bodyFor = async (args: string[]): Promise<unknown> => {
      const { api, recorded } = hotelsApiStubs();
      expect(await hotels(config(API), args, deps(sink(), api))).toBe(0);
      return JSON.parse(
        recorded.find((r) => r.fn === "create")?.body ?? "null",
      );
    };
    expect(
      await bodyFor(["rooms", "85481", "2099-03-01", "2099-03-05"]),
    ).toEqual(
      await bodyFor([
        "rooms",
        "85481",
        "--check-in",
        "2099-03-01",
        "--check-out",
        "2099-03-05",
      ]),
    );
  });

  it("rejects the dates given twice, positionally AND as flags (exit 2)", async () => {
    const io = sink();
    const code = await hotels(
      config(API),
      [
        "rooms",
        "85481",
        "2099-03-01",
        "2099-03-05",
        "--check-in",
        "2099-04-01",
        "--check-out",
        "2099-04-05",
      ],
      deps(io, unreachableApi()),
    );
    expect(code).toBe(2);
    expect(io.err.join("")).toContain("not both");
  });

  it("rejects one positional date on its own (exit 2)", async () => {
    const io = sink();
    const code = await hotels(
      config(API),
      ["rooms", "85481", "2099-03-01"],
      deps(io, unreachableApi()),
    );
    expect(code).toBe(2);
    expect(io.err.join("")).toContain("<checkIn> <checkOut>");
  });

  it("rejects the positional dates alongside --search, naming them (exit 2)", async () => {
    const io = sink();
    const code = await hotels(
      config(API),
      ["rooms", "85481", "2099-03-01", "2099-03-05", "--search", "sid-1"],
      deps(io, unreachableApi()),
    );
    expect(code).toBe(2);
    const err = io.err.join("");
    expect(err).toContain("not both");
    expect(err).toContain("positional dates");
  });

  it("exits non-zero with the re-run command when the API refuses a city search", async () => {
    // The 409 the API answers when `--search` names a city search: nothing to
    // retry, so the one stderr line has to name the command that fixes it.
    const { api, recorded } = hotelsApiStubs({
      ratesStatus: 409,
      ratesCode: "rates_require_hotel_search",
    });
    const io = sink();
    const code = await hotels(
      config(API),
      ["rooms", "85481", "--search", "city-1"],
      deps(io, api),
    );
    expect(code).toBe(EXIT.PERMANENT);
    // One read: the settle never retries a scope the search cannot change.
    expect(recorded.filter((r) => r.fn === "rates").length).toBe(1);
    const err = io.err.join("");
    expect(err).toContain("this search is not hotel-scoped");
    expect(err).toContain("hotels rooms <hotelId> <checkIn> <checkOut>");
  });

  it("cautions on a converged EMPTY rate list, and still exits 0", async () => {
    // A zero here is this search's answer, never the hotel's: a fresh mint can
    // differ, so the caution is what stops it being quoted as "no rooms".
    const { api } = hotelsApiStubs({
      ratesFor: () => ({
        hotelId: 85481,
        searchId: "sid-1",
        searchComplete: true,
        rates: [],
      }),
    });
    const io = sink();
    const code = await hotels(
      config(API),
      ["rooms", "85481", "2099-03-01", "2099-03-05"],
      deps(io, api),
    );
    expect(code).toBe(0);
    expect(lastJson(io).settled).toBe("converged");
    const err = io.err.join("");
    expect(err).toContain("not proof the hotel has no rooms");
    expect(err).toContain("hotels rooms 85481 <checkIn> <checkOut>");
  });

  it("prints no empty caution when the converged list carries rates", async () => {
    const { api } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      ["rooms", "85481", "2099-03-01", "2099-03-05"],
      deps(io, api),
    );
    expect(code).toBe(0);
    expect(io.err.join("")).not.toContain("no rooms");
  });

  it("without --search: mints a hotel-scoped search then reads rates", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      [
        "rooms",
        "85481",
        "--check-in",
        "2099-03-01",
        "--check-out",
        "2099-03-05",
      ],
      deps(io, api),
    );
    expect(code).toBe(0);
    const post = recorded.find((r) => r.fn === "create");
    expect(post?.body).toContain("85481");
    expect(recorded.some((r) => r.fn === "rates")).toBe(true);
  });

  it("errors when neither --search nor dates are given", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(config(API), ["rooms", "85481"], deps(io, api));
    expect(code).toBe(2); // usage error (neither --search nor dates)
    expect(recorded.length).toBe(0);
  });

  it("errors when BOTH forms are given (exit 2, no network call)", async () => {
    // `--search` used to win silently at exit 0, spending a metered rates call.
    const io = sink();
    const code = await hotels(
      config(API),
      [
        "rooms",
        "85481",
        "--search",
        "sid-1",
        "--check-in",
        "2099-03-01",
        "--check-out",
        "2099-03-05",
      ],
      deps(io, unreachableApi()),
    );
    expect(code).toBe(2);
    const err = io.err.join("");
    expect(err).toContain("not both");
    expect(err).toContain("--check-in");
    expect(err).toContain("--check-out");
  });

  it("names only the conflicting flags actually passed", async () => {
    // Built from the argv, so it points at what the caller wrote.
    const io = sink();
    const code = await hotels(
      config(API),
      ["rooms", "85481", "--search", "sid-1", "--adults", "3"],
      deps(io, unreachableApi()),
    );
    expect(code).toBe(2);
    const err = io.err.join("");
    expect(err).toContain("--adults");
    expect(err).not.toContain("--check-in,");
  });

  it.each([
    "--check-in",
    "--check-out",
    "--adults",
    "--children",
    "--rooms",
  ])("rejects %s alongside --search", async (flag) => {
    const code = await hotels(
      config(API),
      ["rooms", "85481", "--search", "sid-1", flag, "1"],
      deps(sink(), unreachableApi()),
    );
    expect(code).toBe(2);
  });

  it("rejects --children-ages alongside --search before the --children pairing check", async () => {
    // Else the caller is sent to add `--children`, a second flag that also dies.
    const io = sink();
    const code = await hotels(
      config(API),
      ["rooms", "85481", "--search", "sid-1", "--children-ages", "5"],
      deps(io, unreachableApi()),
    );
    expect(code).toBe(2);
    const err = io.err.join("");
    expect(err).toContain("not both");
    expect(err).not.toContain("requires --children");
  });

  it("keeps --currency and --locale legal on the --search form", async () => {
    // Both price or translate the read itself, so neither belongs to a branch.
    const { api, recorded } = hotelsApiStubs();
    const code = await hotels(
      config(API),
      [
        "rooms",
        "85481",
        "--search",
        "sid-1",
        "--currency",
        "AED",
        "--locale",
        "ar",
      ],
      deps(sink(), api),
    );
    expect(code).toBe(0);
    expect(recorded.some((r) => r.fn === "create")).toBe(false);
    expect(recorded.find((r) => r.fn === "rates")?.query).toMatchObject({
      currency: "AED",
      locale: "ar",
      searchId: "sid-1",
    });
  });

  it("rejects an extra positional argument locally (exit 2, no network call)", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    // A fourth positional is rejected even when the leaf would otherwise
    // succeed, proving the guard fires before the network.
    const code = await hotels(
      config(API),
      ["rooms", "85481", "2099-03-01", "2099-03-05", "extra"],
      deps(io, api),
    );
    expect(code).toBe(2);
    expect(recorded.length).toBe(0);
    expect(io.err.join("")).toContain("Unexpected argument: extra");
  });

  it("preserves the minted searchId with a re-poll hint when the rates read fails", async () => {
    // No --search: a hotel-scoped search is minted (201 + sid-1), but the rates
    // settle 5xxs; the minted id must survive as a `--search` re-run hint.
    const { api, recorded } = hotelsApiStubs({ ratesStatus: 503 });
    const io = sink();
    const code = await hotels(
      config(API),
      [
        "rooms",
        "85481",
        "--check-in",
        "2099-03-01",
        "--check-out",
        "2099-03-05",
      ],
      deps(io, api),
    );
    expect(code).toBe(5); // retryable upstream failure (503)
    expect(recorded.some((r) => r.fn === "create")).toBe(true);
    expect(io.err.join("")).toContain(
      "re-run: wego hotels rooms 85481 --search sid-1",
    );
  });

  it("prints a re-poll hint when the settle budget runs out still empty", async () => {
    const { api, recorded } = hotelsApiStubs({
      ratesFor: () => ({
        hotelId: 85481,
        searchId: "sid-1",
        searchComplete: false,
        rates: [],
      }),
    });
    const io = sink();
    const code = await hotels(
      config(API),
      [
        "rooms",
        "85481",
        "--check-in",
        "2099-03-01",
        "--check-out",
        "2099-03-05",
      ],
      deps(io, api),
    );
    expect(code).toBe(0);
    expect(recorded.filter((r) => r.fn === "rates").length).toBe(10);
    expect(lastJson(io).settled).toBe("budget_exhausted");
    expect(io.err.join("")).toContain(
      "Rates were still aggregating – re-run: wego hotels rooms 85481 --search sid-1",
    );
  });

  it("an empty page with searchComplete:true twice converges as the definitive no-rates", async () => {
    const { api, recorded } = hotelsApiStubs({
      ratesFor: () => ({
        hotelId: 85481,
        searchId: "sid-1",
        searchComplete: true,
        rates: [],
      }),
    });
    const io = sink();
    const code = await hotels(
      config(API),
      [
        "rooms",
        "85481",
        "--check-in",
        "2099-03-01",
        "--check-out",
        "2099-03-05",
      ],
      deps(io, api),
    );
    expect(code).toBe(0);
    expect(recorded.filter((r) => r.fn === "rates").length).toBe(2);
    expect(lastJson(io).settled).toBe("converged");
    expect(io.err.join("")).not.toContain("re-run: wego hotels rooms");
  });

  it("a slow starter is not declared empty: rates landing late still converge", async () => {
    const empty = { hotelId: 85481, searchId: "sid-1", searchComplete: false };
    const { api, recorded } = hotelsApiStubs({
      ratesFor: (n) =>
        n <= 3
          ? { ...empty, rates: [] }
          : { ...empty, rates: [{ id: RATE_ID }] },
    });
    const io = sink();
    const code = await hotels(
      config(API),
      ["rooms", "85481", "--search", "sid-1"],
      deps(io, api),
    );
    expect(code).toBe(0);
    // 3 empty reads + 4 steady non-empty reads.
    expect(recorded.filter((r) => r.fn === "rates").length).toBe(7);
    expect(lastJson(io).rates.length).toBe(1);
    expect(lastJson(io).settled).toBe("converged");
  });

  it("does not print a re-poll hint when --search was supplied and rates fail", async () => {
    const { api, recorded } = hotelsApiStubs({ ratesStatus: 503 });
    const io = sink();
    const code = await hotels(
      config(API),
      ["rooms", "85481", "--search", "sid-1"],
      deps(io, api),
    );
    expect(code).toBe(5); // retryable upstream failure (503)
    expect(recorded.some((r) => r.fn === "create")).toBe(false);
    expect(io.err.join("")).not.toContain("re-run: wego hotels rooms");
  });
});

describe("wego hotels booking-link", () => {
  // The happy-path link mint lives in `hotels-e2e.test.ts`, from a rate id
  // harvested out of a real `rooms` read.

  it("requires --rate before any network call", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      ["booking-link", "85481"],
      deps(io, api),
    );
    expect(code).toBe(2); // usage error (missing --rate)
    expect(recorded.length).toBe(0);
    expect(io.err.join("")).toContain("--rate");
  });

  it("rejects an extra positional argument locally (exit 2, no network call)", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    // Valid --rate supplied so the leaf would otherwise proceed; the extra
    // positional must still be rejected before any network work.
    const code = await hotels(
      config(API),
      ["booking-link", "85481", "extra", "--rate", "r1"],
      deps(io, api),
    );
    expect(code).toBe(2);
    expect(recorded.length).toBe(0);
    expect(io.err.join("")).toContain("Unexpected argument: extra");
  });
});

describe("wego hotels share", () => {
  it("forwards the city, dates and occupancy, and prints the durable link", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      ["share", "BKK", "2099-09-15", "2099-09-17", "--adults", "2"],
      deps(io, api),
    );
    expect(code).toBe(0);
    const link = recorded.find((r) => r.fn === "searchLink");
    expect(link?.query).toMatchObject({
      cityCode: "BKK",
      checkIn: "2099-09-15",
      checkOut: "2099-09-17",
      adults: "2",
    });
    expect(io.out.join("")).toContain("/hotels/searches/bkk/");
  });

  it("sends --rooms, the same occupancy vocabulary as hotels search", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      [
        "share",
        "BKK",
        "2099-09-15",
        "2099-09-17",
        "--adults",
        "4",
        "--rooms",
        "2",
      ],
      deps(io, api),
    );
    expect(code).toBe(0);
    expect(recorded.find((r) => r.fn === "searchLink")?.query).toMatchObject({
      adults: "4",
      rooms: "2",
    });
  });

  it("refuses more rooms than adults locally, naming the default", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      ["share", "BKK", "2099-09-15", "2099-09-17", "--rooms", "3"],
      deps(io, api),
    );
    expect(code).toBe(EXIT.USAGE);
    expect(recorded).toHaveLength(0);
    expect(io.err.join("")).toContain("the default when --adults is omitted");
  });

  it("rejects a non-numeric --rooms before any call", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      ["share", "BKK", "2099-09-15", "2099-09-17", "--rooms", "two"],
      deps(io, api),
    );
    expect(code).toBe(EXIT.USAGE);
    expect(recorded).toHaveLength(0);
  });

  it("packs --children-ages into a CSV the API parses", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      [
        "share",
        "BKK",
        "2099-09-15",
        "2099-09-17",
        "--children",
        "2",
        "--children-ages",
        "5,9",
      ],
      deps(io, api),
    );
    expect(code).toBe(0);
    expect(recorded.find((r) => r.fn === "searchLink")?.query).toMatchObject({
      children: "2",
      childrenAges: "5,9",
    });
  });

  it("refuses a hotelId locally, naming the city code as the way through", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      ["share", "710862", "2099-09-15", "2099-09-17"],
      deps(io, api),
    );
    expect(code).toBe(2);
    expect(recorded.length).toBe(0);
    expect(io.err.join("")).toContain("city code");
  });

  it("refuses lat,lng locally, for the same reason", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      ["share", "13.75,100.5", "2099-09-15", "2099-09-17"],
      deps(io, api),
    );
    expect(code).toBe(2);
    expect(recorded.length).toBe(0);
  });

  it("refuses --children without ages, so no guessed age reaches the link", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      ["share", "BKK", "2099-09-15", "2099-09-17", "--children", "1"],
      deps(io, api),
    );
    expect(code).toBe(2);
    expect(recorded.length).toBe(0);
    expect(io.err.join("")).toContain("--children-ages");
  });

  it("names both counts when --children-ages disagrees with --children", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      [
        "share",
        "BKK",
        "2099-09-15",
        "2099-09-17",
        "--children",
        "2",
        "--children-ages",
        "5",
      ],
      deps(io, api),
    );
    expect(code).toBe(2);
    expect(recorded.length).toBe(0);
    expect(io.err.join("")).toContain("1 age(s) but --children is 2");
  });

  it("inherits the stored currency and locale, which the link hands on", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      ["share", "BKK", "2099-09-15", "2099-09-17"],
      deps(io, api, { currency: "SAR", locale: "ar" }),
    );
    expect(code).toBe(0);
    expect(recorded.find((r) => r.fn === "searchLink")?.query).toMatchObject({
      currency: "SAR",
      locale: "ar",
    });
  });

  it("rejects an extra positional argument before any network call", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      ["share", "BKK", "2099-09-15", "2099-09-17", "extra"],
      deps(io, api),
    );
    expect(code).toBe(2);
    expect(recorded.length).toBe(0);
    expect(io.err.join("")).toContain("Unexpected argument: extra");
  });

  it("refuses a bare city name with the city-code message, not locationFields'", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      ["share", "bangkok", "2099-09-15", "2099-09-17"],
      deps(io, api),
    );
    expect(code).toBe(2);
    expect(recorded.length).toBe(0);
    expect(io.err.join("")).toContain("city code");
    expect(io.err.join("")).not.toContain("hotelId");
  });

  it("inherits the stored site, the rung no other share test covers", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      ["share", "BKK", "2099-09-15", "2099-09-17"],
      deps(io, api, { site: "SA" }),
    );
    expect(code).toBe(0);
    expect(recorded.find((r) => r.fn === "searchLink")?.query).toMatchObject({
      siteCode: "SA",
    });
  });

  it("resolves an explicit --site over the stored one", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      ["share", "BKK", "2099-09-15", "2099-09-17", "--site", "AE"],
      deps(io, api, { site: "SA" }),
    );
    expect(code).toBe(0);
    expect(recorded.find((r) => r.fn === "searchLink")?.query).toMatchObject({
      siteCode: "AE",
    });
  });

  it("leaves siteCode absent when no rung resolves one", async () => {
    // Only `setWireQuery`'s undefined-skip keeps the key off the wire.
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      ["share", "BKK", "2099-09-15", "2099-09-17"],
      deps(io, api),
    );
    expect(code).toBe(0);
    expect(
      recorded.find((r) => r.fn === "searchLink")?.query?.siteCode,
    ).toBeUndefined();
  });

  it("prints its own usage on --help without calling the API", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(config(API), ["share", "--help"], deps(io, api));
    expect(code).toBe(0);
    expect(recorded.length).toBe(0);
    expect(io.out.join("")).toContain("hotels share");
  });
});

describe("wego hotels – child ages (issue #1114)", () => {
  it("search forwards --children-ages into the create body", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      [
        "search",
        "DXB",
        "2099-03-01",
        "2099-03-05",
        "--children",
        "1",
        "--children-ages",
        "11",
      ],
      deps(io, api),
    );
    expect(code).toBe(0);
    const post = recorded.find((r) => r.fn === "create");
    expect(JSON.parse(post?.body ?? "{}").childrenAges).toEqual([11]);
    // The one stderr line on a fresh machine is the currency-setting hint the
    // search prints while no currency is stored (issue #1386).
    expect(io.err).toEqual([expect.stringContaining("config set currency")]);
  });

  it("rooms forwards --children-ages into the minted create body", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      [
        "rooms",
        "85481",
        "--check-in",
        "2099-03-01",
        "--check-out",
        "2099-03-05",
        "--children",
        "2",
        "--children-ages",
        "0,17",
      ],
      deps(io, api),
    );
    expect(code).toBe(0);
    const post = recorded.find((r) => r.fn === "create");
    expect(JSON.parse(post?.body ?? "{}").childrenAges).toEqual([0, 17]);
  });

  it("rooms (scoped form): the minted create carries the stored currency AND market", async () => {
    const { api, recorded } = hotelsApiStubs();
    const code = await hotels(
      config(API),
      [
        "rooms",
        "85481",
        "--check-in",
        "2099-03-01",
        "--check-out",
        "2099-03-05",
      ],
      deps(sink(), api, { currency: "SAR", site: "SA", locale: "ar" }),
    );
    expect(code).toBe(0);
    const post = recorded.find((r) => r.fn === "create");
    const body = JSON.parse(post?.body ?? "{}") as Record<string, string>;
    expect(body.currency).toBe("SAR");
    expect(body.siteCode).toBe("SA");
    expect(recorded.find((r) => r.fn === "rates")?.query).toMatchObject({
      currency: "SAR",
    });
  });

  it("rooms (scoped form): an explicit --currency reaches the create too, not just the rates read", async () => {
    // The flag must win for the WHOLE operation. Minting the search in the
    // stored SAR and then reading its rates in the requested USD would let a
    // setting beat a flag for half of one command.
    const { api, recorded } = hotelsApiStubs();
    const code = await hotels(
      config(API),
      [
        "rooms",
        "85481",
        "--check-in",
        "2099-03-01",
        "--check-out",
        "2099-03-05",
        "--currency",
        "USD",
        "--locale",
        "en",
      ],
      deps(sink(), api, { currency: "SAR", locale: "ar" }),
    );
    expect(code).toBe(0);
    const post = recorded.find((r) => r.fn === "create");
    const body = JSON.parse(post?.body ?? "{}") as Record<string, string>;
    expect(body.currency).toBe("USD");
    expect(body.locale).toBe("en");
    expect(recorded.find((r) => r.fn === "rates")?.query).toMatchObject({
      currency: "USD",
      locale: "en",
    });
  });

  it("rooms (scoped form): an explicit --site mints the search in THAT market", async () => {
    // `--site` is copied onto the create by `applyOccupancyFlags`, so an
    // explicit `AE` beats a stored `SA`. Pinned because `parseRoomsArgs` reads
    // as if it drops the flag, and two reviewers reported exactly that.
    const { api, recorded } = hotelsApiStubs();
    const code = await hotels(
      config(API),
      [
        "rooms",
        "85481",
        "--check-in",
        "2099-03-01",
        "--check-out",
        "2099-03-05",
        "--site",
        "AE",
      ],
      deps(sink(), api, { site: "SA" }),
    );
    expect(code).toBe(0);
    const post = recorded.find((r) => r.fn === "create");
    const body = JSON.parse(post?.body ?? "{}") as Record<string, string>;
    expect(body.siteCode).toBe("AE");
  });

  it("rooms (scoped form): REPORTS the market it minted in, and which layer decided it", async () => {
    // This form mints a search, so a stored `site` can decide the point of sale.
    // `resolveRoomsSearchId` resolved that market and then dropped it, so the
    // rates printed with no indication of the market they were priced for - the
    // silent market decision issue #1386 exists to remove.
    const io = sink();
    const code = await hotels(
      config(API),
      [
        "rooms",
        "85481",
        "--check-in",
        "2099-03-01",
        "--check-out",
        "2099-03-05",
      ],
      deps(io, hotelsApiStubs().api, { site: "SA" }),
    );
    expect(code).toBe(0);
    const printed = JSON.parse(io.out.join("\n")) as Record<string, unknown>;
    expect(printed.siteCode).toBe("SA");
    expect(printed.siteCodeSource).toBe("setting");
  });

  it("rooms (scoped form): the reported source names the layer, not just `explicit`", async () => {
    // An explicit flag reads `explicit`; the account market reads `account`. The
    // API can only ever say explicit/default, so only the CLI can name these.
    const io = sink();
    const code = await hotels(
      config(API),
      [
        "rooms",
        "85481",
        "--check-in",
        "2099-03-01",
        "--check-out",
        "2099-03-05",
        "--site",
        "AE",
      ],
      deps(io, hotelsApiStubs().api, { site: "SA" }),
    );
    expect(code).toBe(0);
    const printed = JSON.parse(io.out.join("\n")) as Record<string, unknown>;
    expect(printed.siteCode).toBe("AE");
    expect(printed.siteCodeSource).toBe("explicit");
  });

  it("rooms (--search form): an explicit --site is a usage error — that search fixed the market", async () => {
    // Carve-out 3: no create for a market to apply to, and rates take no siteCode.
    const io = sink();
    const code = await hotels(
      config(API),
      ["rooms", "85481", "--search", "sid-1", "--site", "AE"],
      deps(io, unreachableApi()),
    );
    expect(code).toBe(2);
    expect(io.err.join("")).toContain("--site");
  });

  it("rooms (--search form): inherits currency but NEVER a market — that search fixed one", async () => {
    // Carve-out (issue #1386): the rates belong to an existing search, whose
    // market is already decided. Sending a stored `site` here would claim a
    // market the rates are not in.
    const { api, recorded } = hotelsApiStubs();
    const code = await hotels(
      config(API),
      ["rooms", "85481", "--search", "sid-1"],
      deps(sink(), api, { currency: "SAR", site: "SA" }),
    );
    expect(code).toBe(0);
    // No create at all on this form, so no market can be applied.
    expect(recorded.some((r) => r.fn === "create")).toBe(false);
    const rates = recorded.find((r) => r.fn === "rates");
    expect(rates?.query).toMatchObject({ currency: "SAR" });
    expect(rates?.query).not.toHaveProperty("siteCode");
  });

  it("results: a bare read inherits the stored currency instead of reverting to USD", async () => {
    const { api, recorded } = hotelsApiStubs();
    const code = await hotels(
      config(API),
      ["results", "sid-1"],
      deps(sink(), api, { currency: "SAR" }),
    );
    expect(code).toBe(0);
    expect(recorded.find((r) => r.fn === "results")?.query).toMatchObject({
      currency: "SAR",
    });
  });

  it("results: a bare read uses the STORED currency even when the search was created with a flag", async () => {
    // The known limit of the file, pinned so it cannot drift into a claim it does
    // not make: a `searchId` carries no currency, so a bare read cannot reproduce
    // the `--currency` the create used and applies the stored preference instead.
    // Documented in docs/settings.md, and the read echoes `currencyCode`, so the
    // mismatch is visible rather than inferred. Closing it needs a new precedence
    // rung (a per-searchId record), which is a design call for the issue.
    const { api, recorded } = hotelsApiStubs();
    const code = await hotels(
      config(API),
      ["results", "sid-1"],
      deps(sink(), api, { currency: "SAR" }),
    );
    expect(code).toBe(0);
    // No `--currency USD` here, so the SAR setting decides - NOT the USD the
    // search behind `sid-1` may have been created with.
    expect(recorded.find((r) => r.fn === "results")?.query).toMatchObject({
      currency: "SAR",
    });
    // ...and repeating the flag on the read is the documented way to match it.
    const second = hotelsApiStubs();
    expect(
      await hotels(
        config(API),
        ["results", "sid-1", "--currency", "USD"],
        deps(sink(), second.api, { currency: "SAR" }),
      ),
    ).toBe(0);
    expect(
      second.recorded.find((r) => r.fn === "results")?.query,
    ).toMatchObject({ currency: "USD" });
  });

  it("details/reviews inherit the locale and are sent no currency (neither takes one)", async () => {
    const { api, recorded } = hotelsApiStubs();
    const settings = { currency: "SAR", locale: "ar", site: "SA" };
    expect(
      await hotels(
        config(API),
        ["details", "85481"],
        deps(sink(), api, settings),
      ),
    ).toBe(0);
    expect(
      await hotels(
        config(API),
        ["reviews", "85481"],
        deps(sink(), api, settings),
      ),
    ).toBe(0);
    for (const r of recorded.filter(
      (x) => x.fn === "details" || x.fn === "reviews",
    )) {
      expect(r.query).toMatchObject({ locale: "ar" });
      expect(r.query).not.toHaveProperty("currency");
    }
  });
  it("rejects a children-ages/children count mismatch before any network call", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      [
        "search",
        "DXB",
        "2099-03-01",
        "2099-03-05",
        "--children",
        "1",
        "--children-ages",
        "5,11",
      ],
      deps(io, api),
    );
    expect(code).toBe(2); // usage: rejected before any network call
    expect(recorded.length).toBe(0);
    expect(io.err.join("")).toContain("must equal --children");
  });

  it("rejects --children-ages without --children", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      ["search", "DXB", "2099-03-01", "2099-03-05", "--children-ages", "11"],
      deps(io, api),
    );
    expect(code).toBe(2); // usage: rejected before any network call
    expect(recorded.length).toBe(0);
    expect(io.err.join("")).toContain("requires --children");
  });

  it("rejects an out-of-range age before any network call", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      [
        "search",
        "DXB",
        "2099-03-01",
        "2099-03-05",
        "--children",
        "1",
        "--children-ages",
        "18",
      ],
      deps(io, api),
    );
    expect(code).toBe(2); // usage: rejected before any network call
    expect(recorded.length).toBe(0);
    expect(io.err.join("")).toContain("0–17");
  });

  it("booking-link rejects every dropped flag before any network call", async () => {
    for (const flag of [
      ["--adults", "2"],
      ["--children-ages", "11"],
      ["--guests", "2:11"],
    ]) {
      const { api, recorded } = hotelsApiStubs();
      const io = sink();
      const code = await hotels(
        config(API),
        ["booking-link", "85481", "--rate", RATE_ID, ...flag],
        deps(io, api),
      );
      expect(code).toBe(2);
      expect(recorded.length).toBe(0);
      expect(io.err.join("")).toContain(`Unknown option: ${flag[0]}`);
    }
  });

  it("booking-link sends no guests, and no countryCode unless asked", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      ["booking-link", "85481", "--rate", RATE_ID],
      deps(io, api),
    );
    expect(code).toBe(0);
    const link = recorded.find((r) => r.fn === "bookingLink");
    expect(link?.query?.guests).toBeUndefined();
    expect(link?.query?.countryCode).toBeUndefined();
  });

  it("booking-link uppercases --country, like the info commands", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      ["booking-link", "85481", "--rate", RATE_ID, "--country", "ae"],
      deps(io, api),
    );
    expect(code).toBe(0);
    const link = recorded.find((r) => r.fn === "bookingLink");
    expect(link?.query?.countryCode).toBe("AE");
  });

  it("booking-link rejects a malformed --country before any network call", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      ["booking-link", "85481", "--rate", RATE_ID, "--country", "usa"],
      deps(io, api),
    );
    expect(code).toBe(2);
    expect(recorded.length).toBe(0);
    expect(io.err.join("")).toContain("2-letter ISO country code");
  });
});

describe("wego hotels – occupancy echo surfacing (issue #1114)", () => {
  it("search surfaces the priced occupancy the create echoed", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      [
        "search",
        "DXB",
        "2099-03-01",
        "2099-03-05",
        "--children",
        "1",
        "--children-ages",
        "11",
      ],
      deps(io, api),
    );
    expect(code).toBe(0);
    // The resolved ages must reach stdout — a strict schema would have stripped
    // them, defeating #1114's audit goal.
    expect(lastJson(io).occupancy).toEqual({
      adults: 2,
      childrenAges: [11],
      rooms: 1,
    });
  });

  it("rooms (minted search) surfaces the priced occupancy", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      [
        "rooms",
        "85481",
        "--check-in",
        "2099-03-01",
        "--check-out",
        "2099-03-05",
        "--children",
        "1",
        "--children-ages",
        "11",
      ],
      deps(io, api),
    );
    expect(code).toBe(0);
    expect(lastJson(io).occupancy).toEqual({
      adults: 2,
      childrenAges: [11],
      rooms: 1,
    });
  });

  it("rooms with --search omits occupancy (no create, nothing echoed)", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      ["rooms", "85481", "--search", "sid-1"],
      deps(io, api),
    );
    expect(code).toBe(0);
    expect(recorded.some((r) => r.fn === "create")).toBe(false);
    expect(lastJson(io).occupancy).toBeUndefined();
  });
});

describe("wego hotels – children cap + ages boundaries (issue #1114)", () => {
  it("accepts exactly MAX_CHILDREN (8) ages", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      [
        "search",
        "DXB",
        "2099-03-01",
        "2099-03-05",
        "--children",
        "8",
        "--children-ages",
        "1,2,3,4,5,6,7,8",
      ],
      deps(io, api),
    );
    expect(code).toBe(0);
    const post = recorded.find((r) => r.fn === "create");
    expect(JSON.parse(post?.body ?? "{}").childrenAges).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });

  it("rejects 9 children (over MAX_CHILDREN) before any network call", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      [
        "search",
        "DXB",
        "2099-03-01",
        "2099-03-05",
        "--children",
        "9",
        "--children-ages",
        "1,2,3,4,5,6,7,8,9",
      ],
      deps(io, api),
    );
    expect(code).toBe(2); // usage: rejected before any network call
    expect(recorded.length).toBe(0);
    expect(io.err.join("")).toContain("between 0 and 8");
  });

  it("rejects a non-numeric age token before any network call", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      [
        "search",
        "DXB",
        "2099-03-01",
        "2099-03-05",
        "--children",
        "1",
        "--children-ages",
        "abc",
      ],
      deps(io, api),
    );
    expect(code).toBe(2); // usage: rejected before any network call
    expect(recorded.length).toBe(0);
    expect(io.err.join("")).toContain("0–17");
  });

  it("rejects a negative age before any network call", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      [
        "search",
        "DXB",
        "2099-03-01",
        "2099-03-05",
        "--children",
        "1",
        "--children-ages",
        "-1",
      ],
      deps(io, api),
    );
    expect(code).toBe(2); // usage: rejected before any network call
    expect(recorded.length).toBe(0);
    expect(io.err.join("")).toContain("0–17");
  });

  it("rejects an empty-after-filter ages list before any network call", async () => {
    const { api, recorded } = hotelsApiStubs();
    const io = sink();
    const code = await hotels(
      config(API),
      ["search", "DXB", "2099-03-01", "2099-03-05", "--children-ages", ","],
      deps(io, api),
    );
    expect(code).toBe(2); // usage: rejected before any network call
    expect(recorded.length).toBe(0);
    expect(io.err.join("")).toContain("at least one age");
  });
});

describe("wego hotels – dispatch + round trip", () => {
  it("prints usage for an unknown sub-command", async () => {
    const io = sink();
    const code = await hotels(
      config(API),
      ["frobnicate"],
      deps(io, unreachableApi()),
    );
    expect(code).toBe(2); // usage error
    expect(io.err.join("")).toContain("Usage: wego hotels");
  });

  // The search → details → rooms → booking-link chain moved to
  // `hotels-e2e.test.ts` (issue #1340). Driven in-process against this fake it could
  // only fail when the fake disagreed with itself; it now runs the real CLI against a
  // real `apps/api` serving real recorded upstream data, and additionally asserts
  // the two `rooms` forms and the refundability witness — neither of which a fake
  // can express, since both are properties of what the upstream actually sends.
});

// --- hotels help: -h/--help/help short-circuit (issue #1119) ---------------
//
// Before the fix, `wego hotels --help` (and every leaf sub-command's
// `--help`) fell into the "unknown sub-command"/"unknown option" arm: usage
// printed to STDERR with exit 1. Golden tests below pin the FIXED behavior —
// stdout, exit 0, empty stderr, no network call — for the group and every
// leaf, plus a negative case per level proving a genuinely unknown
// sub-command/option is still a real error.
describe("wego hotels help: -h/--help/help short-circuit (issue #1119)", () => {
  // If the fix regressed and `--help` fell through to a real sub-command, the api
  // stub throws and names the call, instead of these tests silently passing.
  const noNetwork = () => config(API);

  for (const help of ["-h", "--help", "help"]) {
    it(`hotels ${help}: prints the group usage to stdout, exit 0, empty stderr`, async () => {
      const io = sink();
      const code = await hotels(
        noNetwork(),
        [help],
        deps(io, unreachableApi()),
      );
      expect(code).toBe(0);
      const printed = io.out.join("\n");
      expect(printed).toMatch(/^Usage: wego hotels/);
      expect(printed).toMatch(/^ {2}booking-link /m);
      expect(io.err.length).toBe(0);
    });
  }

  const leaves = ["search", "results", "details", "rooms", "booking-link"];
  for (const sub of leaves) {
    // Bare `help` is exercised alongside the dash forms so a leaf can never
    // regress to recognizing only `-h`/`--help` while the group dispatcher
    // accepts bare `help` (the #1119 leaf-level bug).
    for (const help of ["help", "-h", "--help"]) {
      it(`hotels ${sub} ${help}: prints that command's scoped usage to stdout, exit 0, empty stderr, no network call`, async () => {
        const io = sink();
        const code = await hotels(
          noNetwork(),
          [sub, help],
          deps(io, unreachableApi()),
        );
        expect(code).toBe(0);
        // Each leaf now prints its OWN scoped usage (CLI-3), not the whole group
        // block — so the usage names this sub-command, not just "wego hotels".
        expect(io.out.join("\n")).toContain(`Usage: wego hotels ${sub}`);
        expect(io.err.length).toBe(0);
      });
    }
  }

  it("negative: a genuinely unknown hotels sub-command exits 2 (usage) on stderr", async () => {
    const io = sink();
    const code = await hotels(
      noNetwork(),
      ["frobnicate"],
      deps(io, unreachableApi()),
    );
    expect(code).toBe(2); // usage: rejected before any network call
    expect(io.out.length).toBe(0);
    expect(io.err.join("")).toContain("Usage: wego hotels");
  });

  it("negative: a genuinely unknown option on a hotels leaf exits 2 (usage) on stderr (not confused with --help)", async () => {
    // Every hotels leaf now forwards the real parse error via errorMessage(err)
    // (CLI-3 — `details` no longer swallows it), so any leaf proves the "Unknown
    // option" message survives; booking-link is kept here as the representative.
    const io = sink();
    const code = await hotels(
      noNetwork(),
      ["booking-link", "85481", "--bogus"],
      deps(io, unreachableApi()),
    );
    expect(code).toBe(2); // usage: rejected before any network call
    expect(io.out.length).toBe(0);
    expect(io.err.join("")).toMatch(/Unknown option: --bogus/);
  });
});
