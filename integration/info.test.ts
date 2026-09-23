/**
 * `wego info`: the four reference lookups, their help, and what reaches the wire.
 * The parsers' edge cases stay in `src/info.test.ts`; here is what a caller sees.
 */

import { describe, expect, it } from "bun:test";
import { readFixture, route } from "./harness/fixtures";
import { useScenario } from "./harness/scenario";
import { json, signIn, writeSettings } from "./harness/wego";

const s = useScenario();

/** Values the output must carry are read from the fixture, so editing a
 *  fixture does not break a scenario that asserts on them. */
// biome-ignore lint/suspicious/noExplicitAny: a fixture body is untyped JSON
const body = (name: string) => readFixture(name).body as any;

function query(fake: { seen: { query: URLSearchParams }[] }) {
  return Object.fromEntries(fake.seen[0]?.query ?? []);
}

describe("info help", () => {
  for (const help of ["--help", "-h", "help"]) {
    it(`info ${help}: usage on stdout, exit 0, empty stderr`, async () => {
      const result = await s.run(["info", help]);
      expect(result.code).toBe(0);
      expect(result.out).toMatch(/^Usage: wego info <command>/);
      expect(result.out).toMatch(/^ {2}holidays /m);
      expect(result.err).toBe("");
    });
  }

  it("a bare `info` prints usage on stderr with exit 2", async () => {
    const result = await s.run(["info"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("Usage:");
    expect(result.out).toBe("");
  });

  it("an unknown sub-command names it, exit 2", async () => {
    const result = await s.run(["info", "weather"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("Unknown info sub-command: weather");
    expect(result.out).toBe("");
  });

  for (const [sub, usage] of [
    ["holidays", "info holidays <country>"],
    ["visa-free", "info visa-free <passportCountry>"],
    ["schedules", "info schedules <from> <to>"],
    ["airports-near", "info airports-near <place|lat,lng>"],
  ] as const) {
    it(`info ${sub} --help prints the leaf usage on stdout, exit 0`, async () => {
      const result = await s.run(["info", sub, "--help"]);
      expect(result.code).toBe(0);
      expect(result.out).toContain(usage);
      expect(result.err).toBe("");
    });
  }

  it("a usage error costs exit 2 and no request", async () => {
    signIn(s.home);
    const fake = s.fake();
    const result = await s.run(["info", "holidays", "ZZZ"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("2-letter ISO country code");
    expect(fake.seen).toEqual([]);
  });
});

describe("info holidays", () => {
  it("prints JSON, sends the token and the window", async () => {
    signIn(s.home);
    const fake = s.fake({ routes: [route("holidays")] });
    const result = await s.run([
      "info",
      "holidays",
      "sg",
      "--from",
      "2026-08-01",
      "--to",
      "2026-12-31",
    ]);

    expect(result.code).toBe(0);
    expect(result.err).toBe("");
    expect(json<{ metadata: { window: string } }>(result).metadata.window).toBe(
      body("holidays").metadata.window,
    );
    expect(fake.seen[0]?.path).toBe("/v1/countries/SG/holidays");
    expect(fake.seen[0]?.token).toBe("access-1");
    expect(query(fake)).toEqual({
      fromDate: "2026-08-01",
      toDate: "2026-12-31",
    });
  });

  it("sends no date params when the window is left to the API", async () => {
    signIn(s.home);
    const fake = s.fake({ routes: [route("holidays")] });
    expect((await s.run(["info", "holidays", "SG"])).code).toBe(0);
    expect(query(fake)).toEqual({});
  });

  it("inherits the stored locale but never the stored market", async () => {
    signIn(s.home);
    writeSettings(s.home, { locale: "ar", site: "SA", currency: "SAR" });
    const fake = s.fake({ routes: [route("holidays")] });
    expect((await s.run(["info", "holidays", "SG"])).code).toBe(0);
    expect(query(fake)).toEqual({ locale: "ar" });
  });

  it("exits 3 without a request when logged out", async () => {
    const fake = s.fake();
    const result = await s.run(["info", "holidays", "SG"]);
    expect(result.code).toBe(3);
    expect(result.out).toBe("");
    expect(result.err).not.toBe("");
    expect(fake.seen).toEqual([]);
  });
});

describe("info visa-free", () => {
  it("prints the list and forwards paging", async () => {
    signIn(s.home);
    const fake = s.fake({ routes: [route("visa-free")] });
    const result = await s.run([
      "info",
      "visa-free",
      "ph",
      "--page-size",
      "10",
    ]);

    expect(result.code).toBe(0);
    const printed = json<{
      results: { countryCode: string }[];
      metadata: { coverage: string };
    }>(result);
    expect(printed.results[0]?.countryCode).toBe(
      body("visa-free").results[0].countryCode,
    );
    expect(printed.metadata.coverage).toBe(body("visa-free").metadata.coverage);
    expect(fake.seen[0]?.path).toBe("/v1/countries/PH/visa-free-destinations");
    expect(query(fake)).toEqual({ pageSize: "10" });
  });
});

describe("info schedules", () => {
  it("forwards the route and airline, and prints the resolved city", async () => {
    signIn(s.home);
    const fake = s.fake({ routes: [route("schedules")] });
    const result = await s.run([
      "info",
      "schedules",
      "sin",
      "lhr",
      "--airline",
      "sq",
      "--site",
      "sg",
    ]);

    expect(result.code).toBe(0);
    expect(query(fake)).toMatchObject({
      from: "SIN",
      to: "LHR",
      airline: "SQ",
      siteCode: "SG",
    });
    expect(json<{ metadata: { to: unknown } }>(result).metadata.to).toEqual(
      body("schedules").metadata.to,
    );
  });

  it("inherits the stored locale and market", async () => {
    signIn(s.home);
    writeSettings(s.home, { locale: "ar", site: "SA" });
    const fake = s.fake({ routes: [route("schedules")] });
    expect((await s.run(["info", "schedules", "SIN", "BKK"])).code).toBe(0);
    expect(query(fake)).toMatchObject({ locale: "ar", siteCode: "SA" });
  });

  it("an explicit --site beats the stored one", async () => {
    signIn(s.home);
    writeSettings(s.home, { site: "SA" });
    const fake = s.fake({ routes: [route("schedules")] });
    expect(
      (await s.run(["info", "schedules", "SIN", "BKK", "--site", "SG"])).code,
    ).toBe(0);
    expect(query(fake)).toMatchObject({ siteCode: "SG" });
  });

  it("prints one siteCodeSource, top level, naming the deciding layer", async () => {
    signIn(s.home);
    writeSettings(s.home, { site: "SA" });
    s.fake({ routes: [route("schedules")] });
    const result = await s.run(["info", "schedules", "SIN", "BKK"]);

    expect(result.code).toBe(0);
    const printed = json<{
      siteCodeSource: string;
      metadata: Record<string, unknown>;
    }>(result);
    expect(printed.siteCodeSource).toBe("setting");
    expect(printed.metadata.siteCode).toBe(body("schedules").metadata.siteCode);
    expect(result.out.split('"siteCodeSource"').length - 1).toBe(1);
    expect(
      Object.keys(printed.metadata).filter((k) => k.endsWith("Source")),
    ).toEqual([]);
  });

  it("reads `default` with no stored site and no flag", async () => {
    signIn(s.home);
    s.fake({ routes: [route("schedules")] });
    const result = await s.run(["info", "schedules", "SIN", "BKK"]);
    expect(json<{ siteCodeSource: string }>(result).siteCodeSource).toBe(
      "default",
    );
  });
});

describe("info airports-near", () => {
  it("sends a place code as `place` and repeats --types", async () => {
    signIn(s.home);
    const fake = s.fake({ routes: [route("airports-near")] });
    const result = await s.run([
      "info",
      "airports-near",
      "lon",
      "--types",
      "airport,city",
    ]);

    expect(result.code).toBe(0);
    expect(fake.seen[0]?.query.get("place")).toBe("LON");
    expect(fake.seen[0]?.query.getAll("types")).toEqual(["airport", "city"]);
    expect(json<{ results: { code: string }[] }>(result).results[0]?.code).toBe(
      body("airports-near").results[0].code,
    );
  });

  it("sends a coordinate pair as latitude and longitude", async () => {
    signIn(s.home);
    const fake = s.fake({ routes: [route("airports-near")] });
    expect((await s.run(["info", "airports-near", "51.5,-0.12"])).code).toBe(0);
    expect(query(fake)).toEqual({ latitude: "51.5", longitude: "-0.12" });
  });
});
