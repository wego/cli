import { describe, expect, it } from "bun:test";
import { fetchFlightResults, type HttpFetch } from "./api";
import {
  parseFeedbackArgs,
  parseFlightResultsArgs,
  parseLoginArgs,
  resolveCliSite,
} from "./commands";

/**
 * The pure halves of the commands: the parsers that turn argv into API-call
 * arguments and the rung resolution behind `--site`. What a command prints, the
 * exit code it returns and what reaches the wire are the integration tier's
 * (`integration/places.test.ts`, `flights.test.ts`, `feedback.test.ts`,
 * `auth.test.ts`, `login-more.test.ts`), which drives the compiled binary.
 */

describe("parseLoginArgs", () => {
  it("skips the browser only when asked, or when the shell is remote", () => {
    expect(parseLoginArgs([], false)).toEqual({ skipBrowser: false });
    expect(parseLoginArgs([], true)).toEqual({ skipBrowser: true });
    expect(parseLoginArgs(["--no-browser"], false)).toEqual({
      skipBrowser: true,
    });
    // --browser overrules the SSH detection (the X11-forwarding case).
    expect(parseLoginArgs(["--browser"], true)).toEqual({ skipBrowser: false });
  });

  it("returns a usage message for an unknown or contradictory flag", () => {
    expect(parseLoginArgs(["--nope"], false)).toEqual({
      usage: expect.stringContaining("Unknown option: --nope"),
    });
    expect(parseLoginArgs(["--browser", "--no-browser"], false)).toEqual({
      usage: expect.stringContaining("not both"),
    });
  });
});
// --- flights results filter flags (issue #1117) ------------------------------
//
// TEST-FIRST reproduction of the CLI gap: the departure-time / alliance /
// booking-type / stopover / view filters the API implements were unreachable
// from the CLI (`--departure-blocks morning` => "Unknown option"). These assert
// each new flag parses, validates client-side, and serializes to the exact API
// wire param — plus a CLI<->OpenAPI parity guardrail over the whole route.

describe("parseFlightResultsArgs – issue #1117 filter flags", () => {
  it("accepts the new list/single flags (no longer 'Unknown option')", () => {
    const { searchId, query } = parseFlightResultsArgs([
      "s1msr",
      "--departure-blocks",
      "morning,night",
      "--alliances",
      "star_alliance",
      "--booking-types",
      "wego",
      "--stopover-airports",
      "DOH",
      "--aircraft",
      "388,789",
      "--departure-range",
      "1320-360",
    ]);
    expect(searchId).toBe("s1msr");
    expect(query.departureBlocks).toEqual(["morning", "night"]);
    expect(query.alliances).toEqual(["star_alliance"]);
    expect(query.bookingTypes).toEqual(["wego"]);
    expect(query.stopoverAirports).toEqual(["DOH"]);
    expect(query.aircraft).toEqual(["388", "789"]);
    expect(query.departureRange).toBe("1320-360");
  });

  it("parses the layover bounds as whole minutes, 0 included", () => {
    const { query } = parseFlightResultsArgs([
      "s1msr",
      "--min-stopover-duration",
      "120",
      "--max-stopover-duration",
      "0",
    ]);
    expect(query.minStopoverDuration).toBe(120);
    expect(query.maxStopoverDuration).toBe(0);
  });

  it("rejects a negative or fractional layover bound locally (no network)", () => {
    for (const flag of ["--min-stopover-duration", "--max-stopover-duration"]) {
      for (const bad of ["-1", "12.5", "soon"]) {
        expect(() => parseFlightResultsArgs(["s1msr", flag, bad])).toThrow(
          /non-negative integer/,
        );
      }
    }
  });

  it("preserves a boundary wraparound range (1320-360 = 22:00-06:00)", () => {
    const { query } = parseFlightResultsArgs([
      "s1msr",
      "--departure-range",
      "1320-360",
    ]);
    expect(query.departureRange).toBe("1320-360");
  });

  it("accepts the inclusive block edges without special-casing them", () => {
    const { query } = parseFlightResultsArgs([
      "s1msr",
      "--departure-range",
      "359-360",
    ]);
    expect(query.departureRange).toBe("359-360");
  });

  // ── The arrival-clock and return-leg flags (issue #84) ────────────────────

  it("parses each of the four leg/clock range flags into its own field", () => {
    const { query } = parseFlightResultsArgs([
      "s1msr",
      "--departure-range",
      "540-1260",
      "--arrival-range",
      "0-1080",
      "--return-departure-range",
      "360-720",
      "--return-arrival-range",
      "0-1320",
    ]);
    // Four distinct fields: a flag bleeding into a neighbour would send the
    // traveller's outbound hours to the return leg, which fails silently.
    expect(query.departureRange).toBe("540-1260");
    expect(query.arrivalRange).toBe("0-1080");
    expect(query.returnDepartureRange).toBe("360-720");
    expect(query.returnArrivalRange).toBe("0-1320");
  });

  it("parses each of the four leg/clock block flags into its own field", () => {
    const { query } = parseFlightResultsArgs([
      "s1msr",
      "--departure-blocks",
      "morning",
      "--arrival-blocks",
      "afternoon,night",
      "--return-departure-blocks",
      "midnight",
      "--return-arrival-blocks",
      "night",
    ]);
    expect(query.departureBlocks).toEqual(["morning"]);
    expect(query.arrivalBlocks).toEqual(["afternoon", "night"]);
    expect(query.returnDepartureBlocks).toEqual(["midnight"]);
    expect(query.returnArrivalBlocks).toEqual(["night"]);
  });

  it("validates every block flag against the same closed set, naming the flag", () => {
    for (const flag of [
      "--departure-blocks",
      "--arrival-blocks",
      "--return-departure-blocks",
      "--return-arrival-blocks",
    ]) {
      expect(() => parseFlightResultsArgs(["s1msr", flag, "evening"])).toThrow(
        flag,
      );
    }
  });

  it("names the offending flag when a range value is malformed", () => {
    // Four flags share one validator, so a fixed `--departure-range` message
    // would point a caller at a flag they never typed.
    for (const flag of [
      "--departure-range",
      "--arrival-range",
      "--return-departure-range",
      "--return-arrival-range",
    ]) {
      expect(() => parseFlightResultsArgs(["s1msr", flag, "1440-0"])).toThrow(
        flag,
      );
    }
  });

  it("parses the four per-leg duration flags, distinct from trip-wide --max-duration", () => {
    const { query } = parseFlightResultsArgs([
      "s1msr",
      "--max-duration",
      "900",
      "--outbound-min-duration",
      "60",
      "--outbound-max-duration",
      "300",
      "--return-min-duration",
      "90",
      "--return-max-duration",
      "480",
    ]);
    expect(query.maxDuration).toBe(900);
    expect(query.outboundMinDuration).toBe(60);
    expect(query.outboundMaxDuration).toBe(300);
    expect(query.returnMinDuration).toBe(90);
    expect(query.returnMaxDuration).toBe(480);
  });

  it("rejects an invalid --departure-blocks value locally (no network)", () => {
    expect(() =>
      parseFlightResultsArgs(["s1msr", "--departure-blocks", "evening"]),
    ).toThrow(/midnight, morning, afternoon, night/);
  });

  // Upstream's alliance vocabulary is open, so a local allowlist would reject
  // values the API accepts; the API answers an unknown code with an empty page.
  it("passes --alliances through without a local allowlist", () => {
    const parsed = parseFlightResultsArgs([
      "s1msr",
      "--alliances",
      "sky_team,lcc",
    ]);
    expect(parsed.query.alliances).toEqual(["sky_team", "lcc"]);
  });

  it("rejects an invalid --booking-types value locally", () => {
    expect(() =>
      parseFlightResultsArgs(["s1msr", "--booking-types", "cash"]),
    ).toThrow(/wego, airline/);
  });

  it("parses --airlines-match and --same-airline", () => {
    const { query } = parseFlightResultsArgs([
      "s1msr",
      "--airlines",
      "EK",
      "--airlines-match",
      "all",
      "--same-airline",
      "true",
    ]);
    expect(query.airlines).toEqual(["EK"]);
    expect(query.airlinesMatch).toBe("all");
    expect(query.sameAirline).toBe("true");
  });

  it("keeps --same-airline false as the literal string, not a dropped flag", () => {
    const { query } = parseFlightResultsArgs([
      "s1msr",
      "--same-airline",
      "false",
    ]);
    expect(query.sameAirline).toBe("false");
  });

  it("rejects an invalid --airlines-match value locally", () => {
    expect(() =>
      parseFlightResultsArgs(["s1msr", "--airlines-match", "both"]),
    ).toThrow(/any, all/);
  });

  it("rejects --airlines-match all without --airlines, but allows any", () => {
    expect(() =>
      parseFlightResultsArgs(["s1msr", "--airlines-match", "all"]),
    ).toThrow(/--airlines-match all requires --airlines/);
    // `any` is the server default and adds no constraint, so it is harmless alone.
    expect(
      parseFlightResultsArgs(["s1msr", "--airlines-match", "any"]).query
        .airlinesMatch,
    ).toBe("any");
    // --same-airline stands alone, so it must NOT be caught by the same guard.
    expect(
      parseFlightResultsArgs(["s1msr", "--same-airline", "true"]).query
        .sameAirline,
    ).toBe("true");
  });

  it("rejects an invalid --same-airline value locally", () => {
    expect(() =>
      parseFlightResultsArgs(["s1msr", "--same-airline", "yes"]),
    ).toThrow(/true, false/);
  });

  it("rejects --view at all: the results read has one projection (issue #1308)", () => {
    expect(() => parseFlightResultsArgs(["s1msr", "--view", "card"])).toThrow(
      /Unknown option: --view/,
    );
  });

  it.each([
    ["1440-0", "out-of-range end"],
    ["0-1440", "out-of-range start"],
    ["1320", "missing max"],
    ["abc-def", "non-numeric"],
    ["-360", "empty min"],
  ])("rejects a malformed --departure-range %s (%s)", (bad) => {
    expect(() =>
      parseFlightResultsArgs(["s1msr", "--departure-range", bad]),
    ).toThrow(/minutes of the day/);
  });

  // CLI-2: all four former tokenizers now run through one `tokenizeFlagSets`,
  // so the unknown-flag error is one unified format — `Unknown option: --x`
  // followed by that command's usage (flights results used to print the bare
  // "Unknown option" with no usage; now it appends the scoped usage).
  it("unknown flag → unified 'Unknown option' + that command's usage", () => {
    expect(() => parseFlightResultsArgs(["s1msr", "--bogus"])).toThrow(
      /Unknown option: --bogus\nUsage: wego flights results/,
    );
  });
});

describe("flights results – CLI<->OpenAPI parity guardrail (issue #1117)", () => {
  // The full set of query params the API documents on
  // GET /v1/flights/searches/:id/results — a mirror of
  // apps/api/src/flights/schema.ts `pollFlightsQuerySchema`. The apps are
  // self-contained (the CLI shares no code with the API), so this list is the
  // contract's local checkpoint: when the API grows a results query param, add
  // it here AND wire a CLI flag for it (or exempt it below) — otherwise this
  // test fails, flagging the CLI drift.
  const DOCUMENTED_RESULTS_PARAMS = new Set([
    "page",
    "pageSize",
    "sort",
    "airlines",
    "alliances",
    "stops",
    "min-price",
    "max-price",
    "max-duration",
    "min-stopover-duration",
    "max-stopover-duration",
    "outbound-departure-blocks",
    "outbound-departure-range",
    "outbound-arrival-blocks",
    "outbound-arrival-range",
    "return-departure-blocks",
    "return-departure-range",
    "return-arrival-blocks",
    "return-arrival-range",
    "outbound-min-duration",
    "outbound-max-duration",
    "return-min-duration",
    "return-max-duration",
    "booking-types",
    "booking-sites",
    "stopover-airports",
    "aircraft",
    "currency",
    "locale",
    "view",
  ]);
  // Documented params intentionally NOT surfaced as a CLI flag. `view` has a
  // single legal value since #1308 (`card`, the default), so a flag could only
  // ever restate the default — and the CLI omits the param entirely.
  const EXEMPT_RESULTS_PARAMS = new Set<string>(["view"]);

  it("every documented results query param is reachable from a CLI flag", async () => {
    // One invocation exercising every results flag the CLI offers.
    const { searchId, query } = parseFlightResultsArgs([
      "s1msr",
      "--page",
      "2",
      "--page-size",
      "10",
      "--sort",
      "price_asc",
      "--airlines",
      "SQ,TR",
      "--alliances",
      "star_alliance",
      "--stops",
      "0,1",
      "--min-price",
      "50",
      "--max-price",
      "500",
      "--max-duration",
      "600",
      "--min-stopover-duration",
      "90",
      "--max-stopover-duration",
      "600",
      "--departure-blocks",
      "morning,night",
      "--departure-range",
      "1320-360",
      "--arrival-blocks",
      "afternoon",
      "--arrival-range",
      "0-1080",
      "--return-departure-blocks",
      "morning",
      "--return-departure-range",
      "360-720",
      "--return-arrival-blocks",
      "night",
      "--return-arrival-range",
      "0-1320",
      "--outbound-min-duration",
      "60",
      "--outbound-max-duration",
      "600",
      "--return-min-duration",
      "60",
      "--return-max-duration",
      "600",
      "--booking-types",
      "wego",
      "--booking-sites",
      "expedia.com",
      "--stopover-airports",
      "DOH",
      "--aircraft",
      "388,789",
      "--currency",
      "USD",
      "--locale",
      "en",
    ]);

    // Serialize through the real wire serializer, capturing the built URL. The
    // fetch is INJECTED (#1341) rather than patched onto the global: this test
    // exists to prove every documented param can reach the wire, and a patch that
    // leaked past its `finally` would silently change what every later suite sees.
    let seen: URL | undefined;
    const http = ((url: string | URL) => {
      seen = new URL(String(url));
      return Promise.resolve(
        Response.json({
          searchId,
          currencyCode: "USD",
          metadata: {
            page: 1,
            pageSize: 10,
            resultCount: 0,
            totalCandidates: 0,
            hasMore: false,
          },
          results: [],
        }),
      );
    }) as HttpFetch;
    await fetchFlightResults(
      "https://api.wego.com",
      "tok",
      searchId,
      query,
      undefined,
      http,
    );
    const reachable = new Set(seen ? [...seen.searchParams.keys()] : []);

    const missing = [...DOCUMENTED_RESULTS_PARAMS].filter(
      (p) => !reachable.has(p) && !EXEMPT_RESULTS_PARAMS.has(p),
    );
    expect(missing).toEqual([]);

    // The serializer must not invent params the API doesn't document.
    const undocumented = [...reachable].filter(
      (p) => !DOCUMENTED_RESULTS_PARAMS.has(p),
    );
    expect(undocumented).toEqual([]);
  });
});
describe("resolveCliSite", () => {
  it("prefers an explicit --site over both the setting and the market (source: explicit)", () => {
    expect(resolveCliSite("SG", "SA", "AE")).toEqual({
      siteCode: "SG",
      source: "explicit",
    });
  });

  it("prefers the stored setting over the account market (source: setting)", () => {
    // The whole point of issue #1386: an account in one market must not pin a
    // user who buys from another.
    expect(resolveCliSite(undefined, "SA", "AE")).toEqual({
      siteCode: "SA",
      source: "setting",
    });
  });

  it("derives from the stored id_token market when no flag and no setting (source: account)", () => {
    expect(resolveCliSite(undefined, undefined, "AE")).toEqual({
      siteCode: "AE",
      source: "account",
    });
  });

  it("leaves siteCode unset when no rung supplies one (source: default → API floors US)", () => {
    expect(resolveCliSite(undefined, undefined, undefined)).toEqual({
      source: "default",
    });
  });
});

describe("parseFeedbackArgs", () => {
  it("parses a rating-only submission", () => {
    expect(parseFeedbackArgs(["--rating", "5"])).toEqual({ rating: 5 });
  });

  it("parses a message-only submission", () => {
    expect(parseFeedbackArgs(["--message", "great tool"])).toEqual({
      message: "great tool",
    });
  });

  it("parses rating + category + message together", () => {
    expect(
      parseFeedbackArgs([
        "--rating",
        "4",
        "--category",
        "flights",
        "--message",
        "  fares looked stale  ",
      ]),
    ).toEqual({
      rating: 4,
      category: "flights",
      message: "fares looked stale",
    });
  });

  it("requires at least one of --rating / --message", () => {
    expect(() => parseFeedbackArgs([])).toThrow(
      /Provide --rating or --message/,
    );
    expect(() => parseFeedbackArgs(["--category", "hotels"])).toThrow(
      /Provide --rating or --message/,
    );
  });

  it("rejects an out-of-range rating", () => {
    expect(() => parseFeedbackArgs(["--rating", "6"])).toThrow(/--rating/);
    expect(() => parseFeedbackArgs(["--rating", "0"])).toThrow(/--rating/);
  });

  it("rejects an unknown category", () => {
    expect(() =>
      parseFeedbackArgs(["--rating", "3", "--category", "bugs"]),
    ).toThrow(/--category must be one of/);
  });

  it("rejects an empty or over-long message", () => {
    expect(() => parseFeedbackArgs(["--message", "   "])).toThrow(
      /--message must not be empty/,
    );
    expect(() => parseFeedbackArgs(["--message", "x".repeat(2001)])).toThrow(
      /at most 2000 characters/,
    );
  });

  it("rejects a stray positional argument", () => {
    expect(() => parseFeedbackArgs(["hello", "--rating", "5"])).toThrow(
      /Unexpected argument: hello/,
    );
  });
});
