import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { release } from "node:os";
import {
  APP_VERSION,
  ApiHttpError,
  ApiUnreachableError,
  createFlightSearch,
  createHotelSearch,
  fetchFlightResults,
  fetchFlightTrip,
  fetchHolidays,
  fetchHotelResults,
  fetchHotelReviews,
  fetchNearbyPlaces,
  fetchPlaces,
  fetchSchedules,
  fetchSearchLink,
  fetchVisaFree,
  fetchWhoami,
  type HttpFetch,
  NotFoundError,
  OS_TYPE,
  osTypeFor,
  refreshIdentityAssertion,
  sendFeedback,
  setAnalyticsHeaders,
  setIdentityAssertion,
  UnauthorizedError,
  USER_AGENT,
  utcOffsetOf,
} from "./api";

afterEach(() => {
  setAnalyticsHeaders({});
  setIdentityAssertion(undefined, false);
});

/**
 * A tripwire, not a fake (#1341).
 *
 * Every test here injects its own `HttpFetch` into the call under test, so nothing
 * in this file should ever reach a socket. The one thing that could go wrong
 * silently is FORGETTING to pass the dep: the call then uses the real `fetch`,
 * leaves the machine, and — measured while writing this — comes back as a `401`
 * from the production API, which reads as a bug in the code under test rather than
 * as a missing argument. So the global is replaced by something that throws and
 * names the mistake, and restored afterwards so no other suite inherits it.
 */
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (() => {
    throw new Error(
      "a test in api.test.ts reached the real network — pass the injected `http` dep as the call's last argument",
    );
  }) as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("USER_AGENT", () => {
  it("is the Wego-CLI product token, so apps/api can classify the caller", () => {
    expect(USER_AGENT).toMatch(/^Wego-CLI\/\S+$/);
  });

  it("rides on every apps/api call without dropping other headers", async () => {
    let captured: Headers | undefined;
    const http = ((_url: string, init: RequestInit) => {
      captured = new Headers(init.headers);
      return Promise.resolve(
        new Response(JSON.stringify({ sub: "u", email: "a@wego.com" }), {
          status: 200,
        }),
      );
    }) as HttpFetch;

    await fetchWhoami("https://api.wego.com", "tok", undefined, http);
    expect(captured?.get("user-agent")).toBe(USER_AGENT);
    expect(captured?.get("Authorization")).toBe("Bearer tok");
  });
});

describe("client build headers", () => {
  /** Capture the headers of one `apps/api` call. */
  async function call(): Promise<Headers> {
    let captured: Headers | undefined;
    const http = ((_url: string, init: RequestInit) => {
      captured = new Headers(init.headers);
      return Promise.resolve(
        new Response(JSON.stringify({ sub: "u", email: "a@wego.com" }), {
          status: 200,
        }),
      );
    }) as HttpFetch;
    await fetchWhoami("https://api.wego.com", "tok", undefined, http);
    return captured as Headers;
  }

  it("stamps the build version the user agent already carries", async () => {
    const headers = await call();
    expect(headers.get("x-wego-app-version")).toBe(APP_VERSION);
    expect(USER_AGENT).toBe(`Wego-CLI/${APP_VERSION}`);
  });

  it("stamps the os type and the kernel release", async () => {
    const headers = await call();
    expect(headers.get("x-wego-os-type")).toBe(OS_TYPE ?? null);
    expect(headers.get("x-wego-os-version")).toBe(release());
  });

  it.each([
    ["darwin", "OSX"],
    ["linux", "LINUX"],
    ["win32", "WINDOWS"],
    ["freebsd", undefined],
    ["", undefined],
  ])("maps the %p platform to %p", (platform, expected) => {
    expect(osTypeFor(platform)).toBe(expected);
  });

  it("stamps this machine's own utc offset", async () => {
    const headers = await call();
    expect(headers.get("x-wego-timezone")).toBe(utcOffsetOf(new Date()));
    expect(headers.get("x-wego-timezone")).toMatch(/^[+-]\d{2}:\d{2}$/);
  });

  it("rides independently of the analytics ids, which the opt-out gates", async () => {
    setAnalyticsHeaders({});
    const headers = await call();
    expect(headers.get("x-wego-client-id")).toBeNull();
    expect(headers.get("x-wego-app-version")).toBe(APP_VERSION);
    expect(headers.get("x-wego-os-version")).toBe(release());
    expect(headers.get("x-wego-timezone")).toBe(utcOffsetOf(new Date()));
  });
});

describe("x-wego-id-token assertion", () => {
  async function call(): Promise<Headers> {
    let captured: Headers | undefined;
    const http = ((_url: string, init: RequestInit) => {
      captured = new Headers(init.headers);
      return Promise.resolve(
        new Response(JSON.stringify({ sub: "u" }), { status: 200 }),
      );
    }) as HttpFetch;
    await fetchWhoami("https://api.wego.com", "tok", undefined, http);
    return captured as Headers;
  }

  it("rides every authed call, not just whoami, once consent allows it", async () => {
    setIdentityAssertion("id-tok", true);
    const headers = await call();
    expect(headers.get("x-wego-id-token")).toBe("id-tok");
    // The bearer stays the only credential.
    expect(headers.get("Authorization")).toBe("Bearer tok");
  });

  it("is withheld from a user who opted out of telemetry", async () => {
    setIdentityAssertion("id-tok", false);
    expect((await call()).get("x-wego-id-token")).toBeNull();
  });

  it("is absent when no id_token is stored", async () => {
    setIdentityAssertion(undefined, true);
    expect((await call()).get("x-wego-id-token")).toBeNull();
  });

  it("sends the rotated token after a mid-command refresh", async () => {
    setIdentityAssertion("stale", true);
    refreshIdentityAssertion("fresh");
    expect((await call()).get("x-wego-id-token")).toBe("fresh");
  });

  it("a refresh cannot turn the header on for someone who opted out", async () => {
    setIdentityAssertion(undefined, false);
    refreshIdentityAssertion("fresh");
    expect((await call()).get("x-wego-id-token")).toBeNull();
  });

  it("clears when the refresh has none, so a stale one cannot outlive the file", async () => {
    setIdentityAssertion("stale", true);
    refreshIdentityAssertion(undefined);
    expect((await call()).get("x-wego-id-token")).toBeNull();
  });
});

describe("utcOffsetOf", () => {
  /** A Date whose `getTimezoneOffset` is pinned, so the test does not depend
   *  on the zone the suite happens to run in. */
  const at = (minutesBehindUtc: number): Date =>
    ({ getTimezoneOffset: () => minutesBehindUtc }) as Date;

  it.each([
    [0, "+00:00"],
    [-480, "+08:00"],
    [300, "-05:00"],
    [-345, "+05:45"],
    [-210, "+03:30"],
    [570, "-09:30"],
    [-840, "+14:00"],
    [720, "-12:00"],
  ])("reads %p minutes behind utc as %p", (behind, expected) => {
    expect(utcOffsetOf(at(behind))).toBe(expected);
  });

  it("spells utc +00:00, never -00:00", () => {
    expect(utcOffsetOf(at(0))).toBe("+00:00");
    expect(utcOffsetOf(at(-0))).toBe("+00:00");
  });

  it("reads the live clock as an offset the api accepts", () => {
    expect(utcOffsetOf(new Date())).toMatch(/^[+-]\d{2}:\d{2}$/);
  });
});

describe("analytics headers", () => {
  /** Capture the headers of one `apps/api` call. */
  async function callWith(headers: {
    sessionId?: string;
    clientId?: string;
  }): Promise<Headers> {
    let captured: Headers | undefined;
    const http = ((_url: string, init: RequestInit) => {
      captured = new Headers(init.headers);
      return Promise.resolve(
        new Response(JSON.stringify({ sub: "u", email: "a@wego.com" }), {
          status: 200,
        }),
      );
    }) as HttpFetch;
    setAnalyticsHeaders(headers);
    await fetchWhoami("https://api.wego.com", "tok", undefined, http);
    return captured as Headers;
  }

  it("sends nothing until a value is pushed in", async () => {
    const headers = await callWith({});
    expect(headers.get("x-wego-session-id")).toBeNull();
    expect(headers.get("x-wego-client-id")).toBeNull();
  });

  it("rides both ids on the request once set", async () => {
    const headers = await callWith({
      sessionId: "b05d7226-701f-4892-abc3-dd92727b5683",
      clientId: "019fb66d-2c3f-79a2-94f2-ec5b4af93211",
    });
    expect(headers.get("x-wego-session-id")).toBe(
      "b05d7226-701f-4892-abc3-dd92727b5683",
    );
    expect(headers.get("x-wego-client-id")).toBe(
      "019fb66d-2c3f-79a2-94f2-ec5b4af93211",
    );
  });

  it("omits a header rather than sending the string 'undefined'", async () => {
    const headers = await callWith({
      sessionId: "b05d7226-701f-4892-abc3-dd92727b5683",
      clientId: undefined,
    });
    expect(headers.get("x-wego-client-id")).toBeNull();
  });

  it("omits an empty value, which the API would reject and warn about", async () => {
    const headers = await callWith({ sessionId: "", clientId: "" });
    expect(headers.get("x-wego-session-id")).toBeNull();
    expect(headers.get("x-wego-client-id")).toBeNull();
  });
});

describe("fetchWhoami", () => {
  it("sends the Bearer token to <base>/v1/user and returns the identity", async () => {
    let captured: { url: string; auth: string | null } | undefined;
    const http = ((url: string, init: RequestInit) => {
      captured = {
        url,
        auth: new Headers(init.headers).get("Authorization"),
      };
      return Promise.resolve(
        new Response(JSON.stringify({ sub: "user-1", email: "a@wego.com" }), {
          status: 200,
        }),
      );
    }) as HttpFetch;

    const id = await fetchWhoami(
      "https://api.wego.com/",
      "tok",
      undefined,
      http,
    );
    expect(id).toEqual({ sub: "user-1", email: "a@wego.com" });
    // trailing slash trimmed so the path isn't doubled
    expect(captured?.url).toBe("https://api.wego.com/v1/user");
    expect(captured?.auth).toBe("Bearer tok");
  });

  it("throws UnauthorizedError on 401 (so the caller can refresh)", async () => {
    const http = (() =>
      Promise.resolve(new Response("no", { status: 401 }))) as HttpFetch;
    await expect(
      fetchWhoami("https://api.wego.com", "tok", undefined, http),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("throws on other non-OK responses", async () => {
    const http = (() =>
      Promise.resolve(
        new Response("err", { status: 500, statusText: "Server Error" }),
      )) as HttpFetch;
    await expect(
      fetchWhoami("https://api.wego.com", "tok", undefined, http),
    ).rejects.toThrow(/GET \/v1\/user failed: 500/);
  });

  it("maps a fetch connection failure to ApiUnreachableError (carrying url + cause)", async () => {
    const cause = new TypeError(
      "Unable to connect. Is the computer able to access the url?",
    );
    const http = (() => Promise.reject(cause)) as HttpFetch;
    const err = await fetchWhoami(
      "http://localhost:3001",
      "tok",
      undefined,
      http,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ApiUnreachableError);
    expect((err as ApiUnreachableError).url).toBe(
      "http://localhost:3001/v1/user",
    );
    expect((err as ApiUnreachableError).cause).toBe(cause);
  });
});

describe("fetchPlaces", () => {
  const okBody = {
    results: [{ id: 1, name: "Dubai", type: "city" }],
    metadata: {
      resultCount: 1,
      totalCandidates: 1,
      hasMore: false,
      hasAmbiguity: false,
    },
  };

  it("builds the /v1/places URL with the bearer token, query, repeated types, and pagination", async () => {
    let captured: { url: URL; auth: string | null } | undefined;
    const http = ((url: URL, init: RequestInit) => {
      captured = { url, auth: new Headers(init.headers).get("Authorization") };
      return Promise.resolve(new Response(JSON.stringify(okBody)));
    }) as HttpFetch;

    const res = await fetchPlaces(
      "https://api.wego.com/",
      "tok",
      {
        query: "dubai",
        types: ["city", "airport"],
        locale: "en",
        page: 1,
        pageSize: 5,
      },
      undefined,
      http,
    );

    expect(res).toEqual(okBody);
    expect(captured?.auth).toBe("Bearer tok");
    expect(captured?.url.pathname).toBe("/v1/places");
    expect(captured?.url.searchParams.get("query")).toBe("dubai");
    expect(captured?.url.searchParams.getAll("types")).toEqual([
      "city",
      "airport",
    ]);
    expect(captured?.url.searchParams.get("locale")).toBe("en");
    expect(captured?.url.searchParams.get("pageSize")).toBe("5");
  });

  it("throws UnauthorizedError on 401 (so the caller can refresh)", async () => {
    const http = (() =>
      Promise.resolve(new Response("no", { status: 401 }))) as HttpFetch;
    await expect(
      fetchPlaces(
        "https://api.wego.com",
        "tok",
        { query: "x" },
        undefined,
        http,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("throws on other non-OK responses", async () => {
    const http = (() =>
      Promise.resolve(
        new Response("err", { status: 502, statusText: "Bad Gateway" }),
      )) as HttpFetch;
    await expect(
      fetchPlaces(
        "https://api.wego.com",
        "tok",
        { query: "x" },
        undefined,
        http,
      ),
    ).rejects.toThrow(/GET \/v1\/places failed: 502/);
  });

  it("throws on an unexpected response body", async () => {
    const http = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ results: "not-an-array" })),
      )) as HttpFetch;
    await expect(
      fetchPlaces(
        "https://api.wego.com",
        "tok",
        { query: "x" },
        undefined,
        http,
      ),
    ).rejects.toThrow(/unexpected body/);
  });
});

/** The trip-shaped envelope the results read used to answer with. Kept as the
 *  `fetchFlightTrip` fixture (its `results[0]` IS a trip body) and as the negative
 *  case for a results read (#1308 retired that projection). */
const FLIGHTS_RESULT = {
  searchId: "s1msr",
  currencyCode: "USD",
  metadata: {
    page: 1,
    pageSize: 10,
    resultCount: 1,
    totalCandidates: 1,
    hasMore: false,
  },
  results: [
    {
      tripId: "s1msr:T1",
      stops: 0,
      durationMinutes: 200,
      outbound: { from: "SIN", to: "BKK" },
      fares: [
        {
          kind: "partner",
          providerCode: "expedia.com",
          price: { total: 100, currency: "USD" },
          handoffUrl: "https://x/y?wg_source=wego_api",
        },
      ],
    },
  ],
};

/** A results body: lean list cards with NO `fares[]` — the only projection the
 *  results read answers with since #1308. */
const FLIGHTS_CARD_RESULT = {
  searchId: "s1msr",
  currencyCode: "USD",
  metadata: {
    page: 1,
    pageSize: 10,
    resultCount: 1,
    totalCandidates: 1,
    hasMore: false,
  },
  results: [
    {
      tripId: "s1msr:T1",
      badges: ["cheapest"],
      stops: 0,
      durationMinutes: 200,
      price: {
        total: 100,
        currency: "USD",
        scope: "party",
        websiteCount: 11,
        hasWegoFare: true,
      },
      legs: [
        {
          from: "SIN",
          to: "BKK",
          departsAt: "2026-08-01T08:00:00",
          arrivesAt: "2026-08-01T09:20:00",
          arrivalDayOffset: 0,
          overnight: false,
          durationMinutes: 200,
          stops: 0,
          via: [],
          airlines: [
            {
              code: "SQ",
              name: "Singapore Airlines",
              logoUrl: "https://logos/SQ.png",
            },
          ],
          aircraft: ["A330"],
        },
      ],
    },
  ],
};

describe("createFlightSearch", () => {
  it("POSTs the body with the bearer token and returns { searchId }", async () => {
    let captured:
      | { url: string; method?: string; auth: string | null; body: string }
      | undefined;
    const http = ((url: string, init: RequestInit) => {
      captured = {
        url,
        method: init.method,
        auth: new Headers(init.headers).get("Authorization"),
        body: String(init.body),
      };
      return Promise.resolve(
        Response.json({ searchId: "s1msr" }, { status: 201 }),
      );
    }) as HttpFetch;

    const out = await createFlightSearch(
      "https://api.wego.com/",
      "tok",
      {
        from: "SIN",
        to: "BKK",
        fromDate: "2026-03-01",
      },
      undefined,
      http,
    );
    expect(out).toEqual({ searchId: "s1msr" });
    expect(captured?.url).toBe("https://api.wego.com/v1/flights/searches");
    expect(captured?.method).toBe("POST");
    expect(captured?.auth).toBe("Bearer tok");
    expect(JSON.parse(captured?.body ?? "{}")).toMatchObject({
      from: "SIN",
      to: "BKK",
    });
  });

  it("parses the resolved siteCode + siteCodeSource when the API returns them", async () => {
    const http = (() =>
      Promise.resolve(
        Response.json(
          { searchId: "s1msr", siteCode: "SG", siteCodeSource: "explicit" },
          { status: 201 },
        ),
      )) as HttpFetch;
    const out = await createFlightSearch(
      "https://api.wego.com",
      "tok",
      {
        from: "SIN",
        to: "BKK",
        fromDate: "2026-03-01",
        siteCode: "SG",
      },
      undefined,
      http,
    );
    expect(out).toEqual({
      searchId: "s1msr",
      siteCode: "SG",
      siteCodeSource: "explicit",
    });
  });

  it("accepts a legacy response that omits both site fields", async () => {
    const http = (() =>
      Promise.resolve(
        Response.json({ searchId: "s1legacy" }, { status: 201 }),
      )) as HttpFetch;
    const out = await createFlightSearch(
      "https://api.wego.com",
      "tok",
      {
        from: "SIN",
        to: "BKK",
        fromDate: "2026-03-01",
      },
      undefined,
      http,
    );
    expect(out).toEqual({ searchId: "s1legacy" });
  });

  // #1300 D3 — these two used to assert the opposite. A cross-field `.refine`
  // made a half-populated site pair fail the WHOLE response, so a well-formed
  // create died on metadata the CLI only prints. No type can see a predicate, so
  // no gate reported it either. The invariant belongs in `apps/api`, where a
  // mistake is one redeploy from fixed; here the property is tolerance.
  it("accepts a half-populated site pair (siteCode without siteCodeSource)", async () => {
    const http = (() =>
      Promise.resolve(
        Response.json({ searchId: "s1half", siteCode: "SG" }, { status: 201 }),
      )) as HttpFetch;
    const out = await createFlightSearch(
      "https://api.wego.com",
      "tok",
      {
        from: "SIN",
        to: "BKK",
        fromDate: "2026-03-01",
      },
      undefined,
      http,
    );
    expect(out).toEqual({ searchId: "s1half", siteCode: "SG" });
  });

  it("accepts the reverse half-pair (siteCodeSource without siteCode)", async () => {
    const http = (() =>
      Promise.resolve(
        Response.json(
          { searchId: "s1half2", siteCodeSource: "default" },
          { status: 201 },
        ),
      )) as HttpFetch;
    const out = await createFlightSearch(
      "https://api.wego.com",
      "tok",
      {
        from: "SIN",
        to: "BKK",
        fromDate: "2026-03-01",
      },
      undefined,
      http,
    );
    expect(out).toEqual({ searchId: "s1half2", siteCodeSource: "default" });
  });

  it("accepts a siteCodeSource value the old closed enum rejected", async () => {
    // The failure D3 is really about: `apps/api` adding a third source would have
    // made zod reject the value, and rejecting one value rejects the whole
    // response — so `flights search` would die on a field it only prints. Every
    // installed binary carries its enum compiled in and would never see the fix.
    const http = (() =>
      Promise.resolve(
        Response.json(
          { searchId: "s1new", siteCode: "AE", siteCodeSource: "account" },
          { status: 201 },
        ),
      )) as HttpFetch;
    const out = await createFlightSearch(
      "https://api.wego.com",
      "tok",
      {
        from: "SIN",
        to: "BKK",
        fromDate: "2026-03-01",
      },
      undefined,
      http,
    );
    expect(out).toEqual({
      searchId: "s1new",
      siteCode: "AE",
      siteCodeSource: "account",
    });
  });

  it("throws UnauthorizedError on 401", async () => {
    const http = (() =>
      Promise.resolve(new Response("no", { status: 401 }))) as HttpFetch;
    await expect(
      createFlightSearch(
        "https://api.wego.com",
        "tok",
        {
          from: "SIN",
          to: "BKK",
          fromDate: "2026-03-01",
        },
        undefined,
        http,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });
});

describe("createHotelSearch (site-pair atomicity)", () => {
  const body = {
    cityCode: "DXB",
    checkIn: "2099-03-01",
    checkOut: "2099-03-05",
  };

  it("accepts a legacy response that omits both site fields", async () => {
    const http = (() =>
      Promise.resolve(
        Response.json({ searchId: "h1legacy" }, { status: 201 }),
      )) as HttpFetch;
    const out = await createHotelSearch(
      "https://api.wego.com",
      "tok",
      body,
      undefined,
      http,
    );
    expect(out).toEqual({ searchId: "h1legacy" });
  });

  // #1300 D3, hotels half — same story as flights: tolerance, not atomicity.
  it("accepts a half-populated site pair (siteCodeSource without siteCode)", async () => {
    const http = (() =>
      Promise.resolve(
        Response.json(
          { searchId: "h1half", siteCodeSource: "default" },
          { status: 201 },
        ),
      )) as HttpFetch;
    const out = await createHotelSearch(
      "https://api.wego.com",
      "tok",
      body,
      undefined,
      http,
    );
    expect(out).toEqual({ searchId: "h1half", siteCodeSource: "default" });
  });

  it("accepts the reverse half-pair (siteCode without siteCodeSource)", async () => {
    const http = (() =>
      Promise.resolve(
        Response.json({ searchId: "h1half2", siteCode: "SG" }, { status: 201 }),
      )) as HttpFetch;
    const out = await createHotelSearch(
      "https://api.wego.com",
      "tok",
      body,
      undefined,
      http,
    );
    expect(out).toEqual({ searchId: "h1half2", siteCode: "SG" });
  });

  it("accepts a siteCodeSource value the old closed enum rejected", async () => {
    const http = (() =>
      Promise.resolve(
        Response.json(
          { searchId: "h1new", siteCode: "AE", siteCodeSource: "account" },
          { status: 201 },
        ),
      )) as HttpFetch;
    const out = await createHotelSearch(
      "https://api.wego.com",
      "tok",
      body,
      undefined,
      http,
    );
    expect(out).toEqual({
      searchId: "h1new",
      siteCode: "AE",
      siteCodeSource: "account",
    });
  });

  it("parses both site fields when the API returns them together", async () => {
    const http = (() =>
      Promise.resolve(
        Response.json(
          { searchId: "h1both", siteCode: "SG", siteCodeSource: "explicit" },
          { status: 201 },
        ),
      )) as HttpFetch;
    const out = await createHotelSearch(
      "https://api.wego.com",
      "tok",
      body,
      undefined,
      http,
    );
    expect(out).toEqual({
      searchId: "h1both",
      siteCode: "SG",
      siteCodeSource: "explicit",
    });
  });
});

describe("fetchFlightResults", () => {
  it("sends page/sort/filter query params and returns the result", async () => {
    let seen: URL | undefined;
    const http = ((url: string) => {
      seen = new URL(url);
      return Promise.resolve(Response.json(FLIGHTS_CARD_RESULT));
    }) as HttpFetch;

    const out = await fetchFlightResults(
      "https://api.wego.com",
      "tok",
      "s1msr",
      {
        page: 2,
        sort: "price_asc",
        airlines: ["SQ", "TR"],
        stops: ["0", "1"],
        maxPrice: 500,
        bookingSites: ["expedia.com"],
        currency: "SGD",
      },
      undefined,
      http,
    );
    expect(out.searchId).toBe("s1msr");
    expect(seen?.pathname).toBe("/v1/flights/searches/s1msr/results");
    expect(seen?.searchParams.get("page")).toBe("2");
    expect(seen?.searchParams.get("sort")).toBe("price_asc");
    expect(seen?.searchParams.get("airlines")).toBe("SQ,TR");
    expect(seen?.searchParams.get("stops")).toBe("0,1");
    expect(seen?.searchParams.get("max-price")).toBe("500");
    expect(seen?.searchParams.get("booking-sites")).toBe("expedia.com");
    expect(seen?.searchParams.get("currency")).toBe("SGD");
  });

  it("serializes the departure/alliance/booking-type/stopover params to their exact API keys (issue #1117)", async () => {
    let seen: URL | undefined;
    // The results read answers with the card projection (no fares[]) since #1308.
    const http = ((url: string) => {
      seen = new URL(url);
      return Promise.resolve(Response.json(FLIGHTS_CARD_RESULT));
    }) as HttpFetch;

    await fetchFlightResults(
      "https://api.wego.com",
      "tok",
      "s1msr",
      {
        departureBlocks: ["morning", "night"],
        departureRange: "1320-360",
        alliances: ["star_alliance"],
        bookingTypes: ["wego"],
        stopoverAirports: ["DOH"],
        aircraft: ["388", "789"],
      },
      undefined,
      http,
    );
    // Golden: each CLI field maps to the exact kebab-case wire param the API
    // documents (apps/api flights/schema.ts pollFlightsQuerySchema).
    expect(seen?.searchParams.get("outbound-departure-blocks")).toBe(
      "morning,night",
    );
    expect(seen?.searchParams.get("outbound-departure-range")).toBe("1320-360");
    expect(seen?.searchParams.get("alliances")).toBe("star_alliance");
    expect(seen?.searchParams.get("booking-types")).toBe("wego");
    expect(seen?.searchParams.get("stopover-airports")).toBe("DOH");
    expect(seen?.searchParams.get("aircraft")).toBe("388,789");
    // No `view` on the wire: the CLI has no projection to choose (issue #1308).
    expect(seen?.searchParams.has("view")).toBe(false);
  });

  it("serializes airlines-match/same-airline to their exact API keys", async () => {
    let seen: URL | undefined;
    const http = ((url: string) => {
      seen = new URL(url);
      return Promise.resolve(Response.json(FLIGHTS_CARD_RESULT));
    }) as HttpFetch;

    await fetchFlightResults(
      "https://api.wego.com",
      "tok",
      "s1msr",
      {
        airlines: ["EK"],
        airlinesMatch: "all",
        sameAirline: "false",
      },
      undefined,
      http,
    );
    expect(seen?.searchParams.get("airlines")).toBe("EK");
    expect(seen?.searchParams.get("airlines-match")).toBe("all");
    // "false" must survive: dropping it would silently mean "true" server-side.
    expect(seen?.searchParams.get("same-airline")).toBe("false");
  });

  it("omits the new filter params when unset (no empty keys on the wire)", async () => {
    let seen: URL | undefined;
    const http = ((url: string) => {
      seen = new URL(url);
      return Promise.resolve(Response.json(FLIGHTS_CARD_RESULT));
    }) as HttpFetch;

    await fetchFlightResults(
      "https://api.wego.com",
      "tok",
      "s1msr",
      {
        page: 1,
      },
      undefined,
      http,
    );
    for (const key of [
      "outbound-departure-blocks",
      "outbound-departure-range",
      "alliances",
      "booking-types",
      "stopover-airports",
      "aircraft",
      "airlines-match",
      "same-airline",
      "view",
    ]) {
      expect(seen?.searchParams.has(key)).toBe(false);
    }
  });

  it("surfaces a 404 as a failed-404 error (the command translates it)", async () => {
    const http = (() =>
      Promise.resolve(
        new Response("nf", { status: 404, statusText: "Not Found" }),
      )) as HttpFetch;
    await expect(
      fetchFlightResults(
        "https://api.wego.com",
        "tok",
        "gone",
        undefined,
        undefined,
        http,
      ),
    ).rejects.toThrow(NotFoundError);
  });

  it("parses the card-shaped results body (no fares[]) (issues #1117 + #1308)", async () => {
    const http = (() =>
      Promise.resolve(Response.json(FLIGHTS_CARD_RESULT))) as HttpFetch;

    // A card response has no `fares[]`, so the trip schema would throw on it. The
    // results read parses with the card schema unconditionally now.
    const out = await fetchFlightResults(
      "https://api.wego.com",
      "tok",
      "s1msr",
      {},
      undefined,
      http,
    );
    expect(out.searchId).toBe("s1msr");
    const card = out.results[0] as { tripId: string; price: { scope: string } };
    expect(card.tripId).toBe("s1msr:T1");
    expect(card.price.scope).toBe("party");
    // The card body carries no fares — confirm nothing tried to require them.
    expect("fares" in out.results[0]).toBe(false);
  });

  it("parses a card whose price scope the old z.literal rejected (#1300 D3)", async () => {
    // `scope` was `z.literal("party")`. The API changing that label — or adding a
    // per-person scope — would have failed the WHOLE results read on a string the
    // CLI does not branch on, it only prints. Every installed binary carries the
    // literal compiled in and would never see a fix.
    const [firstCard] = FLIGHTS_CARD_RESULT.results;
    const http = (() =>
      Promise.resolve(
        Response.json({
          ...FLIGHTS_CARD_RESULT,
          results: [
            { ...firstCard, price: { ...firstCard.price, scope: "person" } },
          ],
        }),
      )) as HttpFetch;

    const out = await fetchFlightResults(
      "https://api.wego.com",
      "tok",
      "s1msr",
      {},
      undefined,
      http,
    );
    const card = out.results[0] as { price: { scope: string } };
    expect(card.price.scope).toBe("person");
  });

  it("rejects a trip-shaped results body (the retired projection) as an unexpected body", async () => {
    // If a deployed API ever answered the results read with the pre-#1308 trip
    // envelope again, the CLI must FAIL rather than print a page whose price
    // summary it would then have to invent.
    const http = (() =>
      Promise.resolve(Response.json(FLIGHTS_RESULT))) as HttpFetch;

    await expect(
      fetchFlightResults(
        "https://api.wego.com",
        "tok",
        "s1msr",
        undefined,
        undefined,
        http,
      ),
    ).rejects.toThrow(/unexpected body/);
  });
});

describe("fetchFlightTrip", () => {
  it("sends the searchId query param and returns the trip", async () => {
    let seen: URL | undefined;
    const http = ((url: string) => {
      seen = new URL(url);
      return Promise.resolve(Response.json(FLIGHTS_RESULT.results[0]));
    }) as HttpFetch;

    const out = await fetchFlightTrip(
      "https://api.wego.com",
      "tok",
      "s1msr:T1",
      "s1msr",
      "SGD",
      undefined,
      undefined,
      undefined,
      http,
    );
    expect(out.tripId).toBe("s1msr:T1");
    expect(seen?.searchParams.get("currency")).toBe("SGD");
    expect(seen?.pathname).toBe("/v1/flights/trips/s1msr%3AT1");
    expect(seen?.searchParams.get("searchId")).toBe("s1msr");
    // No `--view` given → no `view` on the wire, so the default read's query
    // string is byte-identical to what it was before the flag existed. Sending
    // `view=default` explicitly would work too, and would make every existing
    // recording key miss.
    expect(seen?.searchParams.has("view")).toBe(false);
  });

  it("puts `--view detail` on the wire and parses the detail variant", async () => {
    // The `?view=` half of the flag, at the layer that owns the query string.
    // `parseFlightTripArgs` owns the parse/validate half, and
    // `integration/flights.test.ts` drives `--view` through the compiled binary.
    let seen: URL | undefined;
    // The DETAIL shape, which is not the default trip: `legs[]` instead of
    // `outbound`/`return`, and a `provider` OBJECT instead of a flat
    // `providerCode`. A body like this used to make the CLI throw a parse fault,
    // because `CleanTripSchema` requires that flat field.
    const detailBody = {
      tripId: "s1msr:T1",
      stops: 0,
      durationMinutes: 145,
      legs: [{ segments: [{ from: { code: "SIN", name: "Changi" } }] }],
      fares: [
        {
          kind: "wego",
          fareId: "s1msr:zt.wego.com:abc:soo",
          provider: { code: "zt.wego.com", logoUrl: "https://x/y.png" },
          price: { total: 300, totalUsd: 300, currency: "SGD" },
          handoffUrl: "https://wego.com/x",
        },
      ],
    };
    const http = ((url: string) => {
      seen = new URL(url);
      return Promise.resolve(Response.json(detailBody));
    }) as HttpFetch;

    const out = await fetchFlightTrip(
      "https://api.wego.com",
      "tok",
      "s1msr:T1",
      "s1msr",
      undefined,
      undefined,
      "detail",
      undefined,
      http,
    );
    expect(seen?.searchParams.get("view")).toBe("detail");
    expect(out.tripId).toBe("s1msr:T1");
    // Parsed, not rejected: the union's second member claims it.
    expect("legs" in out).toBe(true);
  });
});

// --- issue #1110: the error layer reads the problem body + headers ------------
//
// Before the fix, a non-401/404 failure threw a bare `Error("<label> failed:
// <status> <statusText>")` — the RFC 9457 body (`code`/`detail`/`trace_id`), the
// `x-trace-id` header, and `Retry-After` were all discarded, and no read was ever
// retried. These tests pin the new typed `ApiHttpError` + bounded GET retry.

/** A full `application/problem+json` error response, like the one `apps/api`
 *  sends (RFC 9457 body + `x-trace-id` header, plus `Retry-After` on 429/503). */
function problemResponse(
  status: number,
  code: string,
  detail: string,
  extra: { traceId?: string; retryAfter?: string } = {},
): Response {
  const headers: Record<string, string> = {
    "content-type": "application/problem+json",
  };
  if (extra.traceId) headers["x-trace-id"] = extra.traceId;
  if (extra.retryAfter) headers["retry-after"] = extra.retryAfter;
  return new Response(
    JSON.stringify({
      type: "about:blank",
      title: "err",
      status,
      detail,
      code,
      trace_id: extra.traceId,
    }),
    { status, headers },
  );
}

describe("ApiHttpError (issue #1110)", () => {
  it("parses code/detail/trace_id off a non-retryable problem response (GET)", async () => {
    const http = (() =>
      Promise.resolve(
        problemResponse(502, "bad_gateway", "The flights service failed.", {
          traceId: "trace-502",
        }),
      )) as HttpFetch;

    const err = (await fetchWhoami(
      "https://api.wego.com",
      "tok",
      undefined,
      http,
    ).catch((e) => e)) as ApiHttpError;
    expect(err).toBeInstanceOf(ApiHttpError);
    expect(err.status).toBe(502);
    expect(err.code).toBe("bad_gateway");
    expect(err.detail).toBe("The flights service failed.");
    expect(err.traceId).toBe("trace-502");
    // message keeps the historical "<label> failed: <status>" prefix
    expect(err.message).toContain("GET /v1/user failed: 502");
  });

  it("prefers x-trace-id header but falls back to the body trace_id", async () => {
    const http = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            status: 500,
            code: "internal",
            trace_id: "body-tr",
          }),
          {
            status: 500,
            headers: { "content-type": "application/problem+json" },
          },
        ),
      )) as HttpFetch;
    const err = (await fetchWhoami(
      "https://api.wego.com",
      "tok",
      undefined,
      http,
    ).catch((e) => e)) as ApiHttpError;
    expect(err.traceId).toBe("body-tr");
  });

  it("captures Retry-After seconds from the header (parsed regardless of status)", async () => {
    // Use a non-retryable status so the parse assertion doesn't actually wait out
    // the Retry-After delay — header parsing in readApiError is status-agnostic.
    const http = (() =>
      Promise.resolve(
        problemResponse(400, "validation_failed", "bad", { retryAfter: "7" }),
      )) as HttpFetch;
    const err = (await fetchWhoami(
      "https://api.wego.com",
      "tok",
      undefined,
      http,
    ).catch((e) => e)) as ApiHttpError;
    expect(err.status).toBe(400);
    expect(err.code).toBe("validation_failed");
    expect(err.retryAfterSeconds).toBe(7);
  });

  it("tolerates a malformed error body (status-only, flagged)", async () => {
    const http = (() =>
      Promise.resolve(
        new Response("<html>nope</html>", {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
      )) as HttpFetch;
    const err = (await fetchWhoami(
      "https://api.wego.com",
      "tok",
      undefined,
      http,
    ).catch((e) => e)) as ApiHttpError;
    expect(err).toBeInstanceOf(ApiHttpError);
    expect(err.status).toBe(500);
    expect(err.bodyParseError).toBe(true);
    expect(err.code).toBeUndefined();
  });

  it("does not flag an empty body under a JSON content-type (bare 429)", async () => {
    // A proxy commonly returns a bare 429/503 with a JSON content-type header but
    // no payload. That's nothing to parse — not a malformed body — so it must not
    // set bodyParseError (which would misreport a healthy rate-limit as corrupt).
    const http = (() =>
      Promise.resolve(
        new Response("", {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
      )) as HttpFetch;
    const err = (await fetchWhoami(
      "https://api.wego.com",
      "tok",
      undefined,
      http,
    ).catch((e) => e)) as ApiHttpError;
    expect(err).toBeInstanceOf(ApiHttpError);
    expect(err.status).toBe(429);
    expect(err.bodyParseError).toBe(false);
    expect(err.code).toBeUndefined();
  });

  it("retries a GET once on 503 then succeeds (bounded, honors Retry-After)", async () => {
    let calls = 0;
    const http = (() => {
      calls++;
      if (calls === 1) {
        return Promise.resolve(
          problemResponse(503, "upstream_unavailable", "try again", {
            retryAfter: "0", // 0s → retry is instant in the test
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ sub: "user-1" }), { status: 200 }),
      );
    }) as HttpFetch;

    const id = await fetchWhoami(
      "https://api.wego.com",
      "tok",
      undefined,
      http,
    );
    expect(id).toEqual({ sub: "user-1" });
    expect(calls).toBe(2); // one retry
  });

  it("gives up after the bounded retry budget (2 attempts) on a persistent 503", async () => {
    let calls = 0;
    const http = (() => {
      calls++;
      return Promise.resolve(
        problemResponse(503, "upstream_unavailable", "down", {
          retryAfter: "0",
        }),
      );
    }) as HttpFetch;
    const err = (await fetchWhoami(
      "https://api.wego.com",
      "tok",
      undefined,
      http,
    ).catch((e) => e)) as ApiHttpError;
    expect(err).toBeInstanceOf(ApiHttpError);
    expect(calls).toBe(2); // initial + one retry, no infinite loop
  });

  it("never auto-retries a POST create (would risk a duplicate search)", async () => {
    let calls = 0;
    const http = (() => {
      calls++;
      return Promise.resolve(
        problemResponse(503, "upstream_unavailable", "down", {
          retryAfter: "0",
        }),
      );
    }) as HttpFetch;
    const err = (await createFlightSearch(
      "https://api.wego.com",
      "tok",
      {
        from: "SIN",
        to: "BKK",
        fromDate: "2026-03-01",
      },
      undefined,
      http,
    ).catch((e) => e)) as ApiHttpError;
    expect(err).toBeInstanceOf(ApiHttpError);
    expect(err.status).toBe(503);
    expect(calls).toBe(1); // single-shot – no retry on a non-idempotent create
  });
});

describe("sendFeedback (#1300 D3)", () => {
  it("accepts an acknowledgement status the old z.literal rejected", async () => {
    // `status` was `z.literal("received")`. A fire-and-forget acknowledgement is
    // the last place a new status value should make a command fail, and nothing
    // branches on it — the CLI prints the envelope.
    const http = (() =>
      Promise.resolve(
        Response.json({ status: "queued" }, { status: 202 }),
      )) as HttpFetch;
    const out = await sendFeedback(
      "https://api.wego.com",
      "tok",
      {
        rating: 5,
      },
      undefined,
      http,
    );
    expect(out).toEqual({ status: "queued" });
  });
});

describe("the wego info calls build the wire query (moved here in #1341)", () => {
  /** Capture the URL one call produced, answering with a body its schema accepts. */
  function urlFor(body: unknown): { seen: () => URL; http: HttpFetch } {
    let seen: URL | undefined;
    return {
      seen: () => seen as URL,
      http: ((url: string | URL) => {
        seen = new URL(String(url));
        return Promise.resolve(Response.json(body));
      }) as HttpFetch,
    };
  }

  const HOLIDAYS = {
    results: [],
    metadata: {
      resultCount: 0,
      countryCode: "SG",
      window: "explicit",
      from: "2026-08-01",
      to: "2026-12-31",
    },
  };
  const VISA_FREE = {
    results: [],
    metadata: {
      resultCount: 0,
      totalCandidates: 0,
      hasMore: false,
      passportCountryCode: "PH",
      upstreamPagesFetched: 1,
      coverage: "complete",
    },
  };
  const SCHEDULES = {
    results: [],
    metadata: {
      page: 1,
      pageSize: 200,
      resultCount: 0,
      totalCandidates: 0,
      hasMore: false,
      coverage: "complete",
      from: { requested: "SIN", resolvedCityCode: "SIN" },
      to: { requested: "LHR", resolvedCityCode: "LON" },
      siteCode: "SG",
      siteCodeSource: "explicit",
    },
  };
  const NEARBY = {
    results: [],
    metadata: {
      resultCount: 0,
      totalCandidates: 0,
      hasMore: false,
      origin: {
        place: "LON",
        latitude: 51.5,
        longitude: -0.12,
        resolvedFrom: "place",
      },
      radiusKm: 100,
      types: ["airport"],
    },
  };

  it("holidays: the country rides in the path, and --from/--to become fromDate/toDate", async () => {
    // The rename is the whole reason this assertion exists: `from`/`to` already mean
    // PLACE CODES on the flights operations, so the country-keyed read had to take
    // `fromDate`/`toDate` on the wire while the CLI keeps the shorter flags. A CLI
    // that sent `from=2026-08-01` would be answered by a validation error.
    const { seen, http } = urlFor(HOLIDAYS);
    await fetchHolidays(
      "https://api.wego.com",
      "tok",
      { countryCode: "SG", from: "2026-08-01", to: "2026-12-31" },
      undefined,
      http,
    );
    expect(seen().pathname).toBe("/v1/countries/SG/holidays");
    expect(seen().searchParams.get("fromDate")).toBe("2026-08-01");
    expect(seen().searchParams.get("toDate")).toBe("2026-12-31");
    expect(seen().searchParams.get("from")).toBeNull();
    expect(seen().searchParams.get("to")).toBeNull();
  });

  it("holidays: an absent window sends no date params at all", async () => {
    const { seen, http } = urlFor(HOLIDAYS);
    await fetchHolidays(
      "https://api.wego.com",
      "tok",
      { countryCode: "SG" },
      undefined,
      http,
    );
    // Absent, never `fromDate=`: an empty value is a validation error, not a
    // "search the default window" signal.
    expect(seen().searchParams.has("fromDate")).toBe(false);
    expect(seen().searchParams.has("toDate")).toBe(false);
  });

  it("visa-free: the passport country rides in the path, paging in the query", async () => {
    const { seen, http } = urlFor(VISA_FREE);
    await fetchVisaFree(
      "https://api.wego.com",
      "tok",
      { countryCode: "PH", pageSize: 10 },
      undefined,
      http,
    );
    expect(seen().pathname).toBe("/v1/countries/PH/visa-free-destinations");
    expect(seen().searchParams.get("pageSize")).toBe("10");
  });

  it("schedules: route, airline and site all travel as query params", async () => {
    const { seen, http } = urlFor(SCHEDULES);
    await fetchSchedules(
      "https://api.wego.com",
      "tok",
      { from: "SIN", to: "LHR", airline: "SQ", siteCode: "SG" },
      undefined,
      http,
    );
    expect(seen().pathname).toBe("/v1/flights/schedules");
    expect(seen().searchParams.get("from")).toBe("SIN");
    expect(seen().searchParams.get("to")).toBe("LHR");
    expect(seen().searchParams.get("airline")).toBe("SQ");
    expect(seen().searchParams.get("siteCode")).toBe("SG");
  });

  it("airports-near: a place code travels as `place`, and types repeat", async () => {
    const { seen, http } = urlFor(NEARBY);
    await fetchNearbyPlaces(
      "https://api.wego.com",
      "tok",
      { place: "LON", types: ["airport", "city"] },
      undefined,
      http,
    );
    expect(seen().searchParams.get("place")).toBe("LON");
    expect(seen().searchParams.has("latitude")).toBe(false);
    // Repeated params, matching the API's array parsing — not a CSV.
    expect(seen().searchParams.getAll("types")).toEqual(["airport", "city"]);
  });

  it("airports-near: a coordinate pair travels as latitude + longitude", async () => {
    const { seen, http } = urlFor(NEARBY);
    await fetchNearbyPlaces(
      "https://api.wego.com",
      "tok",
      { latitude: 51.5, longitude: -0.12 },
      undefined,
      http,
    );
    expect(seen().searchParams.get("latitude")).toBe("51.5");
    expect(seen().searchParams.get("longitude")).toBe("-0.12");
    expect(seen().searchParams.has("place")).toBe(false);
  });
});

describe("fetchHotelResults response tolerance (moved here in #1341)", () => {
  it("drops a malformed snapshotCandidateCount instead of surfacing or throwing", async () => {
    // The settle counter is `.int().nonnegative().optional().catch(undefined)`, so a
    // negative, fractional, non-numeric or null value degrades to undefined and the
    // caller falls back to item-presence. Asserted here because it is the RESPONSE
    // SCHEMA's behaviour: `integration/hotels.test.ts` drives the settle through
    // the binary, against contract-valid answers that never carry a malformed count.
    for (const bad of [-1, 2.5, "not-a-number", null] as unknown[]) {
      const http = (() =>
        Promise.resolve(
          Response.json({
            searchId: "sid-1",
            searchComplete: false,
            results: [{ hotelId: 1, name: "Grand Hyatt" }],
            metadata: { snapshotCandidateCount: bad },
          }),
        )) as HttpFetch;
      const page = await fetchHotelResults(
        "https://api.wego.com",
        "tok",
        "sid-1",
        {},
        undefined,
        http,
      );
      expect(page.metadata?.snapshotCandidateCount).toBeUndefined();
    }
  });

  it("keeps a well-formed count", async () => {
    const http = (() =>
      Promise.resolve(
        Response.json({
          searchId: "sid-1",
          searchComplete: false,
          results: [{ hotelId: 1, name: "Grand Hyatt" }],
          metadata: { snapshotCandidateCount: 7 },
        }),
      )) as HttpFetch;
    const page = await fetchHotelResults(
      "https://api.wego.com",
      "tok",
      "sid-1",
      {},
      undefined,
      http,
    );
    expect(page.metadata?.snapshotCandidateCount).toBe(7);
  });
});

describe("fetchFlightResults response tolerance (moved here in #1341)", () => {
  /** The card envelope - the only projection this read serves since #1308. */
  const body = (count: unknown) => ({
    searchId: "s1msr",
    currencyCode: "USD",
    metadata: {
      page: 1,
      pageSize: 10,
      resultCount: 1,
      totalCandidates: 1,
      hasMore: false,
      snapshotFareCount: count,
    },
    results: FLIGHTS_CARD_RESULT.results,
  });

  const read = (payload: unknown) => {
    const http = (() => Promise.resolve(Response.json(payload))) as HttpFetch;
    return fetchFlightResults(
      "https://api.wego.com",
      "tok",
      "s1msr",
      {},
      undefined,
      http,
    );
  };

  it("drops a malformed snapshotFareCount", async () => {
    // `.int().nonnegative().optional().catch(undefined)`: a negative, fractional,
    // non-numeric or null count degrades to undefined so the settle falls back to
    // item-presence instead of converging on a bogus number or throwing. The
    // fallback itself is `settle`'s, in `search-engine.test.ts`; the parse is asserted here.
    for (const bad of [-1, 2.5, "not-a-number", null] as unknown[]) {
      const page = await read(body(bad));
      expect(page.metadata?.snapshotFareCount).toBeUndefined();
    }
  });

  it("keeps a well-formed count", async () => {
    expect((await read(body(7))).metadata?.snapshotFareCount).toBe(7);
  });
});

describe("fetchHotelReviews builds the wire query", () => {
  /** A body `HotelReviewsResponseSchema` accepts, so the call reaches its parse. */
  const REVIEWS = {
    hotelId: 85481,
    results: [],
    metadata: { totalCandidates: 49 },
  };

  /** Capture the URL the call produced. */
  function urlFor(): { seen: () => URL; http: HttpFetch } {
    let seen: URL | undefined;
    return {
      seen: () => seen as URL,
      http: ((url: string | URL) => {
        seen = new URL(String(url));
        return Promise.resolve(Response.json(REVIEWS));
      }) as HttpFetch,
    };
  }

  it("puts the hotel in the path and every flag under its published name", async () => {
    // `integration/hotels.test.ts` asserts what reaches the wire from argv; this
    // pins the serialization at the layer that writes it. One request legitimately carries both
    // spellings: kebab for the net-new knob, camel for the mirrored one.
    const { seen, http } = urlFor();
    await fetchHotelReviews(
      "https://api.wego.com",
      "tok",
      85481,
      {
        topics: "breakfast,pool",
        "guest-type": "couple",
        sort: "rating_desc",
        pageSize: "20",
        view: "detail",
      },
      undefined,
      http,
    );
    expect(seen().pathname).toBe("/v1/hotels/85481/reviews");
    expect(seen().searchParams.get("topics")).toBe("breakfast,pool");
    expect(seen().searchParams.get("guest-type")).toBe("couple");
    expect(seen().searchParams.get("sort")).toBe("rating_desc");
    expect(seen().searchParams.get("pageSize")).toBe("20");
    expect(seen().searchParams.get("view")).toBe("detail");
  });

  it("sends no parameters at all for a bare read", async () => {
    const { seen, http } = urlFor();
    await fetchHotelReviews(
      "https://api.wego.com",
      "tok",
      85481,
      {},
      undefined,
      http,
    );
    expect(seen().search).toBe("");
  });
});

describe("fetchSearchLink builds the wire query", () => {
  /** A body `SearchLinkResponseSchema` accepts, so the call reaches its parse. */
  const LINK = {
    searchUrl: "https://www.wego.com/flights/searches/SIN-BKK-2026-09-15",
    expires: false,
  };

  /** Capture the URL the call produced. */
  function urlFor(): { seen: () => URL; http: HttpFetch } {
    let seen: URL | undefined;
    return {
      seen: () => seen as URL,
      http: ((url: string | URL) => {
        seen = new URL(String(url));
        return Promise.resolve(Response.json(LINK));
      }) as HttpFetch,
    };
  }

  it("puts the whole search context on the wire under its published names", async () => {
    // `integration/flights.test.ts` asserts what reaches the wire from argv; the
    // KEY names are asserted here too, at the layer that writes them. `applyFlightLinkQuery` is shared with
    // `booking-link`, so a rename would silently move both.
    const { seen, http } = urlFor();
    await fetchSearchLink(
      "https://api.wego.com",
      "tok",
      {
        from: "SIN",
        to: "BKK",
        fromDate: "2026-09-15",
        toDate: "2026-09-22",
        cabin: "business",
        adults: 2,
        children: 1,
        infants: 1,
        siteCode: "SG",
        currency: "USD",
        locale: "en",
        fromCity: true,
        toCity: true,
      },
      undefined,
      http,
    );
    expect(seen().pathname).toBe("/v1/flights/search-link");
    expect(seen().searchParams.get("from")).toBe("SIN");
    expect(seen().searchParams.get("to")).toBe("BKK");
    expect(seen().searchParams.get("fromDate")).toBe("2026-09-15");
    expect(seen().searchParams.get("toDate")).toBe("2026-09-22");
    expect(seen().searchParams.get("cabin")).toBe("business");
    expect(seen().searchParams.get("adults")).toBe("2");
    expect(seen().searchParams.get("children")).toBe("1");
    expect(seen().searchParams.get("infants")).toBe("1");
    expect(seen().searchParams.get("siteCode")).toBe("SG");
    expect(seen().searchParams.get("currency")).toBe("USD");
    expect(seen().searchParams.get("locale")).toBe("en");
    expect(seen().searchParams.get("fromCity")).toBe("true");
    expect(seen().searchParams.get("toCity")).toBe("true");
    // No search-scoped id can reach this route: the `SearchLinkParams` Omit forbids
    // them at the type level, and the shared writer must not add them back.
    expect(seen().searchParams.get("tripId")).toBeNull();
    expect(seen().searchParams.get("searchId")).toBeNull();
    expect(seen().searchParams.get("fareOptionId")).toBeNull();
  });
});
