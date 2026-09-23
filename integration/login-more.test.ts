/**
 * The session edges `auth.test.ts` leaves out: login's refusals and the hints it
 * prints for a remote or non-interactive shell, the endpoint checks every command
 * makes, what a refresh keeps and drops, the trace a failed refresh leaves on
 * disk, and the analytics session logout ends.
 *
 * The paste-the-callback path needs a TTY on stdin, which a spawned binary does
 * not have, so it stays with `paste-callback.test.ts` and the `parseLoginArgs`
 * unit tests. Nothing here lets the binary open a browser.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { problem } from "./harness/fake";
import { route } from "./harness/fixtures";
import { loginThroughBrowser } from "./harness/login";
import { useScenario } from "./harness/scenario";
import { idToken, signIn, spawnWego } from "./harness/wego";

const s = useScenario();

const stored = () => JSON.parse(readFileSync(s.home.credentialsPath, "utf8"));
const failurePath = () => join(s.home.configDir, "last-auth-failure.json");

/** An id_token whose `exp` is `ms` from now (negative: already expired). */
const idTokenExpiringIn = (ms: number) =>
  idToken({ exp: Math.floor((Date.now() + ms) / 1000) });

/** Start `login`, wait for the authorize URL, and deliver the callback the
 *  "browser" would, returning the finished run. */
async function loginWith(args: string[], env: Record<string, string>) {
  const fake = s.fake();
  const running = spawnWego(["login", ...args], {
    fake,
    home: s.home,
    env,
  });
  const escaped = fake.authorizeUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const [printed] = await running.waitForErr(new RegExp(`${escaped}\\?\\S+`));
  const authorize = new URL(printed).searchParams;
  const redirectUri = authorize.get("redirect_uri") ?? "";
  fake.armCode({
    code: "code-1",
    codeChallenge: authorize.get("code_challenge") ?? "",
    redirectUri,
    tokens: { access_token: "access-9" },
  });
  const state = encodeURIComponent(authorize.get("state") ?? "");
  await fetch(`${redirectUri}?code=code-1&state=${state}`).catch(
    () => undefined,
  );
  return { fake, result: await running.result };
}

/** A stored session whose access token has expired, so the next call refreshes. */
function signInExpired(extra: { refreshToken?: string; idToken?: string }) {
  signIn(s.home, {
    accessToken: "access-old",
    refreshToken: "refresh-1",
    expiresAt: Date.now() - 10_000,
    ...extra,
  });
}

describe("login refusals", () => {
  it("exits 7 when the token endpoint cannot be reached", async () => {
    const { result } = await loginWith(["--no-browser"], {
      // A closed port: the callback arrives, the code exchange cannot.
      WEGO_AUTH_TOKEN_URL: "http://127.0.0.1:9/oauth/token",
    });
    expect(result.code).toBe(7);
    expect(result.err).toContain("Login failed");
    expect(existsSync(s.home.credentialsPath)).toBe(false);
  });

  it("exits 2 when the redirect port is already taken", async () => {
    const occupied = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("busy"),
    });
    try {
      const fake = s.fake();
      const result = await s.run(["login", "--no-browser"], {
        env: { WEGO_CLI_REDIRECT_PORT: String(occupied.port) },
      });
      expect(result.code).toBe(2);
      expect(result.err).toContain("Login failed");
      expect(fake.tokenRequests).toEqual([]);
    } finally {
      occupied.stop(true);
    }
  });

  it("refuses a plaintext auth server that is not localhost, exit 2", async () => {
    const result = await s.run(["login", "--no-browser"], {
      env: {
        WEGO_AUTH_AUTHORIZE_URL: "http://auth.evil.com/authorize",
        WEGO_AUTH_TOKEN_URL: "http://auth.evil.com/token",
      },
    });
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/must be HTTPS/);
  });

  it("exits 2 when both --browser and --no-browser are given", async () => {
    const fake = s.fake();
    const result = await s.run(["login", "--browser", "--no-browser"]);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/not both/);
    expect(fake.tokenRequests).toEqual([]);
  });
});

describe("login without a local browser", () => {
  it("skips the browser inside an SSH session and finishes over the loopback", async () => {
    const { result } = await loginWith([], {
      SSH_CONNECTION: "10.0.0.1 50000 10.0.0.2 22",
    });
    expect(result.code).toBe(0);
    expect(result.err).toMatch(/No browser on this machine/);
    expect(result.err).not.toMatch(/Opening your browser/);
    expect(stored()).toMatchObject({ accessToken: "access-9" });
  });

  it("promises no paste prompt to a caller without a TTY, only the port-forward hint", async () => {
    const fake = s.fake();
    const { result } = await loginThroughBrowser(fake, s.home, {
      tokens: { access_token: "access-9" },
    });
    expect(result.code).toBe(0);
    expect(result.err).not.toMatch(/paste it below/);
    expect(result.err).toMatch(/ssh -L/);
  });
});

describe("endpoint checks", () => {
  it("whoami ignores a malformed WEGO_CLI_REDIRECT_PORT, a login-only setting", async () => {
    signIn(s.home);
    s.fake({ routes: [route("user")] });
    const result = await s.run(["whoami"], {
      env: { WEGO_CLI_REDIRECT_PORT: "abc" },
    });
    expect(result.code).toBe(0);
  });

  it("refuses a plaintext WEGO_API_URL that is not localhost, exit 2", async () => {
    signIn(s.home);
    const result = await s.run(["whoami"], {
      env: { WEGO_API_URL: "http://api.wego.com" },
    });
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/WEGO_API_URL must be HTTPS/);
  });

  it("refuses to refresh over a plaintext token endpoint, exit 3", async () => {
    signInExpired({});
    const fake = s.fake();
    const result = await s.run(["whoami"], {
      env: { WEGO_AUTH_TOKEN_URL: "http://auth.wego.com/token" },
    });
    expect(result.code).toBe(3);
    expect(result.err).toMatch(/WEGO_AUTH_TOKEN_URL must be HTTPS/);
    expect(fake.seen).toEqual([]);
  });

  it("names `bun dev` when a local API cannot be reached, exit 7", async () => {
    signIn(s.home);
    // No fake: WEGO_API_URL is a closed loopback port.
    const result = await s.run(["whoami"]);
    expect(result.code).toBe(7);
    expect(result.err).toMatch(
      /Cannot reach the Wego API at http:\/\/127\.0\.0\.1:9/,
    );
    expect(result.err).toMatch(/bun dev/);
  });
});

describe("what a refresh keeps", () => {
  it("stores the id_token a refresh returns", async () => {
    const issued = idTokenExpiringIn(3_600_000);
    signInExpired({ idToken: idTokenExpiringIn(-60_000) });
    s.fake({
      accept: [],
      routes: [route("user")],
      refresh: [{ access_token: "access-2", id_token: issued }],
    });
    expect((await s.run(["whoami"])).code).toBe(0);
    expect(stored()).toMatchObject({
      accessToken: "access-2",
      idToken: issued,
    });
  });

  it("keeps the stored id_token when a refresh returns none and it is still accepted", async () => {
    const kept = idTokenExpiringIn(-60_000);
    signInExpired({ idToken: kept });
    s.fake({
      accept: [],
      routes: [route("user")],
      refresh: [{ access_token: "access-2" }],
    });
    expect((await s.run(["whoami"])).code).toBe(0);
    expect(stored()).toMatchObject({ idToken: kept });
  });

  it("drops a stored id_token the API would no longer accept", async () => {
    signInExpired({ idToken: idTokenExpiringIn(-25 * 3_600_000) });
    s.fake({
      accept: [],
      routes: [route("user")],
      refresh: [{ access_token: "access-2" }],
    });
    expect((await s.run(["whoami"])).code).toBe(0);
    expect(stored().idToken).toBeUndefined();
  });

  it("keeps the refresh token when a reactive refresh does not rotate it", async () => {
    signIn(s.home, {
      accessToken: "access-revoked",
      refreshToken: "refresh-1",
    });
    s.fake({
      accept: [],
      routes: [route("user")],
      refresh: [{ access_token: "access-2" }],
    });
    expect((await s.run(["whoami"])).code).toBe(0);
    expect(stored()).toMatchObject({
      accessToken: "access-2",
      refreshToken: "refresh-1",
    });
  });

  it("explains an environment mismatch when a 401 survives a good refresh", async () => {
    signIn(s.home, {
      accessToken: "access-revoked",
      refreshToken: "refresh-1",
    });
    // The refreshed token is accepted by the fake, and the API still says 401:
    // a token minted for another environment than WEGO_API_URL.
    s.fake({
      accept: [],
      routes: [
        {
          op: "getCurrentUser",
          answers: [problem(401, "invalid_token", "Missing or invalid token")],
        },
      ],
      refresh: [{ access_token: "access-2" }],
    });
    const result = await s.run(["whoami"]);
    expect(result.code).toBe(3);
    expect(result.err).toMatch(/rejected your credentials \(401\)/);
    expect(result.err).toMatch(/WEGO_API_URL/);
    expect(result.err).toMatch(/wego login/);
  });
});

describe("a failed refresh leaves a trace", () => {
  it("prints the auth server's OAuth2 error and records it without the refresh token", async () => {
    signInExpired({ refreshToken: "refresh-secret" });
    s.fake({
      accept: [],
      refresh: [
        {
          status: 400,
          body: {
            error: "invalid_grant",
            error_description: "Token is expired",
          },
        },
      ],
    });
    const result = await s.run(["whoami"]);

    expect(result.code).toBe(3);
    expect(result.err).toMatch(/invalid_grant/);
    expect(result.err).toMatch(/Token is expired/);
    expect(result.err).toMatch(/wego login/);
    const text = readFileSync(failurePath(), "utf8");
    expect(JSON.parse(text)).toMatchObject({
      grantType: "refresh_token",
      status: 400,
      error: "invalid_grant",
      errorDescription: "Token is expired",
    });
    expect(JSON.parse(text).at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(text).not.toContain("refresh-secret");
  });

  it("records the failure on the reactive 401 path too", async () => {
    signIn(s.home, {
      accessToken: "access-revoked",
      refreshToken: "refresh-1",
    });
    s.fake({
      accept: [],
      refresh: [{ status: 400, body: { error: "invalid_grant" } }],
    });
    expect((await s.run(["whoami"])).code).toBe(3);
    expect(JSON.parse(readFileSync(failurePath(), "utf8"))).toMatchObject({
      grantType: "refresh_token",
      status: 400,
      error: "invalid_grant",
    });
  });

  it("redacts the refresh token if the auth server echoes it back", async () => {
    const secret = `1${"a".repeat(130)}`;
    signInExpired({ refreshToken: secret });
    s.fake({
      accept: [],
      refresh: [
        { status: 400, body: `upstream rejected refresh_token=${secret}` },
      ],
    });
    expect((await s.run(["whoami"])).code).toBe(3);
    const text = readFileSync(failurePath(), "utf8");
    expect(text).not.toContain(secret);
    expect(JSON.parse(text).bodySnippet).toContain("[REDACTED]");
  });

  it("still exits 3 and names login when the record cannot be written", async () => {
    signInExpired({});
    // A directory where the record goes: the write fails, the auth failure stands.
    mkdirSync(failurePath(), { recursive: true });
    s.fake({ accept: [], refresh: [{ status: 400, body: "nope" }] });
    const result = await s.run(["whoami"]);
    expect(result.code).toBe(3);
    expect(result.err).toMatch(/wego login/);
  });
});

describe("logout and the analytics session", () => {
  const sessionPath = () => join(s.home.configDir, "session.json");

  it("ends the analytics session, so the next user starts a new one", async () => {
    signIn(s.home);
    writeFileSync(sessionPath(), "{}\n");
    const result = await s.run(["logout"]);
    expect(result.code).toBe(0);
    expect(existsSync(sessionPath())).toBe(false);
  });

  it("still logs out, loudly, when the session cannot be cleared", async () => {
    signIn(s.home);
    // A non-empty directory cannot be removed by a plain `rm`.
    mkdirSync(join(sessionPath(), "stuck"), { recursive: true });
    const result = await s.run(["logout"]);
    expect(result.code).toBe(0);
    expect(existsSync(s.home.credentialsPath)).toBe(false);
    expect(result.err).toContain("could not clear the analytics session");
  });
});
