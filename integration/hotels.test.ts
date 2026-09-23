/**
 * `wego hotels …`: the seven sub-commands as a caller sees them, exit code, stdout
 * JSON, stderr, and what reaches the wire. The `/rates` settle loop, the `rooms`
 * parser and the empty-page note stay in `src/hotels.test.ts`.
 *
 * `rooms` is the slow one: its settle reads `/rates` 1.5 s apart, four steady
 * reads for a page with rates and two for a completed empty one. So only one
 * scenario waits out a full page; the rest answer a completed empty page, and
 * the budget-exhausted paths (13.5 s for rates, 22.5 s for results) are the unit
 * tests' job.
 */

import { describe, expect, it } from "bun:test";
import { type Answer, problem } from "./harness/fake";
import { answer, readFixture, route } from "./harness/fixtures";
import { useScenario } from "./harness/scenario";
import { type CliResult, json, signIn, writeSettings } from "./harness/wego";

const s = useScenario();

/** Values the output must carry are read from the fixture, so editing a
 *  fixture does not break a scenario that asserts on them. */
// biome-ignore lint/suspicious/noExplicitAny: a fixture body is untyped JSON
const body = (name: string) => readFixture(name).body as any;

// biome-ignore lint/suspicious/noExplicitAny: a fixture body is untyped JSON
type Edit = (b: any) => unknown;

const DATES = ["2099-03-01", "2099-03-05"];
const SEARCH = ["hotels", "search", "DXB", ...DATES];
const HOTEL = String(body("hotels-rates").hotelId);
const MINT = ["hotels", "rooms", HOTEL, ...DATES];
const CITY_SID = body("hotels-search-create").searchId;
const HOTEL_SID = body("hotels-rooms-create").searchId;
const RATE_ID = body("hotels-rates").rates[0].id;

/** A results page, edited for one scenario. */
const page = (edit: Edit): Answer => answer("hotels-search-results", edit);

/** A completed page with no hotels, over `totalCandidates` candidates. */
const emptyPage = (complete: boolean, totalCandidates: number): Answer =>
  page((b) => ({
    ...b,
    searchComplete: complete,
    results: [],
    metadata: { ...b.metadata, resultCount: 0, totalCandidates },
  }));

/** A page whose settle signal (`snapshotCandidateCount`) reads `count`. */
const counted = (count: number, complete = false): Answer =>
  page((b) => ({
    ...b,
    searchComplete: complete,
    metadata: { ...b.metadata, snapshotCandidateCount: count },
  }));

/** A completed rates page with no rates: two reads settle it, 1.5 s. */
const noRates = answer("hotels-rates", (b) => ({
  ...b,
  searchComplete: true,
  rates: [],
}));

const created = (edit: Edit = (b) => b) => ({
  op: "createHotelSearch",
  answers: [answer("hotels-rooms-create", edit)],
});

const createBody = (fake: { requests: (op: string) => { body: unknown }[] }) =>
  fake.requests("createHotelSearch")[0]?.body as Record<string, unknown>;

const query = (
  fake: { requests: (op: string) => { query: URLSearchParams }[] },
  op: string,
) => Object.fromEntries(fake.requests(op)[0]?.query ?? []);

/** The #1534 rule: the API's request-scoped `*Source` copies inside `metadata`
 *  are stripped at print time, so the CLI's own top-level label is the ONE
 *  `*Source` a payload carries per knob. The `locale` echo stays. */
function expectOneSourcePerKnob(
  result: CliResult,
  source: string,
  fixture: string,
) {
  expect(result.out).not.toContain("localeSource");
  expect(result.out).toContain(`"locale": "${body(fixture).metadata.locale}"`);
  const printed = json<{
    currencyCodeSource: string;
    metadata?: Record<string, unknown>;
  }>(result);
  expect(printed.currencyCodeSource).toBe(source);
  expect(result.out.split('"currencyCodeSource"').length - 1).toBe(1);
  expect(
    Object.keys(printed.metadata ?? {}).filter((k) => k.endsWith("Source")),
  ).toEqual([]);
}

/** A usage error: exit 2, nothing on stdout, the message on stderr, no request. */
async function expectUsageError(
  argv: string[],
  says: string | RegExp,
  never?: string,
) {
  signIn(s.home);
  const fake = s.fake();
  const result = await s.run(argv);
  expect(result.code).toBe(2);
  expect(result.out).toBe("");
  if (typeof says === "string") expect(result.err).toContain(says);
  else expect(result.err).toMatch(says);
  if (never !== undefined) expect(result.err).not.toContain(never);
  expect(fake.seen).toEqual([]);
}

describe("hotels help", () => {
  for (const help of ["-h", "--help", "help"]) {
    it(`hotels ${help}: the group usage on stdout, exit 0, empty stderr`, async () => {
      const result = await s.run(["hotels", help]);
      expect(result.code).toBe(0);
      expect(result.out).toMatch(/^Usage: wego hotels/);
      expect(result.out).toMatch(/^ {2}booking-link /m);
      expect(result.err).toBe("");
    });
  }

  for (const sub of [
    "search",
    "results",
    "details",
    "reviews",
    "rooms",
    "booking-link",
    "share",
  ]) {
    for (const help of ["help", "-h", "--help"]) {
      it(`hotels ${sub} ${help}: that command's own usage on stdout, exit 0`, async () => {
        const result = await s.run(["hotels", sub, help]);
        expect(result.code).toBe(0);
        expect(result.out).toContain(`Usage: wego hotels ${sub}`);
        expect(result.err).toBe("");
      });
    }
  }

  it("an unknown sub-command prints the group usage on stderr, exit 2", async () => {
    await expectUsageError(["hotels", "frobnicate"], "Usage: wego hotels");
  });

  it("an unknown option on a leaf names it, exit 2", async () => {
    await expectUsageError(
      ["hotels", "booking-link", "85481", "--bogus"],
      /Unknown option: --bogus/,
    );
  });
});

describe("hotels usage errors: exit 2, no request", () => {
  const cases: [string, string[], string, string?][] = [
    [
      "search: a bad location",
      [...SEARCH.slice(0, 2), "not-a-place", ...DATES],
      "Invalid location",
    ],
    [
      "search: --children-ages that disagree with --children",
      [...SEARCH, "--children", "1", "--children-ages", "5,11"],
      "must equal --children",
    ],
    [
      "search: --children-ages without --children",
      [...SEARCH, "--children-ages", "11"],
      "requires --children",
    ],
    [
      "search: an age over 17",
      [...SEARCH, "--children", "1", "--children-ages", "18"],
      "0–17",
    ],
    [
      "search: nine children, over the cap of eight",
      [...SEARCH, "--children", "9", "--children-ages", "1,2,3,4,5,6,7,8,9"],
      "between 0 and 8",
    ],
    [
      "search: a non-numeric age",
      [...SEARCH, "--children", "1", "--children-ages", "abc"],
      "0–17",
    ],
    [
      "search: a negative age",
      [...SEARCH, "--children", "1", "--children-ages", "-1"],
      "0–17",
    ],
    [
      "search: an ages list that is empty once split",
      [...SEARCH, "--children-ages", ","],
      "at least one age",
    ],
    [
      "results: --wait=1",
      ["hotels", "results", "sid-1", "--wait=1"],
      "--wait takes no value",
    ],
    [
      "results: a non-numeric --page",
      ["hotels", "results", "sid-1", "--page", "abc"],
      "--page must be a positive integer",
    ],
    [
      "results: --page-size over the API's 50",
      ["hotels", "results", "sid-1", "--page-size", "500"],
      "--page-size must be between 1 and 50",
    ],
    [
      "results: an unknown --sort",
      ["hotels", "results", "sid-1", "--sort", "cheapest"],
      "--sort must be one of",
    ],
    [
      "results: the /reviews spelling of --guest-type",
      ["hotels", "results", "sid-1", "--guest-type", "family_with_children"],
      "--guest-type must be one of",
    ],
    ...["abc", "-1", "11", "Infinity"].map(
      (bad): [string, string[], string] => [
        `results: --min-guest-rating ${bad}`,
        [
          "hotels",
          "results",
          "sid-1",
          "--guest-type",
          "family",
          "--min-guest-rating",
          bad,
        ],
        "--min-guest-rating must be a number between 0 and 10",
      ],
    ),
    [
      "results: --view, gone since the read has one projection",
      ["hotels", "results", "sid-1", "--view", "card"],
      "Unknown option: --view",
    ],
    [
      "results: a non-boolean --refundable",
      ["hotels", "results", "sid-1", "--refundable", "yes"],
      "--refundable must be one of",
    ],
    [
      "results: an extra positional",
      ["hotels", "results", "sid-1", "extra"],
      "Unexpected argument: extra",
    ],
    [
      "details: an unknown --view",
      ["hotels", "details", "85481", "--view", "summary"],
      "--view must be one of",
    ],
    [
      "details: a hotelId that is not a number",
      ["hotels", "details", "not-a-number"],
      "hotelId must be a positive integer",
    ],
    [
      "details: an extra positional",
      ["hotels", "details", "85481", "extra"],
      "Unexpected argument: extra",
    ],
    [
      "details: the extra positional is reported before an invalid id",
      ["hotels", "details", "abc", "extra"],
      "Unexpected argument: extra",
      "hotelId must be a positive integer",
    ],
    ...[",", " ", ",,"].map((value): [string, string[], string] => [
      `reviews: --topics "${value}"`,
      ["hotels", "reviews", "85481", "--topics", value],
      "--topics needs at least one",
    ]),
    ...[
      ["--sort", "newest"],
      ["--guest-type", "business"],
      ["--view", "full"],
    ].map(([flag, value]): [string, string[], string] => [
      `reviews: ${flag} ${value}`,
      ["hotels", "reviews", "85481", flag, value],
      `${flag} must be one of`,
    ]),
    [
      "reviews: --page-size is rejected, not clamped",
      ["hotels", "reviews", "85481", "--page-size", "500"],
      "--page-size must be between 1 and 50",
    ],
    [
      "reviews: a hotelId that is not a number",
      ["hotels", "reviews", "not-a-number"],
      "hotelId must be a positive integer",
    ],
    [
      "rooms: the dates positionally AND as flags",
      [...MINT, "--check-in", "2099-04-01", "--check-out", "2099-04-05"],
      "not both",
    ],
    [
      "rooms: one positional date",
      ["hotels", "rooms", "85481", "2099-03-01"],
      "<checkIn> <checkOut>",
    ],
    [
      "rooms: positional dates alongside --search",
      [...MINT, "--search", "sid-1"],
      "positional dates",
    ],
    [
      "rooms: neither --search nor dates",
      ["hotels", "rooms", "85481"],
      "<checkIn> <checkOut>",
    ],
    [
      "rooms: --search and the date flags",
      [
        "hotels",
        "rooms",
        "85481",
        "--search",
        "sid-1",
        "--check-in",
        "2099-03-01",
        "--check-out",
        "2099-03-05",
      ],
      "--check-in, --check-out, not both",
    ],
    [
      "rooms: names only the conflicting flags actually passed",
      ["hotels", "rooms", "85481", "--search", "sid-1", "--adults", "3"],
      "--adults, not both",
      "--check-in,",
    ],
    ...["--check-in", "--check-out", "--adults", "--children", "--rooms"].map(
      (flag): [string, string[], string] => [
        `rooms: ${flag} alongside --search`,
        ["hotels", "rooms", "85481", "--search", "sid-1", flag, "1"],
        flag,
      ],
    ),
    [
      "rooms: --children-ages alongside --search, before the --children pairing check",
      ["hotels", "rooms", "85481", "--search", "sid-1", "--children-ages", "5"],
      "not both",
      "requires --children",
    ],
    [
      "rooms: --site alongside --search, whose search fixed the market",
      ["hotels", "rooms", "85481", "--search", "sid-1", "--site", "AE"],
      "--site",
    ],
    [
      "rooms: an extra positional",
      [...MINT, "extra"],
      "Unexpected argument: extra",
    ],
    ["booking-link: no --rate", ["hotels", "booking-link", "85481"], "--rate"],
    [
      "booking-link: an extra positional",
      ["hotels", "booking-link", "85481", "extra", "--rate", "r1"],
      "Unexpected argument: extra",
    ],
    ...[
      ["--adults", "2"],
      ["--children-ages", "11"],
      ["--guests", "2:11"],
    ].map(([flag, value]): [string, string[], string] => [
      `booking-link: the dropped ${flag}`,
      ["hotels", "booking-link", "85481", "--rate", "r1", flag, value],
      `Unknown option: ${flag}`,
    ]),
    [
      "booking-link: a malformed --country",
      ["hotels", "booking-link", "85481", "--rate", "r1", "--country", "usa"],
      "2-letter ISO country code",
    ],
    [
      "share: more rooms than the default two adults",
      ["hotels", "share", "BKK", ...DATES, "--rooms", "3"],
      "the default when --adults is omitted",
    ],
    [
      "share: a non-numeric --rooms",
      ["hotels", "share", "BKK", ...DATES, "--rooms", "two"],
      "--rooms",
    ],
    [
      "share: a hotelId, naming the city code as the way through",
      ["hotels", "share", "710862", ...DATES],
      "city code",
    ],
    [
      "share: lat,lng",
      ["hotels", "share", "13.75,100.5", ...DATES],
      "city code",
    ],
    [
      "share: a bare city name, with the city-code message",
      ["hotels", "share", "bangkok", ...DATES],
      "city code",
      "hotelId",
    ],
    [
      "share: --children without ages, so no guessed age reaches the link",
      ["hotels", "share", "BKK", ...DATES, "--children", "1"],
      "--children-ages",
    ],
    [
      "share: --children-ages that disagree with --children",
      [
        "hotels",
        "share",
        "BKK",
        ...DATES,
        "--children",
        "2",
        "--children-ages",
        "5",
      ],
      "1 age(s) but --children is 2",
    ],
    [
      "share: an extra positional",
      ["hotels", "share", "BKK", ...DATES, "extra"],
      "Unexpected argument: extra",
    ],
  ];

  for (const [name, argv, says, never] of cases) {
    it(name, async () => {
      await expectUsageError(argv, says, never);
    });
  }
});

describe("hotels search", () => {
  it("creates the search, prints the settled first page, and hints at a currency setting", async () => {
    signIn(s.home);
    const fake = s.fake({
      routes: [route("hotels-search-create"), route("hotels-search-results")],
    });
    const result = await s.run(SEARCH);

    expect(result.code).toBe(0);
    expect(createBody(fake)).toMatchObject({
      cityCode: "DXB",
      checkIn: DATES[0],
      checkOut: DATES[1],
    });
    expect(fake.requests("getHotelSearchResults")[0]?.pathParams.searchId).toBe(
      CITY_SID,
    );
    expect(fake.seen.every((r) => r.token === "access-1")).toBe(true);
    const printed = json<{ results: { name: string }[]; settled: string }>(
      result,
    );
    expect(printed.results[0]?.name).toBe(
      body("hotels-search-results").results[0].name,
    );
    expect(printed.settled).toBe("converged");
    // The one stderr line on a fresh machine is the currency-setting hint the
    // search prints while no currency is stored (issue #1386).
    expect(result.err.trim().split("\n")).toEqual([
      expect.stringContaining("config set currency"),
    ]);
  });

  for (const [rung, settings, flags, source, sent] of [
    [
      "a flag beats the setting",
      { currency: "SAR" },
      ["--currency", "USD"],
      "explicit",
      "USD",
    ],
    [
      "the setting decides without a flag",
      { currency: "SAR" },
      [],
      "setting",
      "SAR",
    ],
    ["neither leaves it to the API's default", {}, [], "default", undefined],
  ] as const) {
    it(`names the layer the currency came from: ${rung}`, async () => {
      // The create and the settle read must carry the SAME resolved currency
      // (#1400), so the page is priced in the unit the search was created in.
      signIn(s.home);
      writeSettings(s.home, settings);
      const fake = s.fake({
        routes: [route("hotels-search-create"), route("hotels-search-results")],
      });
      const result = await s.run([...SEARCH, ...flags]);

      expect(result.code).toBe(0);
      expect(
        json<{ currencyCodeSource: string }>(result).currencyCodeSource,
      ).toBe(source);
      expect(createBody(fake).currency).toBe(sent);
      for (const read of fake.requests("getHotelSearchResults")) {
        expect(read.query.get("currency") ?? undefined).toBe(sent);
      }
    });
  }

  it("prints one *Source per knob, top level, in the CLI's vocabulary", async () => {
    signIn(s.home);
    writeSettings(s.home, { currency: "SAR" });
    s.fake({
      routes: [route("hotels-search-create"), route("hotels-search-results")],
    });
    const result = await s.run(SEARCH);
    expect(result.code).toBe(0);
    expectOneSourcePerKnob(result, "setting", "hotels-search-results");
  });

  it("forwards an explicit --children 0 rather than refusing it", async () => {
    signIn(s.home);
    const fake = s.fake({
      routes: [route("hotels-search-create"), route("hotels-search-results")],
    });
    const result = await s.run([...SEARCH, "--children", "0"]);
    expect(result.code).toBe(0);
    expect(createBody(fake).children).toBe(0);
  });

  it("sends --children-ages on the create and prints the priced occupancy it echoes", async () => {
    signIn(s.home);
    const fake = s.fake({
      routes: [route("hotels-search-create"), route("hotels-search-results")],
    });
    const result = await s.run([
      ...SEARCH,
      "--children",
      "1",
      "--children-ages",
      "11",
    ]);

    expect(result.code).toBe(0);
    expect(createBody(fake).childrenAges).toEqual([11]);
    expect(json<{ occupancy: unknown }>(result).occupancy).toEqual(
      body("hotels-search-create").occupancy,
    );
    expect(result.err.trim().split("\n")).toEqual([
      expect.stringContaining("config set currency"),
    ]);
  });

  it("accepts exactly eight children's ages, the cap", async () => {
    signIn(s.home);
    const fake = s.fake({
      routes: [route("hotels-search-create"), route("hotels-search-results")],
    });
    const result = await s.run([
      ...SEARCH,
      "--children",
      "8",
      "--children-ages",
      "1,2,3,4,5,6,7,8",
    ]);
    expect(result.code).toBe(0);
    expect(createBody(fake).childrenAges).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("re-reads while the page is empty and stops once hotels arrive and the count holds", async () => {
    signIn(s.home);
    const later = page((b) => ({ ...b, searchComplete: true }));
    const fake = s.fake({
      routes: [
        route("hotels-search-create"),
        {
          op: "getHotelSearchResults",
          answers: [
            page((b) => ({
              ...b,
              searchComplete: false,
              results: [],
              metadata: { ...b.metadata, snapshotCandidateCount: 0 },
            })),
            later,
          ],
        },
      ],
    });
    const result = await s.run(SEARCH);

    expect(result.code).toBe(0);
    // Empty, then the full page twice: the second full read confirms the count.
    expect(fake.requests("getHotelSearchResults")).toHaveLength(3);
    expect(json<{ results: { name: string }[] }>(result).results[0]?.name).toBe(
      body("hotels-search-results").results[0].name,
    );
  });

  it("converges on a steady candidate count while searchComplete stays false (#1084)", async () => {
    signIn(s.home);
    const fake = s.fake({
      routes: [
        route("hotels-search-create"),
        { op: "getHotelSearchResults", answers: [counted(4), counted(7)] },
      ],
    });
    const result = await s.run(SEARCH);

    expect(result.code).toBe(0);
    // 4, then 7, then 7 again: equal across two reads, so it stops at the third.
    expect(fake.requests("getHotelSearchResults")).toHaveLength(3);
    const printed = json<{ settled: string; searchComplete: boolean }>(result);
    expect(printed.settled).toBe("converged");
    expect(printed.searchComplete).toBe(false);
  });

  it("stops on a completed empty page and prints no still-settling hint", async () => {
    signIn(s.home);
    const fake = s.fake({
      routes: [
        route("hotels-search-create"),
        { op: "getHotelSearchResults", answers: [emptyPage(true, 12)] },
      ],
    });
    const result = await s.run(SEARCH);

    expect(result.code).toBe(0);
    // Complete, then the count confirmed on the next read: far short of the budget.
    expect(fake.requests("getHotelSearchResults")).toHaveLength(2);
    expect(result.err).not.toContain("No hotels have settled yet");
    expect(result.err).not.toContain("no hotels match");
  });

  it("reports a completed zero-candidate search as a no-match, exit 0", async () => {
    signIn(s.home);
    s.fake({
      routes: [
        route("hotels-search-create"),
        { op: "getHotelSearchResults", answers: [emptyPage(true, 0)] },
      ],
    });
    const result = await s.run(SEARCH);

    expect(result.code).toBe(0);
    expect(json<{ results: unknown[] }>(result).results).toEqual([]);
    expect(result.err).toContain("Search complete –");
    expect(result.err).not.toContain("No hotels have settled yet");
  });

  it("keeps the searchId as a re-run hint when the read after the create fails", async () => {
    signIn(s.home);
    const fake = s.fake({
      routes: [
        route("hotels-search-create"),
        {
          op: "getHotelSearchResults",
          answers: [
            problem(503, "upstream_unavailable", "try later", {
              "retry-after": "0",
            }),
          ],
        },
      ],
    });
    const result = await s.run(SEARCH);

    expect(result.code).toBe(5);
    expect(result.out).toBe("");
    expect(fake.requests("createHotelSearch")).toHaveLength(1);
    expect(result.err).toContain(`re-run: wego hotels results ${CITY_SID}`);
  });
});

describe("hotels results", () => {
  it("forwards paging, sort and filters under their published names", async () => {
    signIn(s.home);
    const fake = s.fake({ routes: [route("hotels-search-results")] });
    const result = await s.run([
      "hotels",
      "results",
      CITY_SID,
      "--page",
      "2",
      "--sort",
      "price_asc",
      "--min-star",
      "4",
      "--refundable",
      "true",
    ]);

    expect(result.code).toBe(0);
    expect(fake.seen[0]?.path).toBe(`/v1/hotels/searches/${CITY_SID}/results`);
    expect(query(fake, "getHotelSearchResults")).toEqual({
      page: "2",
      sort: "price_asc",
      "min-star": "4",
      refundable: "true",
    });
  });

  it("forwards --sort guest_rating_desc with the guest cohort", async () => {
    signIn(s.home);
    const fake = s.fake({ routes: [route("hotels-search-results")] });
    const result = await s.run([
      "hotels",
      "results",
      CITY_SID,
      "--sort",
      "guest_rating_desc",
      "--guest-type",
      "family",
      "--min-guest-rating",
      "8.5",
    ]);

    expect(result.code).toBe(0);
    expect(query(fake, "getHotelSearchResults")).toMatchObject({
      sort: "guest_rating_desc",
      "guest-type": "family",
      "min-guest-rating": "8.5",
    });
  });

  it("without --wait: one read, stamped `unsettled`, and an empty page says how to wait", async () => {
    signIn(s.home);
    const fake = s.fake({
      routes: [{ op: "getHotelSearchResults", answers: [emptyPage(false, 0)] }],
    });
    const result = await s.run(["hotels", "results", CITY_SID]);

    expect(result.code).toBe(0);
    expect(fake.requests("getHotelSearchResults")).toHaveLength(1);
    expect(json<{ settled: string }>(result).settled).toBe("unsettled");
    expect(result.err).toContain(
      `No hotels have settled yet – re-run: wego hotels results ${CITY_SID} --wait`,
    );
  });

  it("--wait re-reads while empty and stops once hotels arrive, stderr quiet", async () => {
    signIn(s.home);
    writeSettings(s.home, { currency: "USD" });
    const fake = s.fake({
      routes: [
        {
          op: "getHotelSearchResults",
          answers: [
            page((b) => ({
              ...b,
              searchComplete: false,
              results: [],
              metadata: { ...b.metadata, snapshotCandidateCount: 0 },
            })),
            page((b) => ({ ...b, searchComplete: true })),
          ],
        },
      ],
    });
    const result = await s.run(["hotels", "results", CITY_SID, "--wait"]);

    expect(result.code).toBe(0);
    expect(fake.requests("getHotelSearchResults")).toHaveLength(3);
    expect(json<{ results: { name: string }[] }>(result).results[0]?.name).toBe(
      body("hotels-search-results").results[0].name,
    );
    expect(result.err).toBe("");
  });

  it("--wait prints no re-run hint on a completed empty page", async () => {
    signIn(s.home);
    s.fake({
      routes: [{ op: "getHotelSearchResults", answers: [emptyPage(true, 12)] }],
    });
    const result = await s.run(["hotels", "results", CITY_SID, "--wait"]);

    expect(result.code).toBe(0);
    expect(json<{ results: unknown[] }>(result).results).toEqual([]);
    expect(result.err).not.toContain("No hotels have settled yet");
  });

  it("--wait: a 401 mid-settle refreshes once and restarts the poll on the new token", async () => {
    // The whole settle runs inside one authed call, which retries its callback
    // once on a 401: the poll re-walks from the first read on the fresh token.
    signIn(s.home);
    const fake = s.fake({
      routes: [
        {
          op: "getHotelSearchResults",
          when: (r) => r.token === "access-1",
          answers: [
            counted(0),
            counted(2),
            problem(401, "invalid_token", "token expired"),
          ],
        },
        {
          op: "getHotelSearchResults",
          when: (r) => r.token === "access-2",
          answers: [counted(2)],
        },
      ],
      refresh: [{ access_token: "access-2", refresh_token: "refresh-2" }],
    });
    const result = await s.run(["hotels", "results", CITY_SID, "--wait"]);

    expect(result.code).toBe(0);
    const printed = json<{
      settled: string;
      metadata: { snapshotCandidateCount: number };
    }>(result);
    expect(printed.settled).toBe("converged");
    expect(printed.metadata.snapshotCandidateCount).toBe(2);
    expect(fake.tokenRequests.map((t) => t.grantType)).toEqual([
      "refresh_token",
    ]);
    const reads = fake.requests("getHotelSearchResults");
    expect(reads.filter((r) => r.token === "access-1")).toHaveLength(3);
    expect(reads.filter((r) => r.token === "access-2")).toHaveLength(2);
  });

  for (const [rung, settings, flags, source, sent] of [
    [
      "the stored currency, not the API's USD",
      { currency: "SAR" },
      [],
      "setting",
      "SAR",
    ],
    [
      "an explicit flag over the setting",
      { currency: "SAR" },
      ["--currency", "USD"],
      "explicit",
      "USD",
    ],
    ["the API's default with neither", {}, [], "default", undefined],
  ] as const) {
    it(`a bare read prices in ${rung}, and names the rung`, async () => {
      // A searchId carries no currency, so a bare read applies the stored
      // preference even when the search was created with a flag; repeating the
      // flag on the read is the documented way to match it (docs/settings.md).
      signIn(s.home);
      writeSettings(s.home, settings);
      const fake = s.fake({ routes: [route("hotels-search-results")] });
      const result = await s.run(["hotels", "results", CITY_SID, ...flags]);

      expect(result.code).toBe(0);
      expect(
        json<{ currencyCodeSource: string }>(result).currencyCodeSource,
      ).toBe(source);
      expect(
        fake.requests("getHotelSearchResults")[0]?.query.get("currency") ??
          undefined,
      ).toBe(sent);
    });
  }

  it("prints one *Source per knob, top level, in the CLI's vocabulary", async () => {
    signIn(s.home);
    writeSettings(s.home, { currency: "SAR" });
    s.fake({ routes: [route("hotels-search-results")] });
    const result = await s.run(["hotels", "results", CITY_SID]);
    expect(result.code).toBe(0);
    expectOneSourcePerKnob(result, "setting", "hotels-search-results");
  });
});

describe("hotels details and reviews", () => {
  it("reviews prints the page and reads the hotel it was given", async () => {
    signIn(s.home);
    const fake = s.fake({ routes: [route("hotels-reviews")] });
    const result = await s.run(["hotels", "reviews", HOTEL]);

    expect(result.code).toBe(0);
    expect(fake.seen[0]?.path).toBe(`/v1/hotels/${HOTEL}/reviews`);
    expect(
      json<{ metadata: { totalCandidates: number } }>(result).metadata
        .totalCandidates,
    ).toBe(body("hotels-reviews").metadata.totalCandidates);
    expect(result.err).toBe("");
  });

  it("reviews forwards each flag under its published parameter name", async () => {
    signIn(s.home);
    const fake = s.fake({ routes: [route("hotels-reviews")] });
    const result = await s.run([
      "hotels",
      "reviews",
      HOTEL,
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
    ]);

    expect(result.code).toBe(0);
    // Kebab for the net-new knob, camel for the mirrored one: one request
    // legitimately carries both spellings.
    expect(query(fake, "getHotelReviews")).toEqual({
      topics: "breakfast,pool",
      "guest-type": "couple",
      sort: "rating_desc",
      pageSize: "20",
      view: "detail",
    });
  });

  it("reviews trims the topics it forwards", async () => {
    signIn(s.home);
    const fake = s.fake({ routes: [route("hotels-reviews")] });
    const result = await s.run([
      "hotels",
      "reviews",
      HOTEL,
      "--topics",
      " breakfast , ,pool ",
    ]);
    expect(result.code).toBe(0);
    expect(query(fake, "getHotelReviews").topics).toBe("breakfast,pool");
  });

  it("reviews of an unknown hotel exits 4 with a hint", async () => {
    signIn(s.home);
    s.fake({
      routes: [{ op: "getHotelReviews", answers: [problem(404, "not_found")] }],
    });
    const result = await s.run(["hotels", "reviews", "999999"]);
    expect(result.code).toBe(4);
    expect(result.out).toBe("");
    expect(result.err).toContain("Unknown hotel id");
  });

  it("details and reviews inherit the stored locale and are sent no currency", async () => {
    signIn(s.home);
    writeSettings(s.home, { currency: "SAR", locale: "ar", site: "SA" });
    const fake = s.fake({
      routes: [route("hotels-details"), route("hotels-reviews")],
    });
    expect((await s.run(["hotels", "details", HOTEL])).code).toBe(0);
    expect((await s.run(["hotels", "reviews", HOTEL])).code).toBe(0);

    expect(query(fake, "getHotel")).toEqual({ locale: "ar" });
    expect(query(fake, "getHotelReviews")).toEqual({ locale: "ar" });
  });
});

describe("hotels rooms", () => {
  it("--search: reads a full page to settled, mints nothing, and inherits the currency but never the market", async () => {
    // The one scenario that waits out four steady reads (4.5 s).
    signIn(s.home);
    writeSettings(s.home, { currency: "SAR", site: "SA" });
    const fake = s.fake({ routes: [route("hotels-rates")] });
    const result = await s.run([
      "hotels",
      "rooms",
      HOTEL,
      "--search",
      HOTEL_SID,
    ]);

    expect(result.code).toBe(0);
    expect(fake.requests("createHotelSearch")).toEqual([]);
    expect(fake.requests("getHotelRates")).toHaveLength(4);
    expect(query(fake, "getHotelRates")).toEqual({
      searchId: HOTEL_SID,
      currency: "SAR",
    });
    const printed = json<{
      rates: { id: string }[];
      settled: string;
      occupancy?: unknown;
      siteCode?: string;
    }>(result);
    expect(printed.rates[0]?.id).toBe(RATE_ID);
    expect(printed.settled).toBe("converged");
    // No create, so no occupancy echo and no market to report.
    expect(printed.occupancy).toBeUndefined();
    expect(printed.siteCode).toBeUndefined();
    expectOneSourcePerKnob(result, "setting", "hotels-rates");
    expect(result.err).not.toContain("no rooms");
  });

  it("--search: keeps --currency and --locale legal, since both shape the read itself", async () => {
    signIn(s.home);
    const fake = s.fake({
      routes: [{ op: "getHotelRates", answers: [noRates] }],
    });
    const result = await s.run([
      "hotels",
      "rooms",
      HOTEL,
      "--search",
      HOTEL_SID,
      "--currency",
      "AED",
      "--locale",
      "ar",
    ]);

    expect(result.code).toBe(0);
    expect(fake.requests("createHotelSearch")).toEqual([]);
    expect(query(fake, "getHotelRates")).toEqual({
      searchId: HOTEL_SID,
      currency: "AED",
      locale: "ar",
    });
    expect(
      json<{ currencyCodeSource: string }>(result).currencyCodeSource,
    ).toBe("explicit");
  });

  it("dates: mints a hotel search with the stored settings, reads rates in the same currency, and reports the market", async () => {
    signIn(s.home);
    writeSettings(s.home, { currency: "SAR", site: "SA", locale: "ar" });
    const echoed = {
      siteCode: "SA",
      occupancy: { adults: 2, childrenAges: [11], rooms: 1 },
    };
    const fake = s.fake({
      routes: [
        created((b) => ({ ...b, ...echoed })),
        { op: "getHotelRates", answers: [noRates] },
      ],
    });
    const result = await s.run([
      ...MINT,
      "--children",
      "1",
      "--children-ages",
      "11",
    ]);

    expect(result.code).toBe(0);
    expect(createBody(fake)).toEqual({
      hotelId: Number(HOTEL),
      checkIn: DATES[0],
      checkOut: DATES[1],
      children: 1,
      childrenAges: [11],
      currency: "SAR",
      siteCode: "SA",
      locale: "ar",
    });
    // ONE currency for the mint and the read it feeds, or the room is priced twice.
    expect(query(fake, "getHotelRates")).toEqual({
      searchId: HOTEL_SID,
      currency: "SAR",
      locale: "ar",
    });
    // A completed empty page settles in two reads.
    expect(fake.requests("getHotelRates")).toHaveLength(2);
    const printed = json<{
      settled: string;
      siteCode: string;
      siteCodeSource: string;
      occupancy: unknown;
    }>(result);
    expect(printed.settled).toBe("converged");
    expect(printed.siteCode).toBe("SA");
    expect(printed.siteCodeSource).toBe("setting");
    expect(printed.occupancy).toEqual(echoed.occupancy);
    expectOneSourcePerKnob(result, "setting", "hotels-rates");
    // A converged zero is this search's answer, never the hotel's.
    expect(result.err).toContain("not proof the hotel has no rooms");
    expect(result.err).toContain(`hotels rooms ${HOTEL} <checkIn> <checkOut>`);
    expect(result.err).not.toContain("re-run: wego hotels rooms");
  });

  it("dates: explicit --site, --currency and --locale win the whole operation, and the source says so", async () => {
    // A setting must not beat a flag for half of one command: the mint and the
    // rates read both carry the flags.
    signIn(s.home);
    writeSettings(s.home, { currency: "SAR", site: "SA", locale: "ar" });
    const fake = s.fake({
      routes: [
        created((b) => ({ ...b, siteCode: "AE" })),
        { op: "getHotelRates", answers: [noRates] },
      ],
    });
    const result = await s.run([
      "hotels",
      "rooms",
      HOTEL,
      "--check-in",
      DATES[0],
      "--check-out",
      DATES[1],
      "--site",
      "AE",
      "--currency",
      "USD",
      "--locale",
      "en",
    ]);

    expect(result.code).toBe(0);
    expect(createBody(fake)).toMatchObject({
      siteCode: "AE",
      currency: "USD",
      locale: "en",
    });
    expect(query(fake, "getHotelRates")).toMatchObject({
      currency: "USD",
      locale: "en",
    });
    const printed = json<{
      siteCode: string;
      siteCodeSource: string;
      currencyCodeSource: string;
    }>(result);
    expect(printed.siteCode).toBe("AE");
    expect(printed.siteCodeSource).toBe("explicit");
    expect(printed.currencyCodeSource).toBe("explicit");
  });

  it("dates: a failed rates read keeps the minted searchId as a re-run hint", async () => {
    signIn(s.home);
    const fake = s.fake({
      routes: [
        created(),
        {
          op: "getHotelRates",
          answers: [
            problem(503, "upstream_unavailable", "try later", {
              "retry-after": "0",
            }),
          ],
        },
      ],
    });
    const result = await s.run(MINT);

    expect(result.code).toBe(5);
    expect(result.out).toBe("");
    expect(fake.requests("createHotelSearch")).toHaveLength(1);
    expect(result.err).toContain(
      `re-run: wego hotels rooms ${HOTEL} --search ${HOTEL_SID}`,
    );
  });

  it("--search: a failed rates read prints no re-run hint, the caller has the id", async () => {
    signIn(s.home);
    const fake = s.fake({
      routes: [
        {
          op: "getHotelRates",
          answers: [
            problem(503, "upstream_unavailable", "try later", {
              "retry-after": "0",
            }),
          ],
        },
      ],
    });
    const result = await s.run([
      "hotels",
      "rooms",
      HOTEL,
      "--search",
      HOTEL_SID,
    ]);

    expect(result.code).toBe(5);
    expect(fake.requests("createHotelSearch")).toEqual([]);
    expect(result.err).not.toContain("re-run: wego hotels rooms");
  });

  it("--search on a city search exits 6 after one read, naming the command that fixes it", async () => {
    signIn(s.home);
    const fake = s.fake({
      routes: [
        {
          op: "getHotelRates",
          answers: [
            problem(409, "rates_require_hotel_search", "not hotel-scoped"),
          ],
        },
      ],
    });
    const result = await s.run([
      "hotels",
      "rooms",
      HOTEL,
      "--search",
      CITY_SID,
    ]);

    expect(result.code).toBe(6);
    // The settle never retries a scope the search cannot change.
    expect(fake.requests("getHotelRates")).toHaveLength(1);
    expect(result.err).toContain("this search is not hotel-scoped");
    expect(result.err).toContain("hotels rooms <hotelId> <checkIn> <checkOut>");
  });
});

describe("hotels booking-link", () => {
  it("sends no guests, and no countryCode unless asked", async () => {
    signIn(s.home);
    const fake = s.fake({ routes: [route("hotels-booking-link")] });
    const result = await s.run([
      "hotels",
      "booking-link",
      HOTEL,
      "--rate",
      RATE_ID,
    ]);

    expect(result.code).toBe(0);
    expect(fake.seen[0]?.pathParams).toEqual({
      hotelId: HOTEL,
      rateId: RATE_ID,
    });
    expect(query(fake, "getHotelRateBookingLink")).toEqual({});
    expect(json<{ bookingUrl: string }>(result).bookingUrl).toBe(
      body("hotels-booking-link").bookingUrl,
    );
  });

  it("uppercases --country, like the info commands", async () => {
    signIn(s.home);
    const fake = s.fake({ routes: [route("hotels-booking-link")] });
    const result = await s.run([
      "hotels",
      "booking-link",
      HOTEL,
      "--rate",
      RATE_ID,
      "--country",
      "ae",
    ]);
    expect(result.code).toBe(0);
    expect(query(fake, "getHotelRateBookingLink").countryCode).toBe("AE");
  });
});

describe("hotels share", () => {
  const SHARE = ["hotels", "share", "BKK", ...DATES];

  it("forwards the city, dates and occupancy, and prints the durable link", async () => {
    signIn(s.home);
    const fake = s.fake({ routes: [route("hotels-search-link")] });
    const result = await s.run([...SHARE, "--adults", "2"]);

    expect(result.code).toBe(0);
    // No stored site and no id_token market, so no siteCode goes on the wire.
    expect(query(fake, "getHotelSearchLink")).toEqual({
      cityCode: "BKK",
      checkIn: DATES[0],
      checkOut: DATES[1],
      adults: "2",
    });
    expect(json<{ searchUrl: string }>(result).searchUrl).toBe(
      body("hotels-search-link").searchUrl,
    );
  });

  it("sends --rooms, the same occupancy vocabulary as hotels search", async () => {
    signIn(s.home);
    const fake = s.fake({ routes: [route("hotels-search-link")] });
    const result = await s.run([...SHARE, "--adults", "4", "--rooms", "2"]);
    expect(result.code).toBe(0);
    expect(query(fake, "getHotelSearchLink")).toMatchObject({
      adults: "4",
      rooms: "2",
    });
  });

  it("packs --children-ages into a CSV the API parses", async () => {
    signIn(s.home);
    const fake = s.fake({ routes: [route("hotels-search-link")] });
    const result = await s.run([
      ...SHARE,
      "--children",
      "2",
      "--children-ages",
      "5,9",
    ]);
    expect(result.code).toBe(0);
    expect(query(fake, "getHotelSearchLink")).toMatchObject({
      children: "2",
      childrenAges: "5,9",
    });
  });

  it("inherits the stored currency, locale and site, which the link hands on", async () => {
    signIn(s.home);
    writeSettings(s.home, { currency: "SAR", locale: "ar", site: "SA" });
    const fake = s.fake({ routes: [route("hotels-search-link")] });
    const result = await s.run(SHARE);
    expect(result.code).toBe(0);
    expect(query(fake, "getHotelSearchLink")).toMatchObject({
      currency: "SAR",
      locale: "ar",
      siteCode: "SA",
    });
  });

  it("an explicit --site beats the stored one", async () => {
    signIn(s.home);
    writeSettings(s.home, { site: "SA" });
    const fake = s.fake({ routes: [route("hotels-search-link")] });
    const result = await s.run([...SHARE, "--site", "AE"]);
    expect(result.code).toBe(0);
    expect(query(fake, "getHotelSearchLink").siteCode).toBe("AE");
  });
});
