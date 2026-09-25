import { describe, expect, it } from "bun:test";
import {
  parseAirportsNearArgs,
  parseHolidaysArgs,
  parseSchedulesArgs,
  parseVisaFreeArgs,
} from "./commands";

/**
 * The `wego info` parsers (issue #1326), tested directly because they are pure.
 * They validate client-side because both upstreams behind these commands answer
 * a bad key with an empty list rather than an error, so a typo that reached the
 * wire would come back looking like a real "nothing found".
 *
 * What a caller observes from the commands themselves (exit codes, the JSON on
 * stdout, the query on the wire, stored preferences) is
 * `integration/info.test.ts`, which drives the compiled binary.
 */

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
    // `Number("")` is 0, a legal coordinate, so a split-and-Number check accepts
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
