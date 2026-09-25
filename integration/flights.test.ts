/**
 * `wego flights`: the funnel from search to booking link, as a caller sees it. What
 * each command sends, what it prints, the block-to-settled read after a search,
 * where the market and the currency come from, and the usage errors refused
 * before any request.
 *
 * The settle loop's own rules (the transient drop, the exhausted budget, the
 * count-less fallback) are `src/search-engine.test.ts`: here is one of each
 * outcome a fast scenario can reach. The results filter flags are
 * `parseFlightResultsArgs`'s unit tests.
 */

import { describe, expect, it } from "bun:test";
import { type Answer, problem } from "./harness/fake";
import { answer, readFixture, route } from "./harness/fixtures";
import { useScenario } from "./harness/scenario";
import { json, signIn, writeSettings } from "./harness/wego";

const s = useScenario();

// biome-ignore lint/suspicious/noExplicitAny: a fixture body is untyped JSON
const body = (name: string) => readFixture(name).body as any;

/** The ids a scenario passes on argv. The fake answers any id with its fixture. */
const SEARCH_ID = "s1msr";
const TRIP_ID = "s1msr:TR610~10";
const FARE_ID = "f_88_1";
const EXPERIENCE_TRIP = "s1msr:TR638~3~1250~1425";

type Printed = Record<string, unknown> & {
  metadata: Record<string, unknown>;
};

/** A results page whose snapshot counter reads `count`; zero is a cold, empty
 *  snapshot. */
function resultsAt(count: number): Answer {
  // biome-ignore lint/suspicious/noExplicitAny: a fixture body is untyped JSON
  return answer<any>("flights-results", (b) => {
    b.metadata.snapshotFareCount = count;
    if (count === 0) {
      b.results = [];
      b.metadata.resultCount = 0;
      b.metadata.totalCandidates = 0;
      b.metadata.snapshotTripCount = 0;
    } else {
      b.metadata.snapshotTripCount = Math.max(b.metadata.snapshotTripCount, 1);
    }
    return b;
  });
}

/** A create that echoes `siteCode`, as the API does for the market it was sent. */
const createEchoing = (siteCode: string): Answer =>
  answer("flights-search", (b) => ({
    ...b,
    siteCode,
    siteCodeSource: "explicit",
  }));

/** Settle reads that converge on the second one, whatever the fixture holds. */
function settledReads() {
  return { op: "getFlightSearchResults", answers: [resultsAt(1)] };
}

/** The routes a `flights search` touches: the create, then its settle reads. */
function searchRoutes(...reads: Answer[]) {
  return [
    route("flights-search"),
    reads.length > 0
      ? { op: "getFlightSearchResults", answers: reads }
      : settledReads(),
  ];
}

/** A create answering with `create` only, not the fixture first. */
function createRoute(create: Answer) {
  return { op: "createFlightSearch", answers: [create] };
}

const query = (seen: { query: URLSearchParams } | undefined) =>
  Object.fromEntries(seen?.query ?? []);

describe("flights search", () => {
  it("creates, blocks to settled, and prints the page with its searchId", async () => {
    signIn(s.home);
    const fake = s.fake({ routes: searchRoutes() });
    const result = await s.run([
      "flights",
      "search",
      "SIN",
      "BKK",
      "2099-03-01",
      "--return",
      "2099-03-08",
    ]);

    expect(result.code).toBe(0);
    const printed = json<Printed & { results: { price: unknown }[] }>(result);
    expect(printed.searchId).toBe(body("flights-search").searchId);
    expect(printed.settled).toBe("converged");
    // A card page, not trips: a price summary and no fares.
    expect(printed.results[0]?.price).toEqual(
      body("flights-results").results[0].price,
    );
    expect(result.out).not.toContain('"fares"');
    expect(fake.requests("createFlightSearch")[0]?.body).toEqual({
      from: "SIN",
      to: "BKK",
      fromDate: "2099-03-01",
      toDate: "2099-03-08",
    });
    expect(fake.requests("getFlightSearchResults")[0]?.path).toBe(
      `/v1/flights/searches/${body("flights-search").searchId}/results`,
    );
  });

  for (const flags of [
    ["--infants", "9"],
    ["--adults", "1", "--infants", "2"],
    ["--infants", "2"],
  ]) {
    it(`search ${flags.join(" ")} is a usage error, not a 400`, async () => {
      signIn(s.home);
      const fake = s.fake();
      const result = await s.run([
        "flights",
        "search",
        "SIN",
        "BKK",
        "2099-03-01",
        ...flags,
      ]);
      expect(result.code).toBe(2);
      expect(fake.seen).toEqual([]);
    });
  }

  for (const dates of [
    ["01-03-2099"],
    ["2099-02-30"],
    ["2099-03-01", "--return", "2099-13-01"],
    ["2099-03-01", "--return", "nope"],
  ]) {
    it(`search with ${dates.join(" ")} is a usage error, not a 400`, async () => {
      signIn(s.home);
      const fake = s.fake();
      const result = await s.run(["flights", "search", "SIN", "BKK", ...dates]);
      expect(result.code).toBe(2);
      expect(fake.seen).toEqual([]);
    });
  }

  it("derives the site from the account's market (source: account)", async () => {
    signIn(s.home, { accessToken: "access-1", market: "AE" });
    const fake = s.fake({
      routes: [createRoute(createEchoing("AE")), settledReads()],
    });
    const result = await s.run([
      "flights",
      "search",
      "SIN",
      "BKK",
      "2099-03-01",
    ]);

    expect(result.code).toBe(0);
    expect(fake.requests("createFlightSearch")[0]?.body).toMatchObject({
      siteCode: "AE",
    });
    expect(json<Printed>(result)).toMatchObject({
      siteCode: "AE",
      siteCodeSource: "account",
    });
  });

  it("an explicit --site beats the account's market (source: explicit)", async () => {
    signIn(s.home, { accessToken: "access-1", market: "AE" });
    const fake = s.fake({
      routes: [createRoute(createEchoing("SG")), settledReads()],
    });
    const result = await s.run([
      "flights",
      "search",
      "SIN",
      "BKK",
      "2099-03-01",
      "--site",
      "SG",
    ]);

    expect(result.code).toBe(0);
    expect(fake.requests("createFlightSearch")[0]?.body).toMatchObject({
      siteCode: "SG",
    });
    expect(json<Printed>(result).siteCodeSource).toBe("explicit");
  });

  it("with no flag, setting or market sends no site and reports `default`", async () => {
    signIn(s.home);
    const fake = s.fake({ routes: searchRoutes() });
    const result = await s.run([
      "flights",
      "search",
      "SIN",
      "BKK",
      "2099-03-01",
    ]);

    expect(result.code).toBe(0);
    expect(fake.requests("createFlightSearch")[0]?.body).not.toHaveProperty(
      "siteCode",
    );
    expect(json<Printed>(result)).toMatchObject({
      siteCode: body("flights-search").siteCode,
      siteCodeSource: "default",
    });
  });

  it("a stored site beats the account's market (source: setting)", async () => {
    signIn(s.home, { accessToken: "access-1", market: "AE" });
    writeSettings(s.home, { site: "SA", currency: "SAR" });
    const fake = s.fake({
      routes: [createRoute(createEchoing("SA")), settledReads()],
    });
    const result = await s.run([
      "flights",
      "search",
      "RUH",
      "DXB",
      "2099-03-01",
    ]);

    expect(result.code).toBe(0);
    expect(fake.requests("createFlightSearch")[0]?.body).toMatchObject({
      siteCode: "SA",
    });
    expect(json<Printed>(result)).toMatchObject({
      siteCode: "SA",
      siteCodeSource: "setting",
    });
  });

  it("reads the first page in the search's --currency and --locale", async () => {
    signIn(s.home);
    const fake = s.fake({ routes: searchRoutes() });
    const result = await s.run([
      "flights",
      "search",
      "SIN",
      "BKK",
      "2099-03-01",
      "--currency",
      "SGD",
      "--locale",
      "ar",
    ]);

    expect(result.code).toBe(0);
    expect(query(fake.requests("getFlightSearchResults")[0])).toEqual({
      currency: "SGD",
      locale: "ar",
    });
  });

  for (const [rung, settings, flags, sent] of [
    ["explicit", { currency: "SAR" }, ["--currency", "USD"], "USD"],
    ["setting", { currency: "SAR" }, [], "SAR"],
    ["default", {}, [], undefined],
  ] as const) {
    it(`names the currency's rung (${rung}); the create and its read agree`, async () => {
      signIn(s.home);
      writeSettings(s.home, settings);
      const fake = s.fake({ routes: searchRoutes() });
      const result = await s.run([
        "flights",
        "search",
        "RUH",
        "DXB",
        "2099-03-01",
        ...flags,
      ]);

      expect(result.code).toBe(0);
      expect(json<Printed>(result).currencyCodeSource).toBe(rung);
      const created = fake.requests("createFlightSearch")[0]?.body as {
        currency?: string;
      };
      expect(created.currency).toBe(sent);
      for (const read of fake.requests("getFlightSearchResults")) {
        expect(read.query.get("currency") ?? undefined).toBe(sent);
      }
    });
  }

  it("prints the currency hint on a fresh machine, and not once one is stored", async () => {
    signIn(s.home);
    s.fake({ routes: searchRoutes() });
    const argv = ["flights", "search", "RUH", "DXB", "2099-03-01"];

    const fresh = await s.run(argv);
    expect(fresh.code).toBe(0);
    expect(fresh.err).toContain("config set currency");

    writeSettings(s.home, { currency: "SAR" });
    const configured = await s.run(argv);
    expect(configured.code).toBe(0);
    expect(configured.err).not.toContain("config set currency");
  });

  it("an explicit --currency also silences the hint", async () => {
    signIn(s.home);
    s.fake({ routes: searchRoutes() });
    const result = await s.run([
      "flights",
      "search",
      "RUH",
      "DXB",
      "2099-03-01",
      "--currency",
      "SAR",
    ]);
    expect(result.code).toBe(0);
    expect(result.err).not.toContain("config set currency");
  });
});

describe("flights search settle", () => {
  it("re-reads past an empty first snapshot and stamps `converged`", async () => {
    signIn(s.home);
    const fake = s.fake({
      routes: searchRoutes(resultsAt(0), resultsAt(1)),
    });
    const result = await s.run([
      "flights",
      "search",
      "SIN",
      "BKK",
      "2099-03-01",
    ]);

    expect(result.code).toBe(0);
    expect(fake.requests("getFlightSearchResults").length).toBeGreaterThan(1);
    const printed = json<Printed & { results: unknown[] }>(result);
    expect(printed.settled).toBe("converged");
    expect(printed.results.length).toBeGreaterThan(0);
  });

  it("an empty settled page is still only JSON on stdout, the hint on stderr", async () => {
    signIn(s.home);
    // The snapshot holds trips but the page is empty: it settles, then explains.
    const empty = answer<Printed & { results: unknown[] }>(
      "flights-results",
      (b) => ({
        ...b,
        results: [],
        metadata: {
          ...b.metadata,
          resultCount: 0,
          snapshotTripCount: 3,
          snapshotFareCount: 5,
        },
      }),
    );
    s.fake({ routes: searchRoutes(empty) });
    const result = await s.run([
      "flights",
      "search",
      "SIN",
      "BKK",
      "2099-03-01",
    ]);

    expect(result.code).toBe(0);
    const printed = json<Printed & { results: unknown[] }>(result);
    const searchId = body("flights-search").searchId;
    expect(printed.searchId).toBe(searchId);
    expect(printed.results).toEqual([]);
    expect(result.err).toContain(`wego flights results ${searchId}`);
    expect(result.out).not.toContain("re-run");
  });

  it("a 401 on the read refreshes and retries the read, never the create", async () => {
    signIn(s.home);
    const fake = s.fake({
      routes: searchRoutes(
        problem(401, "invalid_token", "Missing or invalid token"),
        resultsAt(1),
      ),
      refresh: [{ access_token: "access-2" }],
    });
    const result = await s.run([
      "flights",
      "search",
      "SIN",
      "BKK",
      "2099-03-01",
    ]);

    expect(result.code).toBe(0);
    expect(fake.requests("createFlightSearch")).toHaveLength(1);
    expect(
      fake.requests("getFlightSearchResults").map((r) => r.token),
    ).toContain("access-2");
    expect(json<Printed & { results: unknown[] }>(result).results).toEqual(
      body("flights-results").results,
    );
  });

  it("a failed first read exits 1 with only the re-run hint", async () => {
    signIn(s.home);
    s.fake({
      routes: searchRoutes(problem(502, "bad_gateway", "boom")),
    });
    const result = await s.run([
      "flights",
      "search",
      "SIN",
      "BKK",
      "2099-03-01",
    ]);

    expect(result.code).toBe(1);
    expect(result.out).toBe("");
    expect(result.err).toContain(
      `Search created – re-run: wego flights results ${body("flights-search").searchId} --wait`,
    );
    expect(result.err).not.toMatch(/boom|trace-502/);
  });

  it("a failed read mid-settle exits with its own class, not the re-run fold", async () => {
    signIn(s.home);
    const fake = s.fake({
      routes: searchRoutes(resultsAt(1), problem(502, "bad_gateway", "boom")),
    });
    const result = await s.run([
      "flights",
      "search",
      "SIN",
      "BKK",
      "2099-03-01",
    ]);

    expect(result.code).toBe(6);
    expect(result.out).toBe("");
    expect(result.err).not.toContain("Search created – re-run");
    expect(fake.requests("getFlightSearchResults").length).toBeGreaterThan(1);
  });
});

describe("flights results", () => {
  it("without --wait reads once and stamps `unsettled`", async () => {
    signIn(s.home);
    const fake = s.fake({
      routes: [
        {
          op: "getFlightSearchResults",
          answers: [resultsAt(1), resultsAt(2), resultsAt(3)],
        },
      ],
    });
    const result = await s.run(["flights", "results", SEARCH_ID]);

    expect(result.code).toBe(0);
    expect(fake.requests("getFlightSearchResults")).toHaveLength(1);
    expect(json<Printed>(result).settled).toBe("unsettled");
  });

  it("prints the fares-less cards and sends no view param", async () => {
    signIn(s.home);
    const fake = s.fake({ routes: [route("flights-results")] });
    const result = await s.run(["flights", "results", SEARCH_ID]);

    expect(result.code).toBe(0);
    expect(fake.requests("getFlightSearchResults")[0]?.query.has("view")).toBe(
      false,
    );
    const card = body("flights-results").results[0];
    const printed = json<{
      results: { tripId: string; durationMinutes: number; price: unknown }[];
    }>(result);
    expect(printed.results[0]).toMatchObject({
      tripId: card.tripId,
      durationMinutes: card.durationMinutes,
      price: card.price,
    });
    expect(result.out).not.toContain('"fares"');
  });

  it("--wait settles once the snapshot count stops growing", async () => {
    signIn(s.home);
    const fake = s.fake({
      routes: [
        {
          op: "getFlightSearchResults",
          answers: [resultsAt(0), resultsAt(3), resultsAt(3)],
        },
      ],
    });
    const result = await s.run(["flights", "results", SEARCH_ID, "--wait"]);

    expect(result.code).toBe(0);
    const printed = json<Printed>(result);
    expect(printed.searchId).toBe(body("flights-results").searchId);
    expect(printed.settled).toBe("converged");
    expect(printed.metadata.snapshotFareCount).toBe(3);
    expect(fake.requests("getFlightSearchResults")).toHaveLength(3);
  });

  it("--wait restarts the whole poll after a 401 mid-settle", async () => {
    signIn(s.home);
    const fake = s.fake({
      routes: [
        {
          op: "getFlightSearchResults",
          answers: [
            resultsAt(0),
            resultsAt(2),
            problem(401, "invalid_token", "Missing or invalid token"),
            resultsAt(2),
          ],
        },
      ],
      refresh: [{ access_token: "access-2" }],
    });
    const result = await s.run(["flights", "results", SEARCH_ID, "--wait"]);

    expect(result.code).toBe(0);
    const printed = json<Printed>(result);
    expect(printed.settled).toBe("converged");
    expect(printed.metadata.snapshotFareCount).toBe(2);
    // The restart re-walks from its own first read, on the refreshed token.
    const reads = fake.requests("getFlightSearchResults");
    expect(reads.length).toBeGreaterThan(3);
    expect(reads.at(-1)?.token).toBe("access-2");
  });

  it("after a refresh, a retried read's own failure keeps its class (exit 5)", async () => {
    signIn(s.home);
    s.fake({
      routes: [
        {
          op: "getFlightSearchResults",
          answers: [
            problem(401, "invalid_token", "Missing or invalid token"),
            problem(503, "upstream_unavailable", "try later", {
              "retry-after": "0",
            }),
          ],
        },
      ],
      refresh: [{ access_token: "access-2" }],
    });
    const result = await s.run(["flights", "results", SEARCH_ID]);
    expect(result.code).toBe(5);
  });

  it("an expired search exits 4 with a message saying so", async () => {
    signIn(s.home);
    s.fake({
      routes: [
        { op: "getFlightSearchResults", answers: [problem(404, "not_found")] },
      ],
    });
    const result = await s.run(["flights", "results", "gone123msr"]);
    expect(result.code).toBe(4);
    expect(result.out).toBe("");
    expect(result.err).toMatch(/expired|not found/i);
  });

  it("a bare read inherits the stored currency and locale", async () => {
    // A plain read after a SAR search must stay in SAR, not fall back to USD.
    signIn(s.home);
    writeSettings(s.home, { currency: "SAR", locale: "ar" });
    const fake = s.fake({ routes: [route("flights-results")] });
    expect((await s.run(["flights", "results", SEARCH_ID])).code).toBe(0);
    expect(query(fake.requests("getFlightSearchResults")[0])).toMatchObject({
      currency: "SAR",
      locale: "ar",
    });
  });

  it("an explicit --currency beats the stored one", async () => {
    signIn(s.home);
    writeSettings(s.home, { currency: "SAR" });
    const fake = s.fake({ routes: [route("flights-results")] });
    expect(
      (await s.run(["flights", "results", SEARCH_ID, "--currency", "USD"]))
        .code,
    ).toBe(0);
    expect(
      fake.requests("getFlightSearchResults")[0]?.query.get("currency"),
    ).toBe("USD");
  });
});

describe("priced reads and their provenance", () => {
  const priced = [
    {
      argv: ["flights", "results", SEARCH_ID],
      routes: () => [route("flights-results")],
    },
    {
      argv: ["flights", "trip", TRIP_ID, "--search", SEARCH_ID],
      routes: () => [route("flights-trip")],
    },
    {
      argv: ["flights", "fares", FARE_ID],
      routes: () => [route("flights-fare-options")],
    },
  ];

  for (const [rung, settings, flags] of [
    ["default", {}, []],
    ["setting", { currency: "SAR" }, []],
    ["explicit", { currency: "SAR" }, ["--currency", "USD"]],
  ] as const) {
    for (const read of priced) {
      it(`${read.argv.slice(0, 2).join(" ")} names the currency rung: ${rung}`, async () => {
        signIn(s.home);
        writeSettings(s.home, settings);
        s.fake({ routes: read.routes() });
        const result = await s.run([...read.argv, ...flags]);
        expect(result.code).toBe(0);
        expect(json<Printed>(result).currencyCodeSource).toBe(rung);
      });
    }
  }

  const everyPriced = [
    {
      argv: ["flights", "search", "RUH", "DXB", "2099-03-01"],
      routes: () => searchRoutes(),
    },
    ...priced,
  ];
  for (const read of everyPriced) {
    it(`${read.argv.slice(0, 2).join(" ")} prints one *Source per knob, top level`, async () => {
      // The API's request-scoped copies inside `metadata` disagree with the CLI's
      // label by construction when a preference is stored, so they are stripped
      // at print time and the echoes themselves are kept.
      signIn(s.home);
      writeSettings(s.home, { currency: "SAR" });
      s.fake({ routes: read.routes() });
      const result = await s.run(read.argv);

      expect(result.code).toBe(0);
      const printed = json<Printed>(result);
      expect(printed.currencyCodeSource).toBe("setting");
      expect(result.out.split('"currencyCodeSource"').length - 1).toBe(1);
      expect(result.out).not.toContain("localeSource");
      expect(
        Object.keys(printed.metadata).filter((k) => k.endsWith("Source")),
      ).toEqual([]);
      expect(printed.metadata).toHaveProperty("locale");
    });
  }
});

describe("flights trip", () => {
  it("forwards --view, and sends none without the flag", async () => {
    signIn(s.home);
    const fake = s.fake({ routes: [route("flights-trip")] });
    const argv = ["flights", "trip", TRIP_ID, "--search", SEARCH_ID];
    expect((await s.run([...argv, "--view", "detail"])).code).toBe(0);
    expect((await s.run(argv)).code).toBe(0);

    const [flagged, bare] = fake.requests("getFlightTrip");
    expect(flagged?.pathParams.tripId).toBe(TRIP_ID);
    expect(flagged?.query.get("searchId")).toBe(SEARCH_ID);
    expect(flagged?.query.get("view")).toBe("detail");
    // Omitted, not spelled as the server's own default.
    expect(bare?.query.has("view")).toBe(false);
  });

  it("refuses an unknown --view locally, exit 2", async () => {
    signIn(s.home);
    const fake = s.fake();
    const result = await s.run([
      "flights",
      "trip",
      TRIP_ID,
      "--search",
      SEARCH_ID,
      "--view",
      "detials",
    ]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("--view must be one of default, detail");
    expect(fake.seen).toEqual([]);
  });

  it("requires --search, exit 2", async () => {
    signIn(s.home);
    const fake = s.fake();
    const result = await s.run(["flights", "trip", TRIP_ID]);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/--search/);
    expect(fake.seen).toEqual([]);
  });
});

describe("flights fares and experience", () => {
  it("fares prints the fare options and forwards currency and locale", async () => {
    signIn(s.home);
    const fake = s.fake({ routes: [route("flights-fare-options")] });
    const result = await s.run([
      "flights",
      "fares",
      FARE_ID,
      "--currency",
      "USD",
      "--locale",
      "en",
    ]);

    expect(result.code).toBe(0);
    expect(
      json<{ options: { fareOptionId: string }[] }>(result).options[0]
        ?.fareOptionId,
    ).toBe(body("flights-fare-options").options[0].fareOptionId);
    const [sent] = fake.requests("getFareOptions");
    expect(sent?.pathParams.fareId).toBe(FARE_ID);
    expect(query(sent)).toEqual({ currency: "USD", locale: "en" });
  });

  it("an expired fare exits 4 with the re-search hint", async () => {
    signIn(s.home);
    s.fake({
      routes: [{ op: "getFareOptions", answers: [problem(404, "not_found")] }],
    });
    const result = await s.run(["flights", "fares", FARE_ID]);
    expect(result.code).toBe(4);
    expect(result.err).toMatch(/expired|search again|re-open/i);
  });

  it("experience prints the per-leg signals and sends no query by default", async () => {
    signIn(s.home);
    const fake = s.fake({ routes: [route("flights-experience")] });
    const result = await s.run(["flights", "experience", EXPERIENCE_TRIP]);

    expect(result.code).toBe(0);
    expect(json<{ legs: unknown[] }>(result).legs).toEqual(
      body("flights-experience").legs,
    );
    const [sent] = fake.requests("getTripExperience");
    expect(sent?.pathParams.tripId).toBe(EXPERIENCE_TRIP);
    expect(query(sent)).toEqual({});
  });

  it("experience forwards --search as the cross-check", async () => {
    signIn(s.home);
    const fake = s.fake({ routes: [route("flights-experience")] });
    expect(
      (
        await s.run([
          "flights",
          "experience",
          EXPERIENCE_TRIP,
          "--search",
          SEARCH_ID,
        ])
      ).code,
    ).toBe(0);
    expect(query(fake.requests("getTripExperience")[0])).toEqual({
      searchId: SEARCH_ID,
    });
  });

  it("experience on an expired trip exits 4 with the re-search hint", async () => {
    signIn(s.home);
    s.fake({
      routes: [
        { op: "getTripExperience", answers: [problem(404, "not_found")] },
      ],
    });
    const result = await s.run(["flights", "experience", EXPERIENCE_TRIP]);
    expect(result.code).toBe(4);
    expect(result.err).toMatch(/expired|search again|re-open/i);
  });

  it("experience without a tripId is a usage error, no request", async () => {
    signIn(s.home);
    const fake = s.fake();
    const result = await s.run(["flights", "experience"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("flights experience <tripId>");
    expect(fake.seen).toEqual([]);
  });
});

describe("flights booking-link", () => {
  const required = [
    "--trip",
    TRIP_ID,
    "--from",
    "SIN",
    "--to",
    "BKK",
    "--date",
    "2099-08-01",
  ];

  it("maps every flag to the query and prints the booking URL", async () => {
    signIn(s.home);
    const fake = s.fake({ routes: [route("flights-booking-link")] });
    const result = await s.run([
      "flights",
      "booking-link",
      FARE_ID,
      "--trip",
      TRIP_ID,
      "--search",
      SEARCH_ID,
      "--fare-option",
      "uuid-1",
      "--from",
      "SIN",
      "--to",
      "BKK",
      "--date",
      "2099-08-01",
      "--return",
      "2099-08-08",
      "--cabin",
      "business",
      "--adults",
      "2",
      "--children",
      "1",
      "--infants",
      "1",
      "--site",
      "SG",
      "--currency",
      "USD",
      "--locale",
      "en",
      "--from-city",
      "--to-city",
    ]);

    expect(result.code).toBe(0);
    expect(json(result)).toEqual(body("flights-booking-link"));
    const [sent] = fake.requests("getFareBookingLink");
    expect(sent?.pathParams.fareId).toBe(FARE_ID);
    expect(query(sent)).toEqual({
      tripId: TRIP_ID,
      searchId: SEARCH_ID,
      fareOptionId: "uuid-1",
      from: "SIN",
      to: "BKK",
      fromDate: "2099-08-01",
      toDate: "2099-08-08",
      cabin: "business",
      adults: "2",
      children: "1",
      infants: "1",
      siteCode: "SG",
      currency: "USD",
      locale: "en",
      fromCity: "true",
      toCity: "true",
    });
  });

  it("accepts --children 0 and --infants 0", async () => {
    signIn(s.home);
    const fake = s.fake({ routes: [route("flights-booking-link")] });
    const result = await s.run([
      "flights",
      "booking-link",
      FARE_ID,
      "--fare-option",
      "uuid-1",
      ...required,
      "--children",
      "0",
      "--infants",
      "0",
    ]);
    expect(result.code).toBe(0);
    expect(query(fake.requests("getFareBookingLink")[0])).toMatchObject({
      children: "0",
      infants: "0",
    });
  });

  for (const form of [
    ["--fare-option", "uuid-1", "--fare-option", "uuid-2"],
    ["--fare-option", "uuid-1,uuid-2"],
  ]) {
    it(`${form.join(" ")} sends one fare option per leg`, async () => {
      signIn(s.home);
      const fake = s.fake({ routes: [route("flights-booking-link")] });
      const result = await s.run([
        "flights",
        "booking-link",
        FARE_ID,
        ...form,
        ...required,
      ]);
      expect(result.code).toBe(0);
      expect(
        fake.requests("getFareBookingLink")[0]?.query.getAll("fareOptionId"),
      ).toEqual(["uuid-1,uuid-2"]);
    });
  }

  it("without the required flags is a usage error, no request", async () => {
    signIn(s.home);
    const fake = s.fake();
    const result = await s.run(["flights", "booking-link", FARE_ID]);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/--trip is required|Usage/);
    expect(fake.seen).toEqual([]);
  });

  it("without --fare-option is a usage error that points at `flights fares`", async () => {
    // A Book-on-Wego link with no selected branded fare dead-ends at checkout.
    signIn(s.home);
    const fake = s.fake();
    const result = await s.run([
      "flights",
      "booking-link",
      FARE_ID,
      ...required,
    ]);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/--fare-option is required/);
    expect(result.err).toContain("wego flights fares");
    expect(fake.seen).toEqual([]);
  });

  for (const extra of [
    ["--date", "2099-02-30"],
    ["--date", "01-08-2099"],
    ["--adults", "10"],
    ["--children", "9"],
    ["--infants", "9"],
    ["--adults", "1", "--infants", "2"],
    ["--return", "2099-13-01"],
  ]) {
    it(`booking-link ${extra.join(" ")} is a usage error, no request`, async () => {
      signIn(s.home);
      const fake = s.fake();
      // The later --date wins over the one in `required`.
      const result = await s.run([
        "flights",
        "booking-link",
        FARE_ID,
        "--fare-option",
        "uuid-1",
        ...required,
        ...extra,
      ]);
      expect(result.code).toBe(2);
      expect(fake.seen).toEqual([]);
    });
  }

  it("a repeated fare option is a usage error, no request", async () => {
    signIn(s.home);
    const fake = s.fake();
    const result = await s.run([
      "flights",
      "booking-link",
      FARE_ID,
      "--fare-option",
      "uuid-1",
      "--fare-option",
      "uuid-1",
      ...required,
    ]);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/must not repeat a fare option id/);
    expect(fake.seen).toEqual([]);
  });

  for (const form of [
    ["--fare-option", "uuid-1,,uuid-2"],
    ["--fare-option", "uuid-1,"],
    ["--fare-option", ",uuid-1"],
    ["--fare-option", " "],
    ["--fare-option=uuid-1,,uuid-2"],
    ["--fare-option", "uuid-1", "--fare-option", " "],
  ]) {
    it(`a blank fare option id (${JSON.stringify(form)}) is a usage error, never dropped`, async () => {
      signIn(s.home);
      const fake = s.fake();
      const result = await s.run([
        "flights",
        "booking-link",
        FARE_ID,
        ...form,
        ...required,
      ]);
      expect(result.code).toBe(2);
      expect(result.err).toMatch(/blank fare option id/);
      expect(fake.seen).toEqual([]);
    });
  }
});

describe("flights share", () => {
  const leg = ["flights", "share", "SIN", "BKK", "2099-09-15"];

  it("maps positionals and every flag to the query and prints the durable URL", async () => {
    signIn(s.home);
    const fake = s.fake({ routes: [route("flights-search-link")] });
    const result = await s.run([
      ...leg,
      "--return",
      "2099-09-22",
      "--cabin",
      "business",
      "--adults",
      "2",
      "--children",
      "1",
      "--infants",
      "1",
      "--site",
      "SG",
      "--currency",
      "USD",
      "--locale",
      "en",
      "--from-city",
      "--to-city",
    ]);

    expect(result.code).toBe(0);
    expect(json(result)).toEqual(body("flights-search-link"));
    // No search-scoped id rides along: the link outlives any search.
    expect(query(fake.requests("getFlightSearchLink")[0])).toEqual({
      from: "SIN",
      to: "BKK",
      fromDate: "2099-09-15",
      toDate: "2099-09-22",
      cabin: "business",
      adults: "2",
      children: "1",
      infants: "1",
      siteCode: "SG",
      currency: "USD",
      locale: "en",
      fromCity: "true",
      toCity: "true",
    });
  });

  it("inherits the stored currency, locale and site, over the account market", async () => {
    signIn(s.home, { accessToken: "access-1", market: "AE" });
    writeSettings(s.home, { currency: "SAR", locale: "ar", site: "SA" });
    const fake = s.fake({ routes: [route("flights-search-link")] });
    expect((await s.run(leg)).code).toBe(0);
    expect(query(fake.requests("getFlightSearchLink")[0])).toMatchObject({
      currency: "SAR",
      locale: "ar",
      siteCode: "SA",
    });
  });

  it("an explicit flag beats the stored setting", async () => {
    signIn(s.home);
    writeSettings(s.home, { currency: "SAR", site: "SA" });
    const fake = s.fake({ routes: [route("flights-search-link")] });
    expect(
      (await s.run([...leg, "--currency", "USD", "--site", "SG"])).code,
    ).toBe(0);
    expect(query(fake.requests("getFlightSearchLink")[0])).toMatchObject({
      currency: "USD",
      siteCode: "SG",
    });
  });

  for (const cabin of ["economy", "premium_economy", "business", "first"]) {
    it(`accepts the published cabin ${cabin}`, async () => {
      signIn(s.home);
      const fake = s.fake({ routes: [route("flights-search-link")] });
      expect((await s.run([...leg, "--cabin", cabin])).code).toBe(0);
      expect(fake.requests("getFlightSearchLink")[0]?.query.get("cabin")).toBe(
        cabin,
      );
    });
  }

  const refused: [string, string[]][] = [
    ["no positionals", ["flights", "share"]],
    ["one positional", ["flights", "share", "SIN"]],
    ["two positionals", ["flights", "share", "SIN", "BKK"]],
    ["an unknown flag", [...leg, "--trip", "abc:TR1"]],
    ["a fourth positional", [...leg, "extra"]],
    ["--adults 0", [...leg, "--adults", "0"]],
    ["--adults 10", [...leg, "--adults", "10"]],
    ["--children -1", [...leg, "--children", "-1"]],
    ["--children 9", [...leg, "--children", "9"]],
    ["--infants -1", [...leg, "--infants", "-1"]],
    ["--infants 9", [...leg, "--infants", "9"]],
    ["more infants than adults", [...leg, "--adults", "1", "--infants", "2"]],
    ["more infants than the default adult", [...leg, "--infants", "2"]],
    ["a wrong date shape", ["flights", "share", "SIN", "BKK", "15-09-2099"]],
    ["a non-calendar date", ["flights", "share", "SIN", "BKK", "2099-02-30"]],
    ["a non-calendar return", [...leg, "--return", "2099-13-01"]],
    ["a malformed return", [...leg, "--return", "nope"]],
  ];
  for (const [what, argv] of refused) {
    it(`share with ${what} is a usage error, no request`, async () => {
      signIn(s.home);
      const fake = s.fake();
      const result = await s.run(argv);
      expect(result.code).toBe(2);
      expect(fake.seen).toEqual([]);
    });
  }

  it("an unknown --cabin names the published set, no request", async () => {
    signIn(s.home);
    const fake = s.fake();
    const result = await s.run([...leg, "--cabin", "coach"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("--cabin must be one of");
    expect(fake.seen).toEqual([]);
  });

  it("--help prints its usage on stdout with exit 0", async () => {
    const result = await s.run(["flights", "share", "--help"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("flights share");
    expect(result.err).toBe("");
  });
});

describe("flights help and dispatch", () => {
  for (const help of ["-h", "--help", "help"]) {
    it(`flights ${help}: the group usage on stdout, exit 0, empty stderr`, async () => {
      const result = await s.run(["flights", help]);
      expect(result.code).toBe(0);
      expect(result.out).toMatch(/^Usage: wego flights/);
      expect(result.out).toMatch(/^ {2}search /m);
      expect(result.out).toMatch(/^ {2}booking-link /m);
      expect(result.err).toBe("");
    });
  }

  for (const sub of [
    "search",
    "results",
    "trip",
    "experience",
    "fares",
    "booking-link",
  ]) {
    for (const help of ["help", "--help", "-h"]) {
      it(`flights ${sub} ${help}: that command's usage, exit 0, no request`, async () => {
        signIn(s.home);
        const fake = s.fake();
        const result = await s.run(["flights", sub, help]);
        expect(result.code).toBe(0);
        expect(result.out).toContain(`Usage: wego flights ${sub}`);
        expect(result.err).toBe("");
        expect(fake.seen).toEqual([]);
      });
    }
  }

  it("an unknown sub-command exits 2 with the usage on stderr", async () => {
    const result = await s.run(["flights", "bogus"]);
    expect(result.code).toBe(2);
    expect(result.out).toBe("");
    expect(result.err).toMatch(/Unknown flights sub-command: bogus/);
    expect(result.err).toMatch(/Usage:/);
  });

  it("a bare `flights` exits 2 with the usage on stderr", async () => {
    const result = await s.run(["flights"]);
    expect(result.code).toBe(2);
    expect(result.out).toBe("");
    expect(result.err).toMatch(/Usage/);
  });

  it("an unknown leaf option exits 2, not confused with --help", async () => {
    const result = await s.run(["flights", "results", "--bogus"]);
    expect(result.code).toBe(2);
    expect(result.out).toBe("");
    expect(result.err).toMatch(/Unknown option: --bogus/);
  });
});
