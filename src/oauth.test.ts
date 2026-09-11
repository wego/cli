import { afterEach, describe, expect, it } from "bun:test";
import {
  buildAuthorizeUrl,
  exchangeCode,
  isExpired,
  isIdTokenUsable,
  parseTokenError,
  parseTokenResponse,
  redactSecrets,
  refreshTokens,
  TokenEndpointError,
} from "./oauth";
import { loadTestCliConfig } from "./test-config";

const config = loadTestCliConfig({
  WEGO_AUTH_AUTHORIZE_URL:
    "https://auth.wego.com/user-auth/v2/users/oauth/authorize",
  WEGO_AUTH_TOKEN_URL: "https://auth.wego.com/user-auth/v2/users/oauth/token",
  WEGO_CLI_CLIENT_ID: "cli-abc",
  WEGO_CLI_SCOPES: "openid profile users",
});

describe("buildAuthorizeUrl", () => {
  it("includes all PKCE + OAuth params with S256", () => {
    const url = new URL(
      buildAuthorizeUrl(config, {
        redirectUri: "http://127.0.0.1:5500/callback",
        state: "st-1",
        codeChallenge: "chal-1",
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://auth.wego.com/user-auth/v2/users/oauth/authorize",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("cli-abc");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:5500/callback",
    );
    expect(url.searchParams.get("scope")).toBe("openid profile users");
    expect(url.searchParams.get("state")).toBe("st-1");
    expect(url.searchParams.get("code_challenge")).toBe("chal-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });
});

describe("parseTokenResponse", () => {
  it("maps access/refresh tokens and computes expiresAt from expires_in", () => {
    const t = parseTokenResponse(
      { access_token: "at", refresh_token: "rt", expires_in: 3600 },
      1_000_000,
    );
    expect(t).toEqual({
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: 1_000_000 + 3600 * 1000,
    });
  });

  it("leaves expiresAt undefined when expires_in is absent/invalid", () => {
    expect(
      parseTokenResponse({ access_token: "at" }).expiresAt,
    ).toBeUndefined();
  });

  it("keeps the raw id_token, which carries the identity hashes", () => {
    const t = parseTokenResponse({ access_token: "at", id_token: "id-tok" });
    expect(t.idToken).toBe("id-tok");
  });

  it("leaves idToken undefined when the response carries no id_token", () => {
    expect(parseTokenResponse({ access_token: "at" }).idToken).toBeUndefined();
  });

  it("ignores a non-string id_token rather than storing it", () => {
    expect(
      parseTokenResponse({ access_token: "at", id_token: { a: 1 } }).idToken,
    ).toBeUndefined();
  });

  it("throws when access_token is missing", () => {
    expect(() => parseTokenResponse({ refresh_token: "rt" })).toThrow(
      /access_token/,
    );
  });

  it("decodes the market from the id_token's country_code (uppercased)", () => {
    const idToken = `x.${Buffer.from(JSON.stringify({ country_code: "sg" })).toString("base64url")}.sig`;
    expect(
      parseTokenResponse({ access_token: "at", id_token: idToken }).market,
    ).toBe("SG");
  });

  it("leaves market undefined for absent / no-country / malformed id_token", () => {
    const tok = (p: Record<string, unknown>) =>
      `x.${Buffer.from(JSON.stringify(p)).toString("base64url")}.sig`;
    expect(parseTokenResponse({ access_token: "at" }).market).toBeUndefined();
    expect(
      parseTokenResponse({ access_token: "at", id_token: tok({}) }).market,
    ).toBeUndefined();
    expect(
      parseTokenResponse({
        access_token: "at",
        id_token: tok({ country_code: "USA" }),
      }).market,
    ).toBeUndefined();
    expect(
      parseTokenResponse({ access_token: "at", id_token: "not-a-jwt" }).market,
    ).toBeUndefined();
  });
});

describe("token endpoint calls", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("exchangeCode posts the authorization_code grant form-encoded", async () => {
    let captured: { url: string; body: string } | undefined;
    globalThis.fetch = ((url: string, init: RequestInit) => {
      captured = { url, body: String(init.body) };
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: "at", expires_in: 60 }), {
          status: 200,
        }),
      );
    }) as unknown as typeof fetch;

    const t = await exchangeCode(config, {
      code: "auth-code",
      codeVerifier: "verifier",
      redirectUri: "http://127.0.0.1:5500/callback",
    });
    expect(t.accessToken).toBe("at");
    expect(captured?.url).toBe(
      "https://auth.wego.com/user-auth/v2/users/oauth/token",
    );
    const body = new URLSearchParams(captured?.body);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code");
    expect(body.get("code_verifier")).toBe("verifier");
    expect(body.get("client_id")).toBe("cli-abc");
  });

  it("refreshTokens posts the refresh_token grant", async () => {
    let body = "";
    globalThis.fetch = ((_url: string, init: RequestInit) => {
      body = String(init.body);
      return Promise.resolve(
        new Response(
          JSON.stringify({ access_token: "at2", refresh_token: "rt2" }),
          {
            status: 200,
          },
        ),
      );
    }) as unknown as typeof fetch;

    const t = await refreshTokens(config, "rt1");
    expect(t.accessToken).toBe("at2");
    expect(t.refreshToken).toBe("rt2");
    expect(new URLSearchParams(body).get("grant_type")).toBe("refresh_token");
    expect(new URLSearchParams(body).get("refresh_token")).toBe("rt1");
  });

  it("throws a TokenEndpointError carrying the OAuth2 error on a non-OK response", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        Response.json(
          { error: "invalid_grant", error_description: "revoked" },
          { status: 400, statusText: "Bad Request" },
        ),
      )) as unknown as typeof fetch;
    const err = await refreshTokens(config, "rt").catch((e) => e);
    expect(err).toBeInstanceOf(TokenEndpointError);
    expect(err.status).toBe(400);
    expect(err.oauthError).toBe("invalid_grant");
    expect(err.oauthErrorDescription).toBe("revoked");
    expect(err.message).toMatch(/token endpoint failed: 400 .*invalid_grant/);
  });

  it("bounds a huge non-OAuth2 error body to a capped snippet", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("q".repeat(50_000), {
          status: 502,
          statusText: "Bad Gateway",
        }),
      )) as unknown as typeof fetch;
    const err = await refreshTokens(config, "rt").catch((e) => e);
    expect(err).toBeInstanceOf(TokenEndpointError);
    expect(err.bodySnippet).toHaveLength(500);
  });

  it("degrades to the bare status line when the error body cannot be read", async () => {
    globalThis.fetch = (() => {
      const res = new Response("unreadable", {
        status: 400,
        statusText: "Bad Request",
      });
      // Lock the stream so `readCappedBody`'s getReader throws — the never-throws
      // contract must still yield a TokenEndpointError, not a raw error.
      res.body?.getReader();
      return Promise.resolve(res);
    }) as unknown as typeof fetch;
    const err = await refreshTokens(config, "rt").catch((e) => e);
    expect(err).toBeInstanceOf(TokenEndpointError);
    expect(err.status).toBe(400);
    expect(err.bodySnippet).toBeUndefined();
    expect(err.message).toBe("token endpoint failed: 400 Bad Request");
  });
});

describe("parseTokenError", () => {
  it("extracts the RFC 6749 error + description from a JSON body", () => {
    const err = parseTokenError(
      400,
      "Bad Request",
      JSON.stringify({ error: "invalid_grant", error_description: "expired" }),
    );
    expect(err.oauthError).toBe("invalid_grant");
    expect(err.oauthErrorDescription).toBe("expired");
    expect(err.bodySnippet).toBeUndefined(); // structured, so no raw snippet
    expect(err.message).toBe(
      "token endpoint failed: 400 Bad Request (invalid_grant: expired)",
    );
  });

  it("keeps a bounded raw snippet when the body is not OAuth2 JSON", () => {
    const err = parseTokenError(
      502,
      "Bad Gateway",
      "<html>captive portal</html>",
    );
    expect(err.oauthError).toBeUndefined();
    expect(err.bodySnippet).toBe("<html>captive portal</html>");
    expect(err.message).toBe("token endpoint failed: 502 Bad Gateway");
  });

  it("caps the retained snippet at 500 chars", () => {
    const err = parseTokenError(500, "Server Error", "x".repeat(2000));
    expect(err.bodySnippet).toHaveLength(500);
  });

  it("degrades to the bare status line for an empty body", () => {
    const err = parseTokenError(503, "Service Unavailable", "");
    expect(err.oauthError).toBeUndefined();
    expect(err.bodySnippet).toBeUndefined();
    expect(err.message).toBe("token endpoint failed: 503 Service Unavailable");
  });

  it("ignores a JSON body whose error is absent or mistyped", () => {
    const err = parseTokenError(
      400,
      "Bad Request",
      JSON.stringify({ error: 42 }),
    );
    expect(err.oauthError).toBeUndefined();
    expect(err.bodySnippet).toBe('{"error":42}');
  });

  it("caps a long error_description too, not just the raw snippet", () => {
    const err = parseTokenError(
      400,
      "Bad Request",
      JSON.stringify({
        error: "invalid_grant",
        error_description: "y".repeat(2000),
      }),
    );
    expect(err.oauthErrorDescription).toHaveLength(500);
  });

  it("caps the RFC 6749 error code, so a hostile endpoint can't flood stderr", () => {
    const err = parseTokenError(
      400,
      "Bad Request",
      JSON.stringify({ error: "z".repeat(2000) }),
    );
    expect(err.oauthError).toHaveLength(500);
  });

  it("caps an oversized statusText the same way", () => {
    const err = parseTokenError(400, "S".repeat(2000), "");
    expect(err.statusText).toHaveLength(500);
  });

  it("takes the structured path when error is empty but error_description is present", () => {
    // Some proxies emit `{"error":""}`; the meaningful text must reach the
    // structured field, not be dumped whole into bodySnippet.
    const err = parseTokenError(
      400,
      "Bad Request",
      JSON.stringify({ error: "", error_description: "revoked" }),
    );
    expect(err.oauthError).toBeUndefined();
    expect(err.oauthErrorDescription).toBe("revoked");
    expect(err.bodySnippet).toBeUndefined();
  });

  it("never ends a truncated snippet on a lone surrogate half", () => {
    // A 😀 (surrogate pair) straddling the 500-char boundary must not leave a
    // lone high surrogate — the record has to be a well-formed string.
    const err = parseTokenError(
      500,
      "x",
      `${"a".repeat(499)}😀${"b".repeat(50)}`,
    );
    const last = err.bodySnippet?.charCodeAt(err.bodySnippet.length - 1) ?? 0;
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    expect(JSON.parse(JSON.stringify(err.bodySnippet))).toBe(err.bodySnippet);
  });
});

describe("redactSecrets", () => {
  it("replaces every occurrence of each sent secret", () => {
    const token = `rt-${"x".repeat(120)}`;
    const body = `error: token ${token} was rejected; retry with ${token}`;
    const out = redactSecrets(body, [token]);
    expect(out).not.toContain(token);
    expect(out.match(/\[REDACTED\]/g)).toHaveLength(2);
  });

  it("skips undefined and too-short values, leaving the text intact", () => {
    const body = "grant_type=refresh_token error=invalid_grant";
    // "invalid_grant" is real text, not a secret; a 2-char value never redacts.
    expect(redactSecrets(body, [undefined, "rt", ""])).toBe(body);
  });

  it("redacts the refresh token even when the AS echoes the whole request", () => {
    const rt = `1${"a".repeat(130)}`;
    const echoed = `{"error":"invalid_request","hint":"refresh_token=${rt}"}`;
    expect(redactSecrets(echoed, [rt])).not.toContain(rt);
  });

  it("redacts a secret the AS reflects in its percent-encoded wire form", () => {
    // `+` `/` `=` are percent-encoded by URLSearchParams on the wire, so a body
    // that echoes the request the AS received carries the encoded token — the
    // raw-value search alone would miss it and leak it into the record.
    const token = `aa+bb/cc=${"d".repeat(120)}`;
    const encoded = new URLSearchParams({ refresh_token: token })
      .toString()
      .slice("refresh_token=".length);
    expect(encoded).not.toBe(token); // the wire form really differs
    const echoed = `{"error":"invalid_request","received":"refresh_token=${encoded}"}`;
    const out = redactSecrets(echoed, [token]);
    expect(out).not.toContain(encoded);
    expect(out).toContain("[REDACTED]");
  });
});

describe("isExpired", () => {
  it("is true at/after expiry minus skew", () => {
    expect(isExpired(1000, 30, 1000)).toBe(true);
    expect(isExpired(40_000, 30, 10_001)).toBe(true); // within 30s skew
  });
  it("is false comfortably before expiry", () => {
    expect(isExpired(100_000, 30, 10_000)).toBe(false);
  });
  it("is false when expiry is unknown", () => {
    expect(isExpired(undefined)).toBe(false);
  });
});

describe("isIdTokenUsable", () => {
  const jwt = (exp: number): string =>
    `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`;
  const NOW = 1_700_000_000_000;
  const DAY = 24 * 60 * 60 * 1000;

  it("accepts an unexpired token", () => {
    expect(isIdTokenUsable(jwt((NOW + 60_000) / 1000), NOW)).toBe(true);
  });

  it("accepts one inside the API's expired-age tolerance", () => {
    expect(isIdTokenUsable(jwt((NOW - DAY + 60_000) / 1000), NOW)).toBe(true);
  });

  it("rejects one past that tolerance, which the API would reject anyway", () => {
    expect(isIdTokenUsable(jwt((NOW - DAY - 60_000) / 1000), NOW)).toBe(false);
  });

  it("rejects a token with no exp, an unparseable one, and a non-string", () => {
    expect(isIdTokenUsable("h.e30.s", NOW)).toBe(false);
    expect(isIdTokenUsable("not-a-jwt", NOW)).toBe(false);
    expect(isIdTokenUsable(undefined, NOW)).toBe(false);
  });
});
