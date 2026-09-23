/**
 * Login, whoami and logout: the PKCE login over the binary's own loopback
 * listener, the stored session every other command runs on, and the ways a
 * session ends.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { TEST_CLIENT_ID } from "./harness/fake";
import { route } from "./harness/fixtures";
import { loginThroughBrowser } from "./harness/login";
import { useScenario } from "./harness/scenario";
import { idToken, json, signIn } from "./harness/wego";

const s = useScenario();

describe("login", () => {
  it("logs in with PKCE over the loopback and stores the tokens 0600", async () => {
    const fake = s.fake();
    const { result, authorize } = await loginThroughBrowser(fake, s.home, {
      tokens: {
        access_token: "access-9",
        refresh_token: "refresh-9",
        expires_in: 3600,
        id_token: idToken({ country_code: "SG", exp: 4_102_444_800 }),
      },
    });

    expect(result.code).toBe(0);
    expect(result.out).toBe("");
    expect(result.err).toContain("Login successful");
    expect(authorize.get("response_type")).toBe("code");
    expect(authorize.get("client_id")).toBe(TEST_CLIENT_ID);
    expect(authorize.get("code_challenge_method")).toBe("S256");
    expect(authorize.get("state")).toMatch(/.{16,}/);
    expect(authorize.get("redirect_uri")).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
    );
    const stored = JSON.parse(readFileSync(s.home.credentialsPath, "utf8"));
    expect(stored).toMatchObject({
      accessToken: "access-9",
      refreshToken: "refresh-9",
      market: "SG",
    });
    if (process.platform !== "win32") {
      expect(statSync(s.home.credentialsPath).mode & 0o777).toBe(0o600);
    }
  });

  it("ignores a callback whose state is not the one it sent", async () => {
    const fake = s.fake();
    const { result } = await loginThroughBrowser(fake, s.home, {
      tokens: { access_token: "access-9" },
      // A forged callback first, then the real one: only the real one may count.
      before: (redirectUri) => `${redirectUri}?code=forged-code&state=forged`,
    });

    expect(result.code).toBe(0);
    expect(fake.tokenRequests.map((t) => t.form.get("code"))).toEqual([
      "code-1",
    ]);
  });

  it("ignores a callback that claims another host, even with the right state", async () => {
    const fake = s.fake();
    const { result } = await loginThroughBrowser(fake, s.home, {
      tokens: { access_token: "access-9" },
      // Right state, wrong origin: it may neither complete nor cancel the login.
      before: (redirectUri, state) => ({
        url: `${redirectUri}?error=access_denied&state=${encodeURIComponent(state)}`,
        headers: { host: "evil.example" },
      }),
    });

    expect(result.code).toBe(0);
    expect(result.err).toContain("Login successful");
    expect(fake.tokenRequests.map((t) => t.form.get("code"))).toEqual([
      "code-1",
    ]);
  });

  it("fails with exit 2 when the token exchange is rejected", async () => {
    const fake = s.fake();
    const { result } = await loginThroughBrowser(fake, s.home, {
      tokens: { access_token: "access-9" },
      callback: (redirectUri, state) =>
        `${redirectUri}?code=not-issued&state=${encodeURIComponent(state)}`,
    });

    expect(result.code).toBe(2);
    expect(result.err).toContain("Login failed");
    expect(existsSync(s.home.credentialsPath)).toBe(false);
  });

  it("rejects an unknown option before touching the network", async () => {
    const fake = s.fake();
    const result = await s.run(["login", "--nope"]);

    expect(result.code).toBe(2);
    expect(fake.tokenRequests).toEqual([]);
  });
});

describe("whoami", () => {
  it("prints the caller's identity as JSON", async () => {
    signIn(s.home);
    const fake = s.fake({ routes: [route("user")] });
    const result = await s.run(["whoami"]);

    expect(result.code).toBe(0);
    expect(json(result)).toMatchObject({ sub: "integration@example.com" });
    expect(fake.requests("getCurrentUser")[0]?.token).toBe("access-1");
  });

  it("tells a logged-out user to run login, with exit 3", async () => {
    const fake = s.fake();
    const result = await s.run(["whoami"]);

    expect(result.code).toBe(3);
    expect(result.out).toBe("");
    expect(result.err).toMatch(/login/);
    expect(fake.seen).toEqual([]);
  });

  it("refreshes an expired token first and stores the rotation", async () => {
    signIn(s.home, {
      accessToken: "access-old",
      refreshToken: "refresh-1",
      expiresAt: Date.now() - 1000,
    });
    const fake = s.fake({
      accept: [],
      routes: [route("user")],
      refresh: [
        {
          access_token: "access-2",
          refresh_token: "refresh-2",
          expires_in: 3600,
        },
      ],
    });
    const result = await s.run(["whoami"]);

    expect(result.code).toBe(0);
    expect(fake.tokenRequests.map((t) => t.grantType)).toEqual([
      "refresh_token",
    ]);
    expect(fake.tokenRequests[0]?.form.get("refresh_token")).toBe("refresh-1");
    expect(fake.requests("getCurrentUser").map((r) => r.token)).toEqual([
      "access-2",
    ]);
    const stored = JSON.parse(readFileSync(s.home.credentialsPath, "utf8"));
    expect(stored).toMatchObject({
      accessToken: "access-2",
      refreshToken: "refresh-2",
    });
  });

  it("recovers from a 401 by refreshing once and retrying", async () => {
    signIn(s.home, {
      accessToken: "access-revoked",
      refreshToken: "refresh-1",
    });
    const fake = s.fake({
      accept: [],
      routes: [route("user")],
      refresh: [{ access_token: "access-2", refresh_token: "refresh-2" }],
    });
    const result = await s.run(["whoami"]);

    expect(result.code).toBe(0);
    expect(fake.requests("getCurrentUser").map((r) => r.token)).toEqual([
      "access-revoked",
      "access-2",
    ]);
  });

  it("exits 3 and points to login when the refresh token is rejected", async () => {
    signIn(s.home, {
      accessToken: "access-old",
      refreshToken: "refresh-dead",
      expiresAt: Date.now() - 1000,
    });
    s.fake({ accept: [], refresh: [] });
    const result = await s.run(["whoami"]);

    expect(result.code).toBe(3);
    expect(result.out).toBe("");
    expect(result.err).toMatch(/login/);
  });
});

describe("logout", () => {
  it("removes the stored credentials", async () => {
    signIn(s.home);
    s.fake();
    const result = await s.run(["logout"]);

    expect(result.code).toBe(0);
    expect(existsSync(s.home.credentialsPath)).toBe(false);
  });

  it("leaves the next whoami logged out", async () => {
    signIn(s.home);
    s.fake();
    await s.run(["logout"]);
    const result = await s.run(["whoami"]);

    expect(result.code).toBe(3);
  });
});
