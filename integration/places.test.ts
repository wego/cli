/**
 * `wego places`: its help, the flags it forwards, the ones it refuses before any
 * request, and the stored preferences it does (and does not) inherit. The shared
 * error classes are `errors.test.ts`; `parsePlacesArgs` has no edge case that
 * these do not reach from argv.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { readFixture, route } from "./harness/fixtures";
import { useScenario } from "./harness/scenario";
import { json, signIn, writeSettings } from "./harness/wego";

const s = useScenario();

// biome-ignore lint/suspicious/noExplicitAny: a fixture body is untyped JSON
const body = (name: string) => readFixture(name).body as any;

function query(fake: { seen: { query: URLSearchParams }[] }) {
  return Object.fromEntries(fake.seen[0]?.query ?? []);
}

describe("places help", () => {
  for (const help of ["--help", "-h", "help"]) {
    it(`places ${help}: usage on stdout, exit 0, empty stderr`, async () => {
      const result = await s.run(["places", help]);
      expect(result.code).toBe(0);
      expect(result.out).toContain('Usage: wego places "<query>"');
      expect(result.err).toBe("");
    });
  }
});

describe("places", () => {
  it("prints the places JSON and sends the token and the query", async () => {
    signIn(s.home);
    const fake = s.fake({ routes: [route("places")] });
    const result = await s.run([
      "places",
      "dubai",
      "--locale",
      "en",
      "--page-size",
      "5",
    ]);

    expect(result.code).toBe(0);
    expect(
      json<{ metadata: { resultCount: number } }>(result).metadata.resultCount,
    ).toBe(body("places").metadata.resultCount);
    expect(fake.seen[0]?.token).toBe("access-1");
    expect(query(fake)).toEqual({
      query: "dubai",
      locale: "en",
      pageSize: "5",
    });
  });

  it("takes --flag value and --flag=value, and --types comma lists and repeats", async () => {
    signIn(s.home);
    const fake = s.fake({ routes: [route("places")] });
    const result = await s.run([
      "places",
      "paris",
      "--types",
      "city,airport",
      "--types=hotel",
      "--locale=en",
      "--page",
      "2",
      "--page-size=5",
    ]);

    expect(result.code).toBe(0);
    expect(fake.seen[0]?.query.getAll("types")).toEqual([
      "city",
      "airport",
      "hotel",
    ]);
    expect(fake.seen[0]?.query.get("query")).toBe("paris");
    expect(fake.seen[0]?.query.get("locale")).toBe("en");
    expect(fake.seen[0]?.query.get("page")).toBe("2");
    expect(fake.seen[0]?.query.get("pageSize")).toBe("5");
  });

  it("accepts the values at the caps (page 100, page-size 50)", async () => {
    signIn(s.home);
    const fake = s.fake({ routes: [route("places")] });
    const result = await s.run([
      "places",
      "dubai",
      "--page",
      "100",
      "--page-size",
      "50",
    ]);

    expect(result.code).toBe(0);
    expect(query(fake)).toMatchObject({ page: "100", pageSize: "50" });
  });

  const refused: [string[], RegExp][] = [
    [[], /Usage: wego places/],
    [["dubai", "--page", "x"], /--page must be a positive integer/],
    [["dubai", "--page", "0x10"], /--page must be a positive integer/],
    [["dubai", "--page", "1e3"], /--page must be a positive integer/],
    [["dubai", "--page", "0"], /--page must be a positive integer/],
    [["dubai", "--page", "1.5"], /--page must be a positive integer/],
    [["dubai", "--page", "-1"], /--page must be a positive integer/],
    [["dubai", "--page", " 5"], /--page must be a positive integer/],
    [["dubai", "--page", "101"], /--page must be between 1 and 100/],
    [["dubai", "--page-size", "100"], /--page-size must be between 1 and 50/],
    [["dubai", "--nope"], /Unknown option/],
    [["dubai", "--locale"], /--locale requires a value/],
    [["dubai", "--locale", "--page", "2"], /--locale requires a value/],
    [["dubai", "--locale="], /--locale requires a value/],
    [["dubai", "--types="], /--types requires a value/],
  ];
  for (const [args, message] of refused) {
    it(`places ${JSON.stringify(args)} is a usage error, exit 2, no request`, async () => {
      signIn(s.home);
      const fake = s.fake();
      const result = await s.run(["places", ...args]);
      expect(result.code).toBe(2);
      expect(result.err).toMatch(message);
      expect(result.out).toBe("");
      expect(fake.seen).toEqual([]);
    });
  }

  it("tells a logged-out user to run login, exit 3, no request", async () => {
    const fake = s.fake();
    const result = await s.run(["places", "dubai"]);
    expect(result.code).toBe(3);
    expect(result.err).toMatch(/wego login/);
    expect(fake.seen).toEqual([]);
  });

  it("recovers from a 401 by refreshing once and retrying", async () => {
    signIn(s.home, {
      accessToken: "access-revoked",
      refreshToken: "refresh-1",
    });
    const fake = s.fake({
      accept: [],
      routes: [route("places")],
      refresh: [{ access_token: "access-2" }],
    });
    const result = await s.run(["places", "dubai"]);

    expect(result.code).toBe(0);
    expect(fake.requests("getPlaces").map((r) => r.token)).toEqual([
      "access-revoked",
      "access-2",
    ]);
  });

  it("refreshes an expired token before the call and stores the rotation", async () => {
    signIn(s.home, {
      accessToken: "access-old",
      refreshToken: "refresh-1",
      expiresAt: Date.now() - 10_000,
    });
    const fake = s.fake({
      accept: [],
      routes: [route("places")],
      refresh: [{ access_token: "access-2", refresh_token: "refresh-2" }],
    });
    const result = await s.run(["places", "dubai"]);

    expect(result.code).toBe(0);
    expect(fake.requests("getPlaces").map((r) => r.token)).toEqual([
      "access-2",
    ]);
    expect(
      JSON.parse(readFileSync(s.home.credentialsPath, "utf8")),
    ).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-2" });
  });
});

describe("places stored preferences", () => {
  it("inherits the stored locale and never the stored market or currency", async () => {
    // Place resolution is market-neutral on purpose: the API pins the upstream
    // site to the wildcard, so a stored site must not narrow every lookup.
    signIn(s.home);
    writeSettings(s.home, { locale: "ar", site: "SA", currency: "SAR" });
    const fake = s.fake({ routes: [route("places")] });
    expect((await s.run(["places", "dubai"])).code).toBe(0);
    expect(query(fake)).toEqual({ query: "dubai", locale: "ar" });
  });

  it("an explicit --locale beats the stored one", async () => {
    signIn(s.home);
    writeSettings(s.home, { locale: "ar" });
    const fake = s.fake({ routes: [route("places")] });
    expect((await s.run(["places", "dubai", "--locale", "en"])).code).toBe(0);
    expect(query(fake)).toEqual({ query: "dubai", locale: "en" });
  });
});
