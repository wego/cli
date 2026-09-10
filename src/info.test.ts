import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  fetchHolidays,
  fetchNearbyPlaces,
  fetchSchedules,
  fetchVisaFree,
} from "./api";
import {
  info,
  parseAirportsNearArgs,
  parseHolidaysArgs,
  parseSchedulesArgs,
  parseVisaFreeArgs,
} from "./commands";
import type { CliConfig } from "./config";
import type { UserSettings } from "./settings";
import { loadCredentials, saveCredentials } from "./storage";
import { loadTestCliConfig } from "./test-config";

/**
 * Behavioral tests for `wego info` (issue #1326) — the four stateless reference
 * lookups.
 *
 * Two halves, and the split is deliberate:
 *
 *  - **The parsers** are pure, so they are tested directly. Everything they
 *    reject is a request that never happens, which is the point of validating
 *    client-side: both upstreams behind these commands answer a bad key with an
 *    empty list rather than an error, so a typo that reached the wire would come
 *    back looking like a real "nothing found".
 *  - **The commands** run through the real `info` dispatcher with the four api
 *    calls injected as deps (#1341 — this suite used to drive a hand-written
 *    `apps/api`). Assertions are on what a caller observes: the exit code, the JSON
 *    on stdout, empty stderr, and the arguments the CLI passed to each call. What
 *    those arguments then become on the wire is `api.test.ts`'s, where the URL is
 *    built.
 */

// --- injected api deps (#1341) ----------------------------------------------
//
// These four commands used to run against a hand-written `Bun.serve` stand-in for
// `apps/api`. That fake could only fail when it disagreed with itself, which is the
// defect #1328 exists to remove, so the deps `info` already takes are stubbed
// directly instead. Two things follow:
//
//  - What a caller observes stays asserted here: exit code, JSON on stdout, stderr,
//    and the ARGUMENTS the CLI passed to each api call.
//  - The wire mapping those arguments produce (`--from` → `fromDate`, a place vs a
//    coordinate pair, repeated `types`) moved to `api.test.ts`, where the URL is
//    built and where an injected `HttpFetch` sees the real request. It is a
//    pure-function concern, so it belongs in tier A.

type ApiCall = { fn: string; base: string; token: string; params: unknown };

/** No socket is opened, so the base only has to be the value the deps receive. */
const API = "https://api.wego.test";

const HOLIDAYS_RESPONSE = {
  results: [
    {
      name: "National Day",
      key: "national_day",
      startDate: "2026-08-09",
      endDate: "2026-08-09",
    },
  ],
  metadata: {
    resultCount: 1,
    countryCode: "SG",
    window: "upcoming",
    from: "2026-07-31",
    to: "2026-10-29",
  },
};

const VISA_FREE_RESPONSE = {
  results: [{ countryCode: "TH", name: "Thailand", keyCityCode: "BKK" }],
  metadata: {
    resultCount: 1,
    totalCandidates: 1,
    hasMore: false,
    passportCountryCode: "PH",
    upstreamPagesFetched: 1,
    coverage: "complete",
  },
};

const SCHEDULES_RESPONSE = {
  results: [
    {
      airlineCode: "TR",
      flightNumber: "TR 610",
      departureAirportCode: "SIN",
      arrivalAirportCode: "BKK",
      departureTime: "15:45",
      arrivalTime: "16:45",
      durationMinutes: 120,
      stopsCount: 0,
      arrivalDayOffset: 0,
      segments: [
        {
          departureAirportCode: "SIN",
          arrivalAirportCode: "BKK",
          departureTime: "15:45",
          arrivalTime: "16:45",
          airlineCode: "TR",
        },
      ],
    },
  ],
  metadata: {
    page: 1,
    pageSize: 200,
    resultCount: 1,
    totalCandidates: 1,
    hasMore: false,
    coverage: "complete",
    from: { requested: "SIN", resolvedCityCode: "SIN" },
    to: { requested: "LHR", resolvedCityCode: "LON" },
    siteCode: "SG",
    siteCodeSource: "explicit",
  },
};

const NEARBY_RESPONSE = {
  results: [
    { id: 212, code: "LCY", name: "London City Airport", type: "airport" },
  ],
  metadata: {
    resultCount: 1,
    origin: { place: "LON", latitude: 51.5, longitude: -0.12 },
    radiusKm: 100,
    types: ["airport"],
  },
};

/** The four api deps, recording every call. `token` is recorded rather than
 *  checked here: the Bearer header itself is `api.ts`'s business, and
 *  `api.test.ts` asserts it. */
function apiStubs(): { api: InfoApiStubs; calls: ApiCall[] } {
  const calls: ApiCall[] = [];
  const record =
    <T>(fn: string, response: T) =>
    (base: string, token: string, params: unknown): Promise<T> => {
      calls.push({ fn, base, token, params });
      return Promise.resolve(response);
    };
  return {
    calls,
    api: {
      fetchHolidays: record("fetchHolidays", HOLIDAYS_RESPONSE),
      fetchVisaFree: record("fetchVisaFree", VISA_FREE_RESPONSE),
      fetchSchedules: record("fetchSchedules", SCHEDULES_RESPONSE),
      fetchNearbyPlaces: record("fetchNearbyPlaces", NEARBY_RESPONSE),
    } as unknown as InfoApiStubs,
  };
}

type InfoApiStubs = {
  fetchHolidays: typeof fetchHolidays;
  fetchVisaFree: typeof fetchVisaFree;
  fetchSchedules: typeof fetchSchedules;
  fetchNearbyPlaces: typeof fetchNearbyPlaces;
};

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

let dir: string;
let credPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wego-info-"));
  credPath = join(dir, "credentials.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function config(api: string): CliConfig {
  return loadTestCliConfig({
    WEGO_CLI_CLIENT_ID: "cli-abc",
    WEGO_AUTH_AUTHORIZE_URL: "http://127.0.0.1:1/authorize",
    WEGO_AUTH_TOKEN_URL: "http://127.0.0.1:1/token",
    WEGO_API_URL: api,
    WEGO_CREDENTIALS_PATH: credPath,
  });
}

function deps(
  io: ReturnType<typeof sink>,
  api: InfoApiStubs,
  // Stored travel preferences (issue #1386); none by default.
  settings: UserSettings = {},
) {
  return {
    ...io,
    loadCredentials,
    saveCredentials,
    refreshTokens: () => {
      throw new Error("refresh is not exercised by the info tests");
    },
    loadSettings: async () => settings,
    recordAuthFailure: async () => {},
    ...api,
  };
}

// ---------------------------------------------------------------------------
// Parsers — everything rejected here is a request that never happens
// ---------------------------------------------------------------------------

describe("parseHolidaysArgs", () => {
  it("uppercases the country and omits an unset window", () => {
    expect(parseHolidaysArgs(["sg"])).toEqual({ countryCode: "SG" });
  });

  it("accepts both dates together", () => {
    expect(
      parseHolidaysArgs(["SG", "--from", "2026-08-01", "--to", "2026-12-31"]),
    ).toEqual({ countryCode: "SG", from: "2026-08-01", to: "2026-12-31" });
  });

  it("rejects exactly one of --from/--to rather than guessing the other end", () => {
    expect(() => parseHolidaysArgs(["SG", "--from", "2026-08-01"])).toThrow(
      /both --from and --to, or neither/,
    );
    expect(() => parseHolidaysArgs(["SG", "--to", "2026-08-01"])).toThrow(
      /both --from and --to, or neither/,
    );
  });

  it("rejects a reversed range", () => {
    expect(() =>
      parseHolidaysArgs(["SG", "--from", "2026-12-31", "--to", "2026-01-01"]),
    ).toThrow(/--from must not be after --to/);
  });

  it("rejects a date that matches the pattern but is not a real day", () => {
    // The upstream would answer `2026-02-31` with an empty list, not an error.
    expect(() =>
      parseHolidaysArgs(["SG", "--from", "2026-02-31", "--to", "2026-03-01"]),
    ).toThrow(/real calendar date/);
  });

  it("rejects a malformed date", () => {
    expect(() =>
      parseHolidaysArgs(["SG", "--from", "01-08-2026", "--to", "2026-12-31"]),
    ).toThrow(/YYYY-MM-DD/);
  });

  it("rejects a country code that is not two letters", () => {
    for (const bad of ["SGP", "S", "S1", "12"]) {
      expect(() => parseHolidaysArgs([bad])).toThrow(/2-letter ISO country/);
    }
  });

  it("rejects a missing or extra positional", () => {
    expect(() => parseHolidaysArgs([])).toThrow(/Usage/);
    expect(() => parseHolidaysArgs(["SG", "TH"])).toThrow(
      /Unexpected argument/,
    );
  });
});

describe("parseVisaFreeArgs", () => {
  it("uppercases the passport country", () => {
    expect(parseVisaFreeArgs(["ph"])).toEqual({ countryCode: "PH" });
  });

  it("accepts page and page-size", () => {
    expect(
      parseVisaFreeArgs(["PH", "--page", "2", "--page-size", "10"]),
    ).toEqual({ countryCode: "PH", page: 2, pageSize: 10 });
  });

  it("rejects an over-large page-size rather than letting the API clamp it", () => {
    expect(() => parseVisaFreeArgs(["PH", "--page-size", "201"])).toThrow(
      /--page-size must be between/,
    );
  });

  it("allows a page-size up to the visa-free ceiling, which is larger than other commands'", () => {
    // The whole list is the product, so this cap is 200 where places caps at 50.
    expect(parseVisaFreeArgs(["PH", "--page-size", "200"]).pageSize).toBe(200);
  });

  it("rejects a zero or non-numeric page", () => {
    expect(() => parseVisaFreeArgs(["PH", "--page", "0"])).toThrow();
    expect(() => parseVisaFreeArgs(["PH", "--page", "two"])).toThrow();
  });
});

describe("parseSchedulesArgs", () => {
  it("uppercases both endpoints", () => {
    expect(parseSchedulesArgs(["sin", "bkk"])).toEqual({
      from: "SIN",
      to: "BKK",
    });
  });

  it("accepts an airport code — resolution is the API's job, not a rejection", () => {
    expect(parseSchedulesArgs(["SIN", "LHR"]).to).toBe("LHR");
  });

  it("uppercases the airline filter and validates its shape", () => {
    expect(parseSchedulesArgs(["SIN", "BKK", "--airline", "sq"]).airline).toBe(
      "SQ",
    );
    expect(() =>
      parseSchedulesArgs(["SIN", "BKK", "--airline", "SQQ"]),
    ).toThrow(/2-character IATA/);
  });

  it("validates the site code shape", () => {
    expect(parseSchedulesArgs(["SIN", "BKK", "--site", "sg"]).siteCode).toBe(
      "SG",
    );
    expect(() => parseSchedulesArgs(["SIN", "BKK", "--site", "SGP"])).toThrow(
      /2-letter country code/,
    );
  });

  it("requires exactly two positionals", () => {
    expect(() => parseSchedulesArgs(["SIN"])).toThrow(/Usage/);
    expect(() => parseSchedulesArgs(["SIN", "BKK", "DXB"])).toThrow(
      /Unexpected argument/,
    );
  });

  it("takes the paging flags and mirrors the API's caps locally", () => {
    const q = parseSchedulesArgs([
      "SIN",
      "BKK",
      "--page",
      "2",
      "--page-size",
      "25",
    ]);
    expect(q.page).toBe(2);
    expect(q.pageSize).toBe(25);
    // Mirrored so an over-large value costs no round trip.
    expect(() =>
      parseSchedulesArgs(["SIN", "BKK", "--page-size", "201"]),
    ).toThrow();
    expect(() => parseSchedulesArgs(["SIN", "BKK", "--page", "21"])).toThrow();
    expect(() => parseSchedulesArgs(["SIN", "BKK", "--page", "0"])).toThrow();
  });

  it("omits the paging params when no flag is given", () => {
    const q = parseSchedulesArgs(["SIN", "BKK"]);
    expect(q.page).toBeUndefined();
    expect(q.pageSize).toBeUndefined();
  });

  it("rejects a non-3-letter code", () => {
    expect(() => parseSchedulesArgs(["SINGAPORE", "BKK"])).toThrow(
      /3-letter city or airport code/,
    );
  });
});

describe("parseAirportsNearArgs", () => {
  it("reads a 3-letter code as a place", () => {
    expect(parseAirportsNearArgs(["lon"])).toEqual({ place: "LON" });
  });

  it("reads a lat,lng pair as coordinates", () => {
    expect(parseAirportsNearArgs(["51.5,-0.12"])).toEqual({
      latitude: 51.5,
      longitude: -0.12,
    });
  });

  it("validates coordinate ranges", () => {
    expect(() => parseAirportsNearArgs(["91,0"])).toThrow(
      /latitude must be between/,
    );
    expect(() => parseAirportsNearArgs(["0,181"])).toThrow(
      /longitude must be between/,
    );
  });

  it("rejects a malformed coordinate pair", () => {
    expect(() => parseAirportsNearArgs(["51.5,north"])).toThrow(/both numbers/);
    expect(() => parseAirportsNearArgs(["1,2,3"])).toThrow(/Invalid location/);
  });

  it("rejects an EMPTY coordinate component rather than reading it as 0", () => {
    // `Number("")` is 0, a legal coordinate — so a split-and-Number check accepts
    // `51.47,` as longitude 0 and answers about a point in the sea. The API cannot
    // catch it either (0 is in range), so the strict shape check is the only guard.
    for (const bad of ["1.35,", ",103.8", ",", "51.47, ", " ,103.8"]) {
      expect(() => parseAirportsNearArgs([bad])).toThrow(/Invalid location/);
    }
  });

  it("validates --types against the place-type vocabulary", () => {
    expect(
      parseAirportsNearArgs(["LON", "--types", "airport,city"]).types,
    ).toEqual(["airport", "city"]);
    expect(() =>
      parseAirportsNearArgs(["LON", "--types", "aerodrome"]),
    ).toThrow(/--types must be one of/);
  });

  it("rejects an over-large page-size", () => {
    expect(() => parseAirportsNearArgs(["LON", "--page-size", "51"])).toThrow(
      /--page-size must be between/,
    );
  });
});

// ---------------------------------------------------------------------------
// The dispatcher
// ---------------------------------------------------------------------------

describe("info dispatcher", () => {
  for (const help of ["--help", "-h", "help"]) {
    it(`info ${help}: usage on stdout, exit 0, empty stderr`, async () => {
      const io = sink();
      const code = await info(
        config("http://127.0.0.1:1"),
        [help],
        deps(io, apiStubs().api),
      );
      expect(code).toBe(0);
      expect(io.out.join("\n")).toMatch(/^Usage: wego info <command>/);
      expect(io.out.join("\n")).toMatch(/^ {2}holidays /m);
      expect(io.err.length).toBe(0);
    });
  }

  it("a bare `info` prints group usage on stderr with exit 2", async () => {
    const io = sink();
    const code = await info(
      config("http://127.0.0.1:1"),
      [],
      deps(io, apiStubs().api),
    );
    expect(code).toBe(2);
    expect(io.err.join("\n")).toContain("Usage:");
    expect(io.out.length).toBe(0);
  });

  it("an unknown sub-command names it, then prints usage, exit 2", async () => {
    const io = sink();
    const code = await info(
      config("http://127.0.0.1:1"),
      ["weather"],
      deps(io, apiStubs().api),
    );
    expect(code).toBe(2);
    expect(io.err.join("\n")).toContain("Unknown info sub-command: weather");
    expect(io.out.length).toBe(0);
  });

  for (const [sub, usage] of [
    ["holidays", "info holidays <country>"],
    ["visa-free", "info visa-free <passportCountry>"],
    ["schedules", "info schedules <from> <to>"],
    ["airports-near", "info airports-near <place|lat,lng>"],
  ] as const) {
    it(`info ${sub} --help prints the leaf usage on stdout, exit 0`, async () => {
      const io = sink();
      const code = await info(
        config("http://127.0.0.1:1"),
        [sub, "--help"],
        deps(io, apiStubs().api),
      );
      expect(code).toBe(0);
      expect(io.out.join("\n")).toContain(usage);
      expect(io.err.length).toBe(0);
    });
  }

  it("a usage error costs exit 2 and NO network call", async () => {
    const { api, calls } = apiStubs();
    const io = sink();
    // No credentials on disk either — the parser must fail before either is read.
    const code = await info(config(API), ["holidays", "ZZZ"], deps(io, api));
    expect(code).toBe(2);
    expect(calls).toEqual([]);
    expect(io.err.join("\n")).toContain("2-letter ISO country code");
  });
});

// ---------------------------------------------------------------------------
// The four commands, end to end against a local API
// ---------------------------------------------------------------------------

describe("info commands against a local API", () => {
  it("holidays: prints JSON on stdout and sends the bearer token", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    const { api, calls } = apiStubs();
    const io = sink();

    const code = await info(
      config(API),
      ["holidays", "sg", "--from", "2026-08-01", "--to", "2026-12-31"],
      deps(io, api),
    );

    expect(code).toBe(0);
    expect(io.err.length).toBe(0);
    // Only JSON on stdout, so an agent can pipe it straight into jq.
    const printed = JSON.parse(io.out.join("")) as {
      metadata: { window: string };
    };
    expect(printed.metadata.window).toBe("upcoming");
    // The stored token reaches the call, and the country is uppercased before it.
    // `api.test.ts` owns what the URL and the Bearer header then look like.
    expect(calls).toEqual([
      {
        fn: "fetchHolidays",
        base: API,
        token: "tok-1",
        // The CLI's own vocabulary: `from`/`to`. Renaming them to the wire's
        // `fromDate`/`toDate` happens inside `api.ts`, which is why that mapping is
        // asserted in `api.test.ts` and not here.
        params: {
          countryCode: "SG",
          from: "2026-08-01",
          to: "2026-12-31",
        },
      },
    ]);
  });

  it("holidays: inherits the stored locale but NEVER the stored market", async () => {
    // Carve-out (issue #1386): a holidays site code is the country in the PATH,
    // so threading the user's market here would answer the wrong country. The
    // params the call receives say it exactly: `locale` arrives, `siteCode` and
    // `currency` never do.
    await saveCredentials(credPath, { accessToken: "tok-1" });
    const { api, calls } = apiStubs();
    const code = await info(
      config(API),
      ["holidays", "SG"],
      deps(sink(), api, { locale: "ar", site: "SA", currency: "SAR" }),
    );
    expect(code).toBe(0);
    expect(calls[0]?.params).toEqual({ countryCode: "SG", locale: "ar" });
  });

  it("schedules: inherits both the stored locale and the stored market", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    const { api, calls } = apiStubs();
    const code = await info(
      config(API),
      ["schedules", "SIN", "BKK"],
      deps(sink(), api, { locale: "ar", site: "SA" }),
    );
    expect(code).toBe(0);
    expect(calls[0]?.params).toMatchObject({ locale: "ar", siteCode: "SA" });
  });

  it("schedules: an explicit --site beats the stored one", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    const { api, calls } = apiStubs();
    const code = await info(
      config(API),
      ["schedules", "SIN", "BKK", "--site", "SG"],
      deps(sink(), api, { site: "SA" }),
    );
    expect(code).toBe(0);
    expect(calls[0]?.params).toMatchObject({ siteCode: "SG" });
  });

  it("schedules: stamps the CLI's siteCodeSource at top level and strips the API's copy", async () => {
    // The API only sees whether a siteCode arrived, so it calls a CLI-resolved
    // stored market `explicit` (the stubbed response returns exactly that).
    // Printing it verbatim contradicts the promise that the output names the
    // deciding layer, and `explicit` would tell a reader the user typed --site
    // when they did not. Since #1534 the CLI's answer is a TOP-LEVEL field —
    // one `*Source` per knob, like the search verticals — and the API's
    // request-scoped copy never leaves `metadata`. The `metadata.siteCode`
    // echo stays.
    await saveCredentials(credPath, { accessToken: "tok-1" });
    const io = sink();
    const code = await info(
      config(API),
      ["schedules", "SIN", "BKK"],
      deps(io, apiStubs().api, { site: "SA" }),
    );
    expect(code).toBe(0);
    const raw = io.out.join("\n");
    const printed = JSON.parse(raw) as {
      siteCodeSource: string;
      metadata: Record<string, unknown>;
    };
    expect(printed.siteCodeSource).toBe("setting");
    expect(printed.metadata.siteCode).toBe("SG");
    expect(raw.split('"siteCodeSource"').length - 1).toBe(1);
    expect(
      Object.keys(printed.metadata).filter((k) => k.endsWith("Source")),
    ).toEqual([]);
  });

  it("schedules: with no stored site and no flag the source reads `default`", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    const io = sink();
    const code = await info(
      config(API),
      ["schedules", "SIN", "BKK"],
      deps(io, apiStubs().api),
    );
    expect(code).toBe(0);
    const printed = JSON.parse(io.out.join("\n")) as {
      siteCodeSource: string;
    };
    expect(printed.siteCodeSource).toBe("default");
  });

  it("holidays: sends no date params when the window is left to the API", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    const { api, calls } = apiStubs();
    const code = await info(config(API), ["holidays", "SG"], deps(sink(), api));
    expect(code).toBe(0);
    // Absent, not empty: `api.ts` drops an undefined param, and `fromDate=` on the
    // wire is a validation error rather than "no window given".
    expect(calls[0]?.params).toEqual({ countryCode: "SG" });
  });

  it("visa-free: prints the list and forwards paging", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    const { api, calls } = apiStubs();
    const io = sink();

    const code = await info(
      config(API),
      ["visa-free", "ph", "--page-size", "10"],
      deps(io, api),
    );

    expect(code).toBe(0);
    const printed = JSON.parse(io.out.join("")) as {
      results: { countryCode: string }[];
      metadata: { coverage: string };
    };
    expect(printed.results[0].countryCode).toBe("TH");
    expect(printed.metadata.coverage).toBe("complete");
    expect(calls[0]?.fn).toBe("fetchVisaFree");
    expect(calls[0]?.params).toEqual({ countryCode: "PH", pageSize: 10 });
  });

  it("schedules: forwards the route and airline, and prints the resolved city", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    const { api, calls } = apiStubs();
    const io = sink();

    const code = await info(
      config(API),
      ["schedules", "sin", "lhr", "--airline", "sq", "--site", "sg"],
      deps(io, api),
    );

    expect(code).toBe(0);
    // Every positional and flag is uppercased before it reaches the wire.
    expect(calls[0]?.fn).toBe("fetchSchedules");
    expect(calls[0]?.params).toEqual({
      from: "SIN",
      to: "LHR",
      airline: "SQ",
      siteCode: "SG",
    });
    // The echo is what tells a caller it got London's timetable, not Heathrow's.
    const printed = JSON.parse(io.out.join("")) as {
      metadata: { to: { requested: string; resolvedCityCode: string } };
    };
    expect(printed.metadata.to).toEqual({
      requested: "LHR",
      resolvedCityCode: "LON",
    });
  });

  it("airports-near: sends a resolved place as `place`, never as a coordinate", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    const { api, calls } = apiStubs();
    const io = sink();

    const code = await info(
      config(API),
      ["airports-near", "lon", "--types", "airport,city"],
      deps(io, api),
    );

    expect(code).toBe(0);
    // A place code travels as `place`, never as a coordinate. How it is then
    // serialized — including the REPEATED `types` params — is `api.test.ts`'s.
    expect(calls[0]?.fn).toBe("fetchNearbyPlaces");
    expect(calls[0]?.params).toEqual({
      place: "LON",
      types: ["airport", "city"],
    });
    const printed = JSON.parse(io.out.join("")) as {
      results: { code: string }[];
    };
    expect(printed.results[0].code).toBe("LCY");
  });

  it("airports-near: sends a coordinate pair as latitude+longitude", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    const { api, calls } = apiStubs();
    const code = await info(
      config(API),
      ["airports-near", "51.5,-0.12"],
      deps(sink(), api),
    );
    expect(code).toBe(0);
    expect(calls[0]?.params).toEqual({ latitude: 51.5, longitude: -0.12 });
  });

  it("with no credentials, exits on the auth class without calling the API", async () => {
    const { api, calls } = apiStubs();
    const io = sink();
    const code = await info(config(API), ["holidays", "SG"], deps(io, api));
    // The auth exit class, not a usage error and not a success.
    expect(code).toBe(3);
    expect(calls).toEqual([]);
    expect(io.out.length).toBe(0);
    expect(io.err.length).toBeGreaterThan(0);
  });
});
