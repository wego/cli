import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApiHttpError,
  ApiUnreachableError,
  type BookingLinkParams,
  type CreateFlightSearchBody,
  createFlightSearch,
  type FeedbackBody,
  type FlightResultsQuery,
  fetchBookingLink,
  fetchFareOptions,
  fetchFlightResults,
  fetchFlightTrip,
  fetchHolidays,
  fetchNearbyPlaces,
  fetchPlaces,
  fetchSchedules,
  fetchSearchLink,
  fetchTripExperience,
  fetchVisaFree,
  fetchWhoami,
  type HttpFetch,
  NotFoundError,
  type PlacesQuery,
  type SearchLinkParams,
  sendFeedback,
  UnauthorizedError,
} from "./api";
import type { AuthFailureRecord } from "./auth-failure";
import {
  type FlightsDeps,
  feedback,
  flights,
  info,
  login,
  logout,
  parseFeedbackArgs,
  parseFlightResultsArgs,
  parseLoginArgs,
  places,
  resolveCliSite,
  whoami,
} from "./commands";
import type { CliConfig } from "./config";
import { type RunDeps, run } from "./index";
import { startLoopback } from "./loopback";
import { exchangeCode, refreshTokens } from "./oauth";
import type { UserSettings } from "./settings";
import { clearCredentials, loadCredentials, saveCredentials } from "./storage";
import { loadTestCliConfig } from "./test-config";

/**
 * Behavioral tests for the three commands. They run the REAL collaborators —
 * real loopback server, real PKCE, real token exchange, real on-disk credential
 * storage — and stub only at true boundaries: the auth server and the API are
 * local HTTP servers (network boundary), and the browser launch is captured
 * (OS boundary). Assertions are on what a user observes: exit code, printed
 * output, and the credentials actually written to disk. No first-party module
 * is mocked, and nothing asserts on internal call order.
 */

// --- local servers (network boundary) ------------------------------------
type Stub = { url: string; stop: () => void };
const running: Stub[] = [];

function serve(handler: (req: Request) => Response | Promise<Response>): Stub {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
  const stub = { url: `http://127.0.0.1:${s.port}`, stop: () => s.stop(true) };
  running.push(stub);
  return stub;
}

/** A fake authorization server: only the `/token` endpoint the CLI calls. */
function authServer(
  token: (grant: string) => Response | Promise<Response>,
): Stub {
  return serve(async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/token" && req.method === "POST") {
      const body = new URLSearchParams(await req.text());
      return token(body.get("grant_type") ?? "");
    }
    return new Response("not found", { status: 404 });
  });
}

/** A fake resource API: `GET /v1/user` accepts the given bearer token(s). */
/**
 * The api calls, injected (#1341).
 *
 * These describes used to drive hand-written `Bun.serve` stand-ins for `apps/api`
 * routes — a fake that can only fail when it disagrees with itself, which is the
 * defect #1328 exists to remove. The commands already take each api call as a dep,
 * so the deps are stubbed instead: no socket, and the token the CLI sent is visible
 * to an assertion rather than buried in a header the fake threw away.
 *
 * `accepted` keeps the fakes' most load-bearing behaviour: a token that is not
 * accepted raises `UnauthorizedError`, which is what `api.ts` raises on a 401, so the
 * reactive-refresh path still runs end to end against a real authorization server.
 */
const API = "https://api.wego.test";

/**
 * Api deps that refuse to be called.
 *
 * The default for every `runDeps` that takes stubs. Leaving the REAL api functions wired
 * as the default is a trap: a test that forgets to pass its stub reaches the network,
 * DNS-fails against the placeholder host, and exits 7 — which reads as a bug in the
 * command under test. Measured twice while writing these conversions. This makes the
 * mistake name itself instead.
 */
function refusingApi(): Record<string, () => never> {
  const names = [
    "createFlightSearch",
    "fetchFlightResults",
    "fetchFlightTrip",
    "fetchFareOptions",
    "fetchBookingLink",
    "fetchWhoami",
    "fetchPlaces",
    "sendFeedback",
  ];
  return Object.fromEntries(
    names.map((fn) => [
      fn,
      () => {
        throw new Error(
          `${fn} was called with no stub: pass one as runDeps' third argument`,
        );
      },
    ]),
  );
}

/** Raise what `api.ts` raises on a 401, unless the token is accepted. */
function guard(accepted: string[], token: string): void {
  if (!accepted.includes(token)) throw new UnauthorizedError();
}

function whoamiApi(accepted: string[], identity: unknown) {
  return async (_base: string, token: string) => {
    guard(accepted, token);
    return Promise.resolve(identity as Awaited<ReturnType<typeof fetchWhoami>>);
  };
}

/** `GET /v1/places`, recording the token and the query the CLI passed. */
function placesApi(
  accepted: string[],
  capture?: (call: { token: string; params: PlacesQuery }) => void,
) {
  return async (_base: string, token: string, params: PlacesQuery) => {
    capture?.({ token, params });
    guard(accepted, token);
    return Promise.resolve({
      results: [{ id: 1, name: "Dubai", type: "city" }],
      metadata: {
        resultCount: 1,
        totalCandidates: 1,
        hasMore: false,
        hasAmbiguity: false,
      },
    } as Awaited<ReturnType<typeof fetchPlaces>>);
  };
}

/** `POST /v1/feedback`, recording the body the CLI built. */
function feedbackApi(
  accepted: string[],
  capture?: (body: Record<string, unknown>) => void,
) {
  return async (_base: string, token: string, body: FeedbackBody) => {
    guard(accepted, token);
    capture?.(body as unknown as Record<string, unknown>);
    return Promise.resolve({ status: "received" as const });
  };
}

// --- per-test scratch dir + io --------------------------------------------
let dir: string;
let credPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wego-cmd-"));
  credPath = join(dir, "credentials.json");
});
afterEach(async () => {
  while (running.length) running.pop()?.stop();
  await rm(dir, { recursive: true, force: true });
});

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

function config(over: { as?: string; api?: string } = {}): CliConfig {
  const as = over.as ?? "http://127.0.0.1:1";
  return loadTestCliConfig({
    WEGO_CLI_CLIENT_ID: "cli-abc",
    WEGO_AUTH_AUTHORIZE_URL: `${as}/authorize`,
    WEGO_AUTH_TOKEN_URL: `${as}/token`,
    WEGO_API_URL: over.api ?? "http://127.0.0.1:1",
    WEGO_CREDENTIALS_PATH: credPath,
  });
}

const readStored = async () =>
  JSON.parse(await readFile(credPath, "utf8")) as Record<string, unknown>;

// A captured browser launch that completes the login: it parses the authorize
// URL the CLI would open and plays the AS's role — redirecting the browser to
// the loopback with a code + the matching state.
function browserThatRedirects(code = "auth-code-xyz") {
  return (authorizeUrl: string) => {
    const u = new URL(authorizeUrl);
    const redirectUri = u.searchParams.get("redirect_uri");
    const state = u.searchParams.get("state");
    void fetch(`${redirectUri}?code=${code}&state=${state}`).catch(() => {});
  };
}

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

describe("login", () => {
  it("logs in over real loopback PKCE and writes the issued tokens to disk", async () => {
    const as = authServer(() =>
      Response.json({
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 3600,
      }),
    );
    const io = sink();

    const code = await login(config({ as: as.url }), {
      ...io,
      startLoopback, // real loopback server
      openBrowser: browserThatRedirects(), // captured (OS boundary)
      exchangeCode, // real form POST to the fake AS
      saveCredentials, // real write to the temp file
    });

    expect(code).toBe(0);
    expect(await readStored()).toMatchObject({
      accessToken: "access-1",
      refreshToken: "refresh-1",
    });
    expect(io.err.join("")).toMatch(/Login successful/);
  });

  it("exits 2 (usage) with a message when the token exchange is rejected", async () => {
    const as = authServer(
      () => new Response("bad", { status: 400, statusText: "Bad Request" }),
    );
    const io = sink();

    const code = await login(config({ as: as.url }), {
      ...io,
      startLoopback,
      openBrowser: browserThatRedirects(),
      exchangeCode,
      saveCredentials,
    });

    expect(code).toBe(2); // usage/config error (rejected token exchange)
    expect(io.err.join("")).toMatch(/Login failed/);
  });

  it("classifies a network failure from the token exchange as exit 7 (timeout/network), not usage", async () => {
    const io = sink();

    const code = await login(config(), {
      ...io,
      startLoopback, // real loopback delivers the code
      openBrowser: browserThatRedirects(),
      // The token POST never reaches the AS: Bun's fetch rejects with a
      // TypeError on a DNS/connect failure (a DOMException on the deadline).
      // The login catch must route this through the taxonomy so it reports the
      // network class, not masquerade as a usage error.
      exchangeCode: () => Promise.reject(new TypeError("Unable to connect")),
      saveCredentials,
    });

    expect(code).toBe(7); // EXIT.TIMEOUT – network/timeout, not usage(2)
    expect(io.err.join("")).toMatch(/Login failed/);
  });

  it("reports a failure (exit 2 usage) when the loopback port is already in use", async () => {
    const occupied = serve(() => new Response("busy")); // holds an ephemeral port
    const port = new URL(occupied.url).port;
    const io = sink();

    const cfg = loadTestCliConfig({
      WEGO_CLI_CLIENT_ID: "cli-abc",
      WEGO_CREDENTIALS_PATH: credPath,
      WEGO_CLI_REDIRECT_PORT: port, // force startLoopback to bind a taken port
    });
    const code = await login(cfg, {
      ...io,
      startLoopback, // real → throws EADDRINUSE binding the taken port
      openBrowser: browserThatRedirects(),
      exchangeCode,
      saveCredentials,
    });

    expect(code).toBe(2); // usage/config error (occupied redirect port)
    expect(io.err.join("")).toMatch(/Login failed/);
  });

  it("refuses a plaintext (non-localhost) token endpoint", async () => {
    const io = sink();
    const cfg = loadTestCliConfig({
      WEGO_CLI_CLIENT_ID: "cli-abc",
      WEGO_CREDENTIALS_PATH: credPath,
      WEGO_AUTH_AUTHORIZE_URL: "http://auth.evil.com/authorize",
      WEGO_AUTH_TOKEN_URL: "http://auth.evil.com/token",
    });
    const code = await login(cfg, {
      ...io,
      startLoopback,
      openBrowser: browserThatRedirects(),
      exchangeCode,
      saveCredentials,
    });
    expect(code).toBe(2); // usage/config error (insecure AS endpoint)
    expect(io.err.join("")).toMatch(/must be HTTPS/);
  });

  // The SSH case: the loopback binds 127.0.0.1 on the remote box, but the
  // browser runs on the laptop, so the redirect never reaches this process.
  // The user pastes the callback URL back instead.
  it("completes from a pasted callback URL and opens no browser with --no-browser", async () => {
    const as = authServer(() =>
      Response.json({ access_token: "access-ssh", expires_in: 3600 }),
    );
    const io = sink();
    let opened = 0;
    let cancelled = 0;
    let pastedState: string | undefined;

    const code = await login(
      config({ as: as.url }),
      {
        ...io,
        startLoopback,
        openBrowser: () => {
          opened += 1;
        },
        exchangeCode,
        saveCredentials,
        waitForPastedCallback: (state) => {
          pastedState = state;
          return {
            armed: true,
            promise: Promise.resolve("pasted-code"),
            cancel: () => {
              cancelled += 1;
            },
          };
        },
      },
      ["--no-browser"],
    );

    expect(code).toBe(0);
    expect(opened).toBe(0); // no browser on this machine
    expect(cancelled).toBe(1); // the waiter is torn down
    expect(await readStored()).toMatchObject({ accessToken: "access-ssh" });
    // The paste waiter is armed with the same CSRF state the authorize URL
    // carries — a foreign redirect cannot finish someone else's login.
    expect(pastedState).toMatch(/.+/);
    expect(io.err.join("")).toMatch(/paste it below/);
  });

  it("skips the browser automatically inside an SSH session", async () => {
    const as = authServer(() => Response.json({ access_token: "access-ssh2" }));
    const io = sink();
    let opened = 0;

    const code = await login(config({ as: as.url }), {
      ...io,
      startLoopback,
      openBrowser: () => {
        opened += 1;
      },
      exchangeCode,
      saveCredentials,
      isRemoteShell: () => true,
      waitForPastedCallback: () => ({
        armed: true,
        promise: Promise.resolve("pasted-code"),
        cancel: () => {},
      }),
    });

    expect(code).toBe(0);
    expect(opened).toBe(0);
    expect(io.err.join("")).toMatch(/No browser on this machine/);
  });

  it("still finishes over the loopback when the paste waiter is armed but idle", async () => {
    const as = authServer(() => Response.json({ access_token: "access-lb" }));
    const io = sink();
    let cancelled = 0;

    const code = await login(config({ as: as.url }), {
      ...io,
      startLoopback,
      openBrowser: browserThatRedirects(),
      exchangeCode,
      saveCredentials,
      // Nobody pastes anything — the loopback must win the race unaided.
      waitForPastedCallback: () => ({
        armed: true,
        promise: new Promise<string>(() => {}),
        cancel: () => {
          cancelled += 1;
        },
      }),
    });

    expect(code).toBe(0);
    expect(cancelled).toBe(1);
    expect(await readStored()).toMatchObject({ accessToken: "access-lb" });
  });

  it("promises no paste prompt to a non-TTY caller (an agent shelling out)", async () => {
    const as = authServer(() => Response.json({ access_token: "access-tty" }));
    const io = sink();
    // Nothing opens a browser here, so play the forwarded-port case: the user
    // opens the printed URL elsewhere and the redirect reaches the loopback.
    const redirect = browserThatRedirects();
    const error = (message: string) => {
      io.error(message);
      const url = message.match(/\bhttps?:\/\/\S*authorize\S*/)?.[0];
      if (url) redirect(url);
    };

    const code = await login(
      config({ as: as.url }),
      {
        ...io,
        error,
        openBrowser: () => {
          throw new Error("--no-browser must not open a browser");
        },
        startLoopback,
        exchangeCode,
        saveCredentials,
        // What `waitForPastedCallback` returns without a TTY: nobody to ask.
        waitForPastedCallback: () => ({
          armed: false,
          promise: new Promise<string>(() => {}),
          cancel: () => {},
        }),
      },
      ["--no-browser"],
    );

    expect(code).toBe(0); // the loopback still completed it
    const out = io.err.join("");
    expect(out).not.toMatch(/paste it below/);
    expect(out).toMatch(/ssh -L/);
  });

  it("opens the browser anyway with --browser inside an SSH session (X11)", async () => {
    const as = authServer(() => Response.json({ access_token: "access-x11" }));
    const io = sink();
    let opened = 0;
    const redirect = browserThatRedirects();

    const code = await login(
      config({ as: as.url }),
      {
        ...io,
        startLoopback,
        openBrowser: (url) => {
          opened += 1;
          redirect(url);
        },
        exchangeCode,
        saveCredentials,
        isRemoteShell: () => true, // detection says remote; the flag overrules it
      },
      ["--browser"],
    );

    expect(code).toBe(0);
    expect(opened).toBe(1);
    expect(io.err.join("")).toMatch(/Opening your browser/);
  });

  it("exits 2 (usage) when both browser flags are given", async () => {
    const io = sink();
    const code = await login(
      config(),
      {
        ...io,
        startLoopback,
        openBrowser: browserThatRedirects(),
        exchangeCode,
        saveCredentials,
      },
      ["--browser", "--no-browser"],
    );

    expect(code).toBe(2);
    expect(io.err.join("")).toMatch(/not both/);
  });

  // The race's loser keeps running after the winner settles. `login` must not
  // care what it eventually does — the same bug class the loopback deadline fix
  // covers one layer down, asserted here at the command level.
  it("ignores a race loser that settles late, whichever side lost", async () => {
    const as = authServer(() => Response.json({ access_token: "access-race" }));

    // 1. The paste wins; the loopback's waiter rejects afterwards.
    const io1 = sink();
    let lateReject: ((e: Error) => void) | undefined;
    const code1 = await login(
      config({ as: as.url }),
      {
        ...io1,
        startLoopback: (path, port) => {
          const real = startLoopback(path, port);
          return {
            ...real,
            waitForCode: () =>
              new Promise<string>((_, reject) => {
                lateReject = reject;
              }),
          };
        },
        openBrowser: () => {},
        exchangeCode,
        saveCredentials,
        waitForPastedCallback: () => ({
          armed: true,
          promise: Promise.resolve("pasted-wins"),
          cancel: () => {},
        }),
      },
      ["--no-browser"],
    );
    expect(code1).toBe(0);
    // The loser rejecting now must not surface as an unhandled rejection nor
    // change the already-returned exit code.
    lateReject?.(new Error("login timed out"));
    await Bun.sleep(10);
    expect(code1).toBe(0);
    expect(await readStored()).toMatchObject({ accessToken: "access-race" });

    // 2. The loopback wins; the paste reader rejects afterwards.
    const io2 = sink();
    let latePasteReject: ((e: Error) => void) | undefined;
    const code2 = await login(config({ as: as.url }), {
      ...io2,
      startLoopback,
      openBrowser: browserThatRedirects("loopback-wins"),
      exchangeCode,
      saveCredentials,
      waitForPastedCallback: () => ({
        armed: true,
        promise: new Promise<string>((_, reject) => {
          latePasteReject = reject;
        }),
        cancel: () => {},
      }),
    });
    expect(code2).toBe(0);
    latePasteReject?.(new Error("paste failed after the fact"));
    await Bun.sleep(10);
    expect(io2.err.join("")).toMatch(/Login successful/);
  });

  it("exits 2 (usage) on an unknown login option", async () => {
    const io = sink();
    const code = await login(
      config(),
      {
        ...io,
        startLoopback,
        openBrowser: browserThatRedirects(),
        exchangeCode,
        saveCredentials,
      },
      ["--nobrowser"],
    );

    expect(code).toBe(2);
    expect(io.err.join("")).toMatch(/Unknown option: --nobrowser/);
  });

  it("fails fast with a B1-referencing message when no client_id is set", () => {
    expect(() =>
      loadTestCliConfig({
        WEGO_CLI_CLIENT_ID: "",
        WEGO_CREDENTIALS_PATH: credPath,
      }),
    ).toThrow(/WEGO_CLI_CLIENT_ID/);
  });
});

describe("whoami", () => {
  const deps = (
    io: ReturnType<typeof sink>,
    api: ReturnType<typeof whoamiApi>,
  ) => ({
    ...io,
    loadCredentials,
    saveCredentials,
    refreshTokens,
    loadSettings: async () => ({}),
    recordAuthFailure: async () => {},
    fetchWhoami: api,
  });

  it("prints the caller's identity for a valid session", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    const api = whoamiApi(["tok-1"], { sub: "user-1", email: "a@wego.com" });
    const io = sink();

    const code = await whoami(config({ api: API }), deps(io, api));

    expect(code).toBe(0);
    expect(io.out.join("")).toContain('"sub": "user-1"');
  });

  it("works despite a malformed WEGO_CLI_REDIRECT_PORT (a login-only setting)", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    const api = whoamiApi(["tok-1"], { sub: "user-1" });
    const cfg = loadTestCliConfig({
      WEGO_CLI_CLIENT_ID: "cli-abc",
      WEGO_CREDENTIALS_PATH: credPath,
      WEGO_API_URL: API,
      WEGO_CLI_REDIRECT_PORT: "abc", // malformed, but whoami never touches the loopback
    });
    const io = sink();

    const code = await whoami(cfg, deps(io, api));

    expect(code).toBe(0);
    expect(io.out.join("")).toContain('"sub": "user-1"');
  });

  it("refuses a plaintext (non-localhost) WEGO_API_URL", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    const cfg = loadTestCliConfig({
      WEGO_CLI_CLIENT_ID: "cli-abc",
      WEGO_CREDENTIALS_PATH: credPath,
      WEGO_API_URL: "http://api.wego.com", // plaintext to a remote host
    });
    const io = sink();
    const code = await whoami(cfg, deps(io, whoamiApi([], {})));
    expect(code).toBe(2); // usage/config error (insecure API URL)
    expect(io.err.join("")).toMatch(/WEGO_API_URL must be HTTPS/);
  });

  it("refuses to refresh an expired token over a plaintext token endpoint", async () => {
    await saveCredentials(credPath, {
      accessToken: "old",
      refreshToken: "rt",
      expiresAt: Date.now() - 10_000, // expired → triggers the refresh path
    });
    const api = whoamiApi(["new"], { sub: "user-1" });
    const cfg = loadTestCliConfig({
      WEGO_CLI_CLIENT_ID: "cli-abc",
      WEGO_CREDENTIALS_PATH: credPath,
      WEGO_API_URL: API, // local API is fine
      WEGO_AUTH_TOKEN_URL: "http://auth.wego.com/token", // plaintext → refresh refused
    });
    const io = sink();
    const code = await whoami(cfg, deps(io, api));
    expect(code).toBe(3); // auth failure (couldn't refresh the expired token)
    expect(io.err.join("")).toMatch(/WEGO_AUTH_TOKEN_URL must be HTTPS/);
  });

  it("tells an unauthenticated user to log in", async () => {
    const io = sink();
    // No credentials file, so the api must never be reached.
    const code = await whoami(config(), deps(io, whoamiApi([], {})));
    expect(code).toBe(3); // auth: not logged in
    expect(io.err.join("")).toMatch(/wego login/);
  });

  it("transparently refreshes an expired token, then prints identity and persists the rotation", async () => {
    await saveCredentials(credPath, {
      accessToken: "old",
      refreshToken: "rt",
      expiresAt: Date.now() - 10_000, // already expired
    });
    const as = authServer(() =>
      Response.json({ access_token: "new", refresh_token: "rt2" }),
    );
    const api = whoamiApi(["new"], { sub: "user-1" });
    const io = sink();

    const code = await whoami(config({ as: as.url, api: API }), deps(io, api));

    expect(code).toBe(0);
    expect(io.out.join("")).toContain('"sub": "user-1"');
    expect(await readStored()).toMatchObject({
      accessToken: "new",
      refreshToken: "rt2",
    });
  });

  it("persists the id_token a refresh returns", async () => {
    await saveCredentials(credPath, {
      accessToken: "old",
      refreshToken: "rt",
      expiresAt: Date.now() - 10_000,
      idToken: "old-id",
    });
    const as = authServer(() =>
      Response.json({ access_token: "new", id_token: "new-id" }),
    );
    const io = sink();

    const code = await whoami(
      config({ as: as.url, api: API }),
      deps(io, whoamiApi(["new"], { sub: "user-1" })),
    );

    expect(code).toBe(0);
    expect(await readStored()).toMatchObject({ idToken: "new-id" });
  });

  it("keeps the stored id_token when a refresh returns none, since the hashes outlive it", async () => {
    const kept = idTokenExpiring(Date.now() - 60_000); // expired, still accepted
    await saveCredentials(credPath, {
      accessToken: "old",
      refreshToken: "rt",
      expiresAt: Date.now() - 10_000,
      idToken: kept,
    });
    const as = authServer(() => Response.json({ access_token: "new" }));
    const io = sink();

    const code = await whoami(
      config({ as: as.url, api: API }),
      deps(io, whoamiApi(["new"], { sub: "user-1" })),
    );

    expect(code).toBe(0);
    expect(await readStored()).toMatchObject({ idToken: kept });
  });

  it("drops a stored id_token the API would no longer accept", async () => {
    await saveCredentials(credPath, {
      accessToken: "old",
      refreshToken: "rt",
      expiresAt: Date.now() - 10_000,
      idToken: idTokenExpiring(Date.now() - 25 * 60 * 60 * 1000),
    });
    const as = authServer(() => Response.json({ access_token: "new" }));
    const io = sink();

    const code = await whoami(
      config({ as: as.url, api: API }),
      deps(io, whoamiApi(["new"], { sub: "user-1" })),
    );

    expect(code).toBe(0);
    expect((await readStored())?.idToken).toBeUndefined();
  });

  it("recovers from a 401 by refreshing once and retrying", async () => {
    await saveCredentials(credPath, {
      accessToken: "stale",
      refreshToken: "rt",
    }); // no expiresAt → not refreshed proactively; the 401 drives it
    const as = authServer(() => Response.json({ access_token: "fresh" }));
    const api = whoamiApi(["fresh"], { sub: "user-1" }); // "stale" → 401
    const io = sink();

    const code = await whoami(config({ as: as.url, api: API }), deps(io, api));

    expect(code).toBe(0);
    expect(io.out.join("")).toContain('"sub": "user-1"');
    // The AS omitted refresh_token on the reactive refresh, so the on-disk
    // refresh token must be PRESERVED (the `?? refreshToken` branch) while the
    // access token rotates — dropping it would silently lose the credential.
    // Assert the persisted file, not just the printed identity.
    expect(await readStored()).toMatchObject({
      accessToken: "fresh",
      refreshToken: "rt",
    });
  });

  it("exits 3 (auth) and points to login when the refresh token is rejected", async () => {
    await saveCredentials(credPath, {
      accessToken: "old",
      refreshToken: "rt",
      expiresAt: Date.now() - 10_000,
    });
    const as = authServer(
      () => new Response("bad", { status: 400, statusText: "Bad Request" }),
    );
    const api = whoamiApi([], {});
    const io = sink();

    const code = await whoami(config({ as: as.url, api: API }), deps(io, api));

    expect(code).toBe(3); // auth: refresh token rejected → re-login
    expect(io.err.join("")).toMatch(/wego login/);
  });

  it("surfaces the auth server's OAuth2 error and records the failure locally (issue #1367)", async () => {
    await saveCredentials(credPath, {
      accessToken: "old",
      refreshToken: "rt",
      expiresAt: Date.now() - 10_000, // expired → proactive refresh path
    });
    const as = authServer(() =>
      Response.json(
        { error: "invalid_grant", error_description: "Token is expired" },
        { status: 400, statusText: "Bad Request" },
      ),
    );
    const io = sink();
    let recorded: AuthFailureRecord | undefined;
    const code = await whoami(config({ as: as.url, api: API }), {
      ...deps(io, whoamiApi([], {})),
      recordAuthFailure: async (r) => {
        recorded = r;
      },
    });

    expect(code).toBe(3); // still an auth failure, fail-closed
    // The OAuth2 error now rides the stderr line, not just a bare status.
    const msg = io.err.join("");
    expect(msg).toMatch(/invalid_grant/);
    expect(msg).toMatch(/Token is expired/);
    expect(msg).toMatch(/wego login/);
    // …and a trace of WHY is left on disk (the whole point of #1360's fix).
    expect(recorded).toMatchObject({
      grantType: "refresh_token",
      status: 400,
      error: "invalid_grant",
      errorDescription: "Token is expired",
    });
    expect(recorded?.at).toMatch(/^\d{4}-\d\d-\d\dT/); // ISO-8601 instant
    // The refresh token must NEVER be captured in the diagnostics record.
    expect(JSON.stringify(recorded)).not.toContain("rt");
  });

  it("still exits 3 and prints when the failure record write itself fails", async () => {
    await saveCredentials(credPath, {
      accessToken: "old",
      refreshToken: "rt",
      expiresAt: Date.now() - 10_000,
    });
    const as = authServer(
      () => new Response("nope", { status: 400, statusText: "Bad Request" }),
    );
    const io = sink();
    const code = await whoami(config({ as: as.url, api: API }), {
      ...deps(io, whoamiApi([], {})),
      // A diagnostics write that throws must not mask the auth failure.
      recordAuthFailure: async () => {
        throw new Error("disk full");
      },
    });
    expect(code).toBe(3);
    expect(io.err.join("")).toMatch(/wego login/);
  });

  it("records the failure on the reactive-401 path too, not only proactive (issue #1367)", async () => {
    // No expiresAt → the token is not refreshed proactively; the first API call
    // 401s WITH a refresh token in hand, driving reactiveRefreshRetry, and THEN
    // the refresh itself fails. This is the second call site reportRefreshFailure
    // fires from — untested until now.
    await saveCredentials(credPath, {
      accessToken: "stale",
      refreshToken: "rt",
    });
    const as = authServer(() =>
      Response.json(
        { error: "invalid_grant" },
        { status: 400, statusText: "Bad Request" },
      ),
    );
    const api = whoamiApi([], {}); // "stale" → 401 → reactive refresh → fails
    const io = sink();
    let recorded: AuthFailureRecord | undefined;
    const code = await whoami(config({ as: as.url, api: API }), {
      ...deps(io, api),
      recordAuthFailure: async (r) => {
        recorded = r;
      },
    });
    expect(code).toBe(3);
    expect(recorded).toMatchObject({
      grantType: "refresh_token",
      status: 400,
      error: "invalid_grant",
    });
  });

  it("redacts the sent refresh token from the record if the AS echoes it back (issue #1367)", async () => {
    // Defense in depth: if the auth server ever reflects the request body into a
    // non-OAuth2 error page, the 365-day refresh token must not land on disk.
    const rt = `1${"a".repeat(130)}`; // realistic opaque token length
    await saveCredentials(credPath, {
      accessToken: "old",
      refreshToken: rt,
      expiresAt: Date.now() - 10_000,
    });
    const as = authServer(
      () =>
        new Response(`upstream rejected refresh_token=${rt}`, {
          status: 400,
          statusText: "Bad Request",
        }),
    );
    const io = sink();
    let recorded: AuthFailureRecord | undefined;
    const code = await whoami(config({ as: as.url, api: API }), {
      ...deps(io, whoamiApi([], {})),
      recordAuthFailure: async (r) => {
        recorded = r;
      },
    });
    expect(code).toBe(3);
    expect(JSON.stringify(recorded)).not.toContain(rt);
    expect(recorded?.bodySnippet).toContain("[REDACTED]");
  });

  it("exits 3 (auth) on a persistent 401 with no refresh token", async () => {
    await saveCredentials(credPath, { accessToken: "stale" });
    const api = whoamiApi([], {}); // always 401
    const io = sink();

    const code = await whoami(config({ api: API }), deps(io, api));

    expect(code).toBe(3); // auth: persistent 401, no refresh token
    expect(io.err.join("")).toBeTruthy();
  });

  it("explains an env mismatch when a 401 survives a successful refresh (not a bare 'run login')", async () => {
    await saveCredentials(credPath, {
      accessToken: "stale",
      refreshToken: "rt",
    });
    // The refresh succeeds (AS mints a fresh token)…
    const as = authServer(() => Response.json({ access_token: "fresh" }));
    // …but the API rejects EVERY token (e.g. token minted for a different
    // environment than WEGO_API_URL) — so the retried call still 401s.
    const api = whoamiApi([], {});
    const io = sink();

    const code = await whoami(config({ as: as.url, api: API }), deps(io, api));

    expect(code).toBe(3); // auth: a persistent 401 is the AUTH class
    const msg = io.err.join("");
    expect(msg).toMatch(/rejected your credentials \(401\)/);
    expect(msg).toMatch(/WEGO_API_URL/);
    expect(msg).toMatch(/wego login/); // still offers re-login as the fallback
  });

  it("gives a 'bun dev' hint when a local api target is unreachable", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    const io = sink();

    // Valid credentials, and the api call fails the way `api.ts` reports an
    // unreachable host: a typed `ApiUnreachableError`, which is what the command
    // layer classifies. Reaching a dead port to produce it would test Bun's socket
    // timeouts, not the CLI.
    const unreachable = (() => {
      throw new ApiUnreachableError("http://127.0.0.1:1", new Error("refused"));
    }) as ReturnType<typeof whoamiApi>;
    const code = await whoami(
      config({ api: "http://127.0.0.1:1" }),
      deps(io, unreachable),
    );

    expect(code).toBe(7); // timeout/network: unreachable host is the network class
    const msg = io.err.join("");
    expect(msg).toMatch(/Cannot reach the Wego API at http:\/\/127\.0\.0\.1:1/);
    expect(msg).toMatch(/bun dev/);
  });
});

// The `places` command is exercised through the REAL CLI entry point `run(argv,
// deps)`, stubbing only external seams — the network (local auth + API servers)
// and credential storage (a temp file via config). Every assertion is on what a
// user observes: exit code, printed output, the request the API received, and
// the credentials on disk — never on the arg parser or a command's dependency
// shape. That keeps these tests valid across an internals migration (e.g. moving
// the hand-rolled parser to commander.js): only `runDeps` below knows the wiring.
describe("places (through run – the argv entry point)", () => {
  const runDeps = (
    io: ReturnType<typeof sink>,
    cfg: CliConfig,
    api: ReturnType<typeof placesApi> = placesApi([]),
  ): RunDeps => {
    const cmdIo = { log: io.log, error: io.error };
    return {
      loadConfig: () => cfg,
      io: cmdIo,
      login: () => {
        throw new Error("login is not exercised by the places tests");
      },
      info: () => {
        throw new Error("info is not exercised by the places tests");
      },
      whoami: (c) =>
        whoami(c, {
          ...cmdIo,
          loadCredentials,
          saveCredentials,
          refreshTokens,
          loadSettings: async () => ({}),
          recordAuthFailure: async () => {},
          fetchWhoami,
        }),
      places: (c, args) =>
        places(c, args, {
          ...cmdIo,
          loadCredentials,
          saveCredentials,
          refreshTokens,
          loadSettings: async () => ({}),
          recordAuthFailure: async () => {},
          fetchPlaces: api,
        }),
      flights: () => {
        throw new Error("flights is not exercised by the places tests");
      },
      hotels: () => {
        throw new Error("hotels is not exercised by the places tests");
      },
      feedback: () => {
        throw new Error("feedback is not exercised by the places tests");
      },
      skill: () => {
        throw new Error("skill is not exercised by the places tests");
      },
      update: () => {
        throw new Error("update is not exercised by the places tests");
      },
      uninstall: () => {
        throw new Error("uninstall is not exercised by the places tests");
      },
      config: () => {
        throw new Error("config is not exercised by the places tests");
      },
      telemetry: () => {
        throw new Error("telemetry is not exercised by the places tests");
      },
      sendTelemetry: () => {
        throw new Error("sendTelemetry is not exercised by the places tests");
      },
      logout: (c) =>
        logout(c, { ...cmdIo, clearCredentials, clearSession: async () => {} }),
    };
  };

  // `run` reads argv[2] as the command and argv.slice(3) as its args.
  const wego = (...args: string[]) => ["bun", "wego", ...args];

  // CLI-3: `wego places --help` used to error with "Unknown option: --help"
  // (exit 2). It now prints the scoped places usage on stdout with exit 0, like
  // the flights/hotels leaves — no network call, no credentials read.
  for (const help of ["--help", "-h", "help"]) {
    it(`places ${help}: prints usage to stdout, exit 0, empty stderr`, async () => {
      const io = sink();
      const code = await run(
        wego("places", help),
        runDeps(io, config({ api: "http://127.0.0.1:1" })),
      );
      expect(code).toBe(0);
      expect(io.out.join("\n")).toContain('Usage: wego places "<query>"');
      expect(io.err.length).toBe(0);
    });
  }

  it("prints places JSON and sends the bearer token + query params", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    let seen: { token: string; params: PlacesQuery } | undefined;
    const api = placesApi(["tok-1"], (call) => {
      seen = call;
    });
    const io = sink();

    const code = await run(
      wego("places", "dubai", "--locale", "en", "--page-size", "5"),
      runDeps(io, config({ api: API }), api),
    );

    expect(code).toBe(0);
    expect(io.out.join("")).toContain('"resultCount": 1');
    expect(seen?.token).toBe("tok-1");
    expect(seen?.params.query).toBe("dubai");
    expect(seen?.params.locale).toBe("en");
    expect(seen?.params.pageSize).toBe(5);
  });

  it("forwards flags in --flag value and --flag=value forms, including comma-split + repeated --types", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    let seen: { token: string; params: PlacesQuery } | undefined;
    const api = placesApi(["tok-1"], (call) => {
      seen = call;
    });
    const io = sink();

    const code = await run(
      wego(
        "places",
        "paris",
        "--types",
        "city,airport",
        "--types=hotel",
        "--locale=en",
        "--page",
        "2",
        "--page-size=5",
      ),
      runDeps(io, config({ api: API }), api),
    );

    expect(code).toBe(0);
    // Comma-split and repeated --types both accumulate; the API client emits
    // repeated `types` query params.
    expect(seen?.params.types).toEqual(["city", "airport", "hotel"]);
    expect(seen?.params.query).toBe("paris");
    expect(seen?.params.locale).toBe("en");
    expect(seen?.params.page).toBe(2);
    expect(seen?.params.pageSize).toBe(5);
  });

  it("accepts values at the cap boundary (page=100, page-size=50)", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    let seen: { token: string; params: PlacesQuery } | undefined;
    const api = placesApi(["tok-1"], (call) => {
      seen = call;
    });
    const io = sink();

    const code = await run(
      wego("places", "dubai", "--page", "100", "--page-size", "50"),
      runDeps(io, config({ api: API }), api),
    );

    expect(code).toBe(0);
    expect(seen?.params.page).toBe(100);
    expect(seen?.params.pageSize).toBe(50);
  });

  it("rejects malformed / out-of-range / missing-value flags with exit 2 (usage) and a helpful message, before any network", async () => {
    // Bad input is rejected before credentials or the network are touched
    // (config points nowhere reachable). Asserted at the observable layer —
    // exit code + stderr — not on a parser's return value.
    const cases: Array<[string[], RegExp]> = [
      [["places"], /Usage: wego places/],
      [["places", "dubai", "--page", "x"], /--page must be a positive integer/],
      [
        ["places", "dubai", "--page", "0x10"],
        /--page must be a positive integer/,
      ],
      [
        ["places", "dubai", "--page", "1e3"],
        /--page must be a positive integer/,
      ],
      [["places", "dubai", "--page", "0"], /--page must be a positive integer/],
      [
        ["places", "dubai", "--page", "1.5"],
        /--page must be a positive integer/,
      ],
      [
        ["places", "dubai", "--page", "-1"],
        /--page must be a positive integer/,
      ],
      [
        ["places", "dubai", "--page", " 5"],
        /--page must be a positive integer/,
      ],
      [
        ["places", "dubai", "--page", "101"],
        /--page must be between 1 and 100/,
      ],
      [
        ["places", "dubai", "--page-size", "100"],
        /--page-size must be between 1 and 50/,
      ],
      [["places", "dubai", "--nope"], /Unknown option/],
      [["places", "dubai", "--locale"], /--locale requires a value/],
      [
        ["places", "dubai", "--locale", "--page", "2"],
        /--locale requires a value/,
      ],
      [["places", "dubai", "--locale="], /--locale requires a value/],
      [["places", "dubai", "--types="], /--types requires a value/],
    ];
    for (const [args, msg] of cases) {
      const io = sink();
      const code = await run(wego(...args), runDeps(io, config()));
      expect(code).toBe(2); // usage error
      expect(io.err.join("")).toMatch(msg);
    }
  });

  it("tells an unauthenticated user to log in", async () => {
    const io = sink();
    const code = await run(wego("places", "dubai"), runDeps(io, config())); // no creds
    expect(code).toBe(3); // auth: not logged in
    expect(io.err.join("")).toMatch(/wego login/);
  });

  it("recovers from a 401 by refreshing once and retrying", async () => {
    await saveCredentials(credPath, {
      accessToken: "stale",
      refreshToken: "rt",
    });
    const as = authServer(() => Response.json({ access_token: "fresh" }));
    const api = placesApi(["fresh"]); // "stale" → 401, drives the refresh
    const io = sink();

    const code = await run(
      wego("places", "dubai"),
      runDeps(io, config({ as: as.url, api: API }), api),
    );

    expect(code).toBe(0);
    expect(io.out.join("")).toContain('"resultCount": 1');
  });

  it("proactively refreshes an expired token before calling, then persists the rotation", async () => {
    // An already-expired access token must be refreshed BEFORE the request (not
    // via a reactive 401): the API only accepts the fresh token, and the rotated
    // pair is written back to disk. Confirms `places` wires the same
    // withAccessToken flow whoami does.
    await saveCredentials(credPath, {
      accessToken: "old",
      refreshToken: "rt",
      expiresAt: Date.now() - 10_000, // already expired
    });
    const as = authServer(() =>
      Response.json({ access_token: "new", refresh_token: "rt2" }),
    );
    const api = placesApi(["new"]); // only the fresh token is accepted
    const io = sink();

    const code = await run(
      wego("places", "dubai"),
      runDeps(io, config({ as: as.url, api: API }), api),
    );

    expect(code).toBe(0);
    expect(io.out.join("")).toContain('"resultCount": 1');
    expect(await readStored()).toMatchObject({
      accessToken: "new",
      refreshToken: "rt2",
    });
  });
});

describe("places – stored preferences (issue #1386)", () => {
  const placesDeps = (
    io: ReturnType<typeof sink>,
    settings: UserSettings,
    api: ReturnType<typeof placesApi>,
  ) => ({
    log: io.log,
    error: io.error,
    loadCredentials,
    saveCredentials,
    refreshTokens,
    loadSettings: async () => settings,
    recordAuthFailure: async () => {},
    fetchPlaces: api,
  });

  it("inherits the stored locale, and NEVER the stored market", async () => {
    // Carve-out: `apps/api` pins the upstream `site_code` to the wildcard on
    // purpose, so place resolution stays market-neutral. roxana (the web client)
    // does the opposite for its market-scoped UI — threading a market here would
    // narrow every lookup, so the CLI must not send one. The params the call
    // receives say it exactly, and no price is returned so no currency is sent.
    await saveCredentials(credPath, { accessToken: "tok-1" });
    let seen: PlacesQuery | undefined;
    const api = placesApi(["tok-1"], ({ params }) => {
      seen = params;
    });
    const code = await places(
      config({ api: API }),
      ["dubai"],
      placesDeps(sink(), { locale: "ar", site: "SA", currency: "SAR" }, api),
    );
    expect(code).toBe(0);
    expect(seen).toEqual({ query: "dubai", locale: "ar" });
  });

  it("an explicit --locale still wins", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    let seen: PlacesQuery | undefined;
    const api = placesApi(["tok-1"], ({ params }) => {
      seen = params;
    });
    const code = await places(
      config({ api: API }),
      ["dubai", "--locale", "en"],
      placesDeps(sink(), { locale: "ar" }, api),
    );
    expect(code).toBe(0);
    expect(seen?.locale).toBe("en");
  });
});

describe("logout", () => {
  it("removes the stored credentials from disk", async () => {
    await saveCredentials(credPath, { accessToken: "at" });
    const io = sink();

    const code = await logout(config(), {
      ...io,
      clearCredentials,
      clearSession: async () => {},
    });

    expect(code).toBe(0);
    expect(await loadCredentials(credPath)).toBeNull();
  });

  it("ends the analytics session too, so the next user starts a new one", async () => {
    await saveCredentials(credPath, { accessToken: "at" });
    let cleared = false;

    await logout(config(), {
      ...sink(),
      clearCredentials,
      clearSession: async () => {
        cleared = true;
      },
    });

    expect(cleared).toBe(true);
  });

  it("still succeeds, loudly, when the session file cannot be cleared", async () => {
    await saveCredentials(credPath, { accessToken: "at" });
    const io = sink();

    const code = await logout(config(), {
      ...io,
      clearCredentials,
      clearSession: async () => {
        throw new Error("EPERM");
      },
    });

    expect(code).toBe(0);
    expect(await loadCredentials(credPath)).toBeNull();
    expect(io.err.join("\n")).toContain(
      "could not clear the analytics session",
    );
    expect(io.err.join("\n")).toContain("EPERM");
  });
});

// --- flights (through run — the argv entry point) ---------------------------
const SEARCH_ID = "s1msr";
const TRIP_ID = "s1msr:TR610~10";

/**
 * What every priced read's `metadata` carries since contract 0.6.0 (#1522): the
 * currency and locale the read asked for, each beside the API's own
 * request-scoped source.
 *
 * `explicit` here means only "the request carried the param", which is true of a
 * currency the CLI took from `settings.json` — the reason the CLI publishes its
 * own top-level label (#1529). Both `*Source` copies are what the CLI strips at
 * print time (#1400 for `localeSource`, #1534 for the rest): CLI output
 * publishes exactly one `*Source` per knob, at top level, in the CLI's own
 * vocabulary. The `currencyCode` / `locale` echoes themselves are kept.
 */
const API_PRICED_ECHO = {
  currencyCode: "USD",
  currencyCodeSource: "explicit",
  locale: "en",
  localeSource: "explicit",
} as const;

function tripBody() {
  return {
    tripId: TRIP_ID,
    stops: 0,
    durationMinutes: 205,
    metadata: { ...API_PRICED_ECHO },
    outbound: { from: "SIN", to: "BKK", airlines: ["SQ"] },
    fares: [
      {
        kind: "partner",
        providerCode: "expedia.com",
        price: { total: 100, currency: "USD" },
        handoffUrl: "https://expedia.com/b?wg_source=wego_api",
      },
    ],
  };
}

/** One results-list card: a price summary, NO `fares[]`. */
function cardBody() {
  return {
    tripId: TRIP_ID,
    badges: ["cheapest"],
    // Trip-level stops/duration, stated by the API since #1308.
    stops: 0,
    durationMinutes: 205,
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
        departsAt: "2026-03-01T08:00:00",
        arrivesAt: "2026-03-01T09:25:00",
        arrivalDayOffset: 0,
        overnight: false,
        durationMinutes: 205,
        stops: 0,
        via: [],
        airlines: [
          { code: "SQ", name: "Singapore Airlines", logoUrl: "https://l/SQ" },
        ],
        aircraft: ["A330"],
      },
    ],
  };
}

/** A results page: lean list cards with NO `fares[]`, the only projection the API
 *  serves there since #1308. `tripBody()` is what the TRIP read answers with. */
function resultsBody(empty: boolean) {
  return {
    searchId: SEARCH_ID,
    currencyCode: "USD",
    metadata: {
      page: 1,
      pageSize: 10,
      resultCount: empty ? 0 : 1,
      totalCandidates: empty ? 0 : 1,
      hasMore: false,
      snapshotFareCount: empty ? 0 : 1,
      ...API_PRICED_ECHO,
    },
    results: empty ? [] : [cardBody()],
  };
}

/** A results body with an explicit `snapshotFareCount` (and a matching result
 *  count) — the settle signal `flights results --wait` polls on (issue #1112). */
function resultsBodyWithCount(count: number) {
  return {
    searchId: SEARCH_ID,
    currencyCode: "USD",
    metadata: {
      page: 1,
      pageSize: 10,
      resultCount: count > 0 ? 1 : 0,
      totalCandidates: count > 0 ? 1 : 0,
      hasMore: false,
      snapshotFareCount: count,
    },
    results: count > 0 ? [cardBody()] : [],
  };
}

/** A flights API that scripts a sequence of `snapshotFareCount` values over
 *  successive `…/results` reads (the last value repeats once the list is
 *  exhausted), and counts how many reads happened. Models an upstream snapshot
 *  that grows then holds steady (converges) or grows forever (never settles). */
/** A results dep that walks a fixed sequence of snapshot counts, one per read. */
function flightsResultsSequence(token: string, counts: number[]) {
  let reads = 0;
  return {
    reads: () => reads,
    fetchFlightResults: async (_b: string, tok: string, searchId: string) => {
      guard([token], tok);
      if (searchId !== SEARCH_ID) {
        throw new NotFoundError("GET /v1/flights/searches/:searchId/results");
      }
      const count = counts[Math.min(reads, counts.length - 1)] as number;
      reads++;
      return Promise.resolve(
        resultsBodyWithCount(count) as Awaited<
          ReturnType<typeof fetchFlightResults>
        >,
      );
    },
  };
}

/**
 * The flights api calls, injected (#1341).
 *
 * `emptyReads` = how many results reads answer an empty snapshot before it fills
 * (the post-create settle). `onResults` sees the query the CLI built, and an
 * unaccepted token or an unknown id raises the typed error `api.ts` would.
 */
function flightsApi(
  token: string,
  opts: {
    emptyReads?: number;
    onResults?: (query: FlightResultsQuery) => void;
    /** Sees the create body, so a test can pin that the create and its
     *  settle-read went out in the SAME resolved currency (issue #1400). */
    onCreate?: (body: CreateFlightSearchBody) => void;
    createExtra?: Record<string, unknown>;
    /** Sees the `view` the CLI forwarded to the trip read (`undefined` when no
     *  `--view` was given), so the flag is asserted at the seam it crosses. */
    onTripView?: (view: string | undefined) => void;
  } = {},
) {
  let reads = 0;
  return {
    createFlightSearch: async (
      _base: string,
      tok: string,
      body: CreateFlightSearchBody,
    ) => {
      guard([token], tok);
      opts.onCreate?.(body);
      return Promise.resolve({
        searchId: SEARCH_ID,
        ...opts.createExtra,
      } as Awaited<ReturnType<typeof createFlightSearch>>);
    },
    fetchFlightResults: async (
      _base: string,
      tok: string,
      searchId: string,
      query: FlightResultsQuery = {},
    ) => {
      guard([token], tok);
      if (searchId !== SEARCH_ID) {
        throw new NotFoundError("GET /v1/flights/searches/:searchId/results");
      }
      opts.onResults?.(query);
      // One projection since #1308, so there is no view to branch on: every read
      // answers with the card page `resultsBody` builds.
      const empty = reads < (opts.emptyReads ?? 0);
      reads++;
      return Promise.resolve(
        resultsBody(empty) as Awaited<ReturnType<typeof fetchFlightResults>>,
      );
    },
    fetchFlightTrip: async (
      _base: string,
      tok: string,
      tripId: string,
      searchId: string,
      _currency?: string,
      _locale?: string,
      view?: string,
    ) => {
      guard([token], tok);
      if (tripId !== TRIP_ID || !searchId) {
        throw new NotFoundError("GET /v1/flights/trips/:tripId");
      }
      opts.onTripView?.(view);
      return Promise.resolve(
        tripBody() as Awaited<ReturnType<typeof fetchFlightTrip>>,
      );
    },
  };
}

/**
 * The two fare calls, injected. `optionsStatus` fails `options` the way an expired
 * fare does, and `capture` sees the fareId plus the query the CLI built.
 */
function faresApi(
  accepted: string[],
  opts: {
    optionsStatus?: number;
    experienceStatus?: number;
    capture?: (call: {
      fareId: string;
      query: Record<string, unknown>;
    }) => void;
  } = {},
) {
  return {
    /**
     * `GET …/trips/:tripId/experience` (#1326). One nonstop leg whose
     * `shortStopover` the API already dropped, plus one witness present - the two
     * omission rules this command must not re-invent client-side.
     */
    fetchTripExperience: async (
      _base: string,
      token: string,
      tripId: string,
      query: Record<string, unknown> = {},
    ) => {
      opts.capture?.({ fareId: tripId, query });
      guard(accepted, token);
      if (opts.experienceStatus && opts.experienceStatus !== 200) {
        throw opts.experienceStatus === 404
          ? new NotFoundError("GET /v1/flights/trips/:tripId/experience")
          : new ApiHttpError(
              opts.experienceStatus,
              "GET /v1/flights/trips/:tripId/experience",
            );
      }
      return Promise.resolve({
        tripId,
        legs: [
          {
            id: "SIN-BKK:TR638~3:0",
            departureAirportCode: "SIN",
            arrivalAirportCode: "BKK",
            stopsCount: 0,
            signals: {
              overnight: false,
              longStopover: false,
              earlyDeparture: false,
              lateArrival: true,
              oldAircraft: true,
            },
          },
        ],
        metadata: { legCount: 1 },
      } as Awaited<ReturnType<typeof fetchTripExperience>>);
    },
    fetchFareOptions: async (
      _base: string,
      token: string,
      fareId: string,
      query: { currency?: string; locale?: string } = {},
    ) => {
      opts.capture?.({ fareId, query: query as Record<string, unknown> });
      guard(accepted, token);
      if (opts.optionsStatus && opts.optionsStatus !== 200) {
        throw opts.optionsStatus === 404
          ? new NotFoundError("GET /v1/flights/fares/:fareId/options")
          : new ApiHttpError(
              opts.optionsStatus,
              "GET /v1/flights/fares/:fareId/options",
            );
      }
      return Promise.resolve({
        fareId: "f_88_1",
        currencyCode: "USD",
        metadata: { ...API_PRICED_ECHO },
        options: [
          {
            fareOptionId: "SQ_ECO_LITE",
            name: "Economy Lite",
            price: { total: 512.3, totalUsd: 512.3, currency: "USD" },
            refundable: false,
            exchangeable: false,
            baggage: { cabin: "7kg included" },
            penalties: [],
          },
        ],
      } as Awaited<ReturnType<typeof fetchFareOptions>>);
    },
    fetchBookingLink: async (
      _base: string,
      token: string,
      fareId: string,
      query: BookingLinkParams,
    ) => {
      opts.capture?.({
        fareId,
        query: query as unknown as Record<string, unknown>,
      });
      guard(accepted, token);
      return Promise.resolve({
        bookingUrl: `https://www.wego.com/flights/searches/x/economy/1a:0c:0i/${String(query.tripId)}/f_88_1/booking?ulang=en&placement_type=integrated_booking&from_v2=true`,
        // The checkout link dies with its search, and the response says so (#1326 Q5).
        expires: true,
      });
    },
    /**
     * `GET /v1/flights/search-link` (#1326) — the DURABLE counterpart, so
     * `expires: false`. Stateless: every value in the URL is the caller's own search
     * context, which is why the link outlives the search a booking link is bound to.
     */
    fetchSearchLink: async (
      _base: string,
      token: string,
      params: SearchLinkParams,
    ) => {
      opts.capture?.({
        fareId: "",
        query: params as unknown as Record<string, unknown>,
      });
      guard(accepted, token);
      const leg = `${String(params.from)}-${String(params.to)}-${String(params.fromDate)}`;
      return Promise.resolve({
        searchUrl: `https://www.wego.com/flights/searches/${leg}/economy/1a:0c:0i?ulang=en`,
        expires: false,
      });
    },
  };
}

describe("flights (through run – the argv entry point)", () => {
  const runDeps = (
    io: ReturnType<typeof sink>,
    cfg: CliConfig,
    api: Partial<
      ReturnType<typeof flightsApi> & ReturnType<typeof faresApi>
    > = refusingApi(),
    // Stored travel preferences (issue #1386). Default: none stored, which is a
    // fresh machine and the state every pre-existing test was written against.
    settings: UserSettings = {},
  ): RunDeps => {
    const cmdIo = { log: io.log, error: io.error };
    const authed = {
      ...cmdIo,
      loadCredentials,
      saveCredentials,
      refreshTokens,
      loadSettings: async () => settings,
      recordAuthFailure: async () => {},
    };
    return {
      loadConfig: () => cfg,
      io: cmdIo,
      login: () => Promise.resolve(0),
      whoami: (c) => whoami(c, { ...authed, fetchWhoami }),
      places: (c, args) => places(c, args, { ...authed, fetchPlaces }),
      info: (c, args) =>
        info(c, args, {
          ...authed,
          fetchHolidays,
          fetchVisaFree,
          fetchSchedules,
          fetchNearbyPlaces,
        }),
      flights: (c, args) =>
        flights(c, args, {
          ...authed,
          createFlightSearch,
          fetchFlightResults,
          fetchFlightTrip,
          fetchTripExperience,
          fetchFareOptions,
          fetchBookingLink,
          fetchSearchLink,
          ...api,
          // No-op sleep so the bounded `--wait` settle loop runs instantly.
          sleep: () => Promise.resolve(),
        }),
      hotels: () => {
        throw new Error("hotels is not exercised by the flights tests");
      },
      feedback: () => {
        throw new Error("feedback is not exercised by the flights tests");
      },
      skill: () => {
        throw new Error("skill is not exercised by the flights tests");
      },
      update: () => {
        throw new Error("update is not exercised by the flights tests");
      },
      uninstall: () => {
        throw new Error("uninstall is not exercised by the flights tests");
      },
      config: () => {
        throw new Error("config is not exercised by the flights tests");
      },
      telemetry: () => {
        throw new Error("telemetry is not exercised by the flights tests");
      },
      sendTelemetry: () => {
        throw new Error("sendTelemetry is not exercised by the flights tests");
      },
      logout: (c) =>
        logout(c, { ...cmdIo, clearCredentials, clearSession: async () => {} }),
    };
  };
  const wego = (...args: string[]) => ["bun", "wego", ...args];

  it("search: creates, blocks to settled, and prints the page + searchId", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    const api = flightsApi("tok-1");
    const io = sink();
    const code = await run(
      wego(
        "flights",
        "search",
        "SIN",
        "BKK",
        "2026-03-01",
        "--return",
        "2026-03-08",
      ),
      runDeps(io, config({ api: API }), api),
    );
    expect(code).toBe(0);
    const printed = io.out.join("\n");
    expect(printed).toContain(`"searchId": "${SEARCH_ID}"`);
    // A card page, not trips: the price summary is what `search` prints (#1308).
    expect(printed).toContain('"hasWegoFare": true');
    expect(printed).not.toContain('"fares"');
  });

  it("search: --infants above the API's cap or above --adults is a usage error, not a 400", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    const api = flightsApi("tok-1");
    const io = sink();
    for (const flags of [
      ["--infants", "9"],
      ["--adults", "1", "--infants", "2"],
      ["--infants", "2"],
    ]) {
      const code = await run(
        wego("flights", "search", "SIN", "BKK", "2026-03-01", ...flags),
        runDeps(io, config({ api: API }), api),
      );
      expect(code, flags.join(" ")).toBe(2);
    }
  });

  it("search: a date that is not a real calendar day is a usage error, not a 400", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    const api = flightsApi("tok-1");
    const io = sink();
    // Both date inputs and both failure modes of the parse: a wrong shape, and a
    // shape that names no real day. Same table as `share` and `booking-link` -
    // one parse rule for every flights command.
    for (const args of [
      ["01-03-2027", []],
      ["2027-02-30", []],
      ["2027-03-01", ["--return", "2027-13-01"]],
      ["2027-03-01", ["--return", "nope"]],
    ] as const) {
      const code = await run(
        wego("flights", "search", "SIN", "BKK", args[0], ...args[1]),
        runDeps(io, config({ api: API }), api),
      );
      expect(code, `${args[0]} ${args[1].join(" ")}`).toBe(2);
    }
  });

  it("search: derives --site from the stored id_token market (source: account)", async () => {
    // Logged in with a market decoded from the id_token; no explicit --site.
    await saveCredentials(credPath, { accessToken: "tok-1", market: "AE" });
    // The API echoes the siteCode the CLI derived + sent; the CLI reports its
    // OWN source (`account`), since only the CLI knows it auto-derived.
    const api = flightsApi("tok-1", {
      createExtra: { siteCode: "AE", siteCodeSource: "explicit" },
    });
    const io = sink();
    const code = await run(
      wego("flights", "search", "SIN", "BKK", "2026-03-01"),
      runDeps(io, config({ api: API }), api),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(io.out.join("\n")) as {
      siteCode: string;
      siteCodeSource: string;
    };
    expect(parsed.siteCode).toBe("AE");
    expect(parsed.siteCodeSource).toBe("account");
  });

  it("search: an explicit --site overrides the derived market (source: explicit)", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1", market: "AE" });
    const api = flightsApi("tok-1", {
      createExtra: { siteCode: "SG", siteCodeSource: "explicit" },
    });
    const io = sink();
    const code = await run(
      wego("flights", "search", "SIN", "BKK", "2026-03-01", "--site", "SG"),
      runDeps(io, config({ api: API }), api),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(io.out.join("\n")) as {
      siteCode: string;
      siteCodeSource: string;
    };
    expect(parsed.siteCode).toBe("SG");
    expect(parsed.siteCodeSource).toBe("explicit");
  });

  it("search: no --site and no stored market → US default (source: default)", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" }); // no market
    const api = flightsApi("tok-1", {
      createExtra: { siteCode: "US", siteCodeSource: "default" },
    });
    const io = sink();
    const code = await run(
      wego("flights", "search", "SIN", "BKK", "2026-03-01"),
      runDeps(io, config({ api: API }), api),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(io.out.join("\n")) as {
      siteCode: string;
      siteCodeSource: string;
    };
    expect(parsed.siteCode).toBe("US");
    expect(parsed.siteCodeSource).toBe("default");
  });

  it("search: threads --currency and --locale into the results read (not the API defaults)", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    const seen: Array<{ currency?: string; locale?: string }> = [];
    const api = flightsApi("tok-1", {
      onResults: (query) =>
        seen.push({ currency: query.currency, locale: query.locale }),
    });
    const code = await run(
      wego(
        "flights",
        "search",
        "SIN",
        "BKK",
        "2026-03-01",
        "--currency",
        "SGD",
        "--locale",
        "ar",
      ),
      runDeps(sink(), config({ api: API }), api),
    );
    expect(code).toBe(0);
    // The post-create results read carries the search's currency + locale.
    expect(seen[0]).toEqual({ currency: "SGD", locale: "ar" });
  });

  it("search: emits ONLY parseable JSON on stdout when the first page is empty, with the hint on stderr", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    // The immediate read returns an empty page: search prints it + the hint.
    const api = flightsApi("tok-1", { emptyReads: 99 });
    const io = sink();
    const code = await run(
      wego("flights", "search", "SIN", "BKK", "2026-03-01"),
      runDeps(io, config({ api: API }), api),
    );
    expect(code).toBe(0);
    // stdout is the JSON object and nothing else — an agent/script consuming a
    // successful `flights search` must be able to JSON.parse it even when empty.
    const parsed = JSON.parse(io.out.join("\n")) as {
      searchId: string;
      results: unknown[];
    };
    expect(parsed.searchId).toBe(SEARCH_ID);
    expect(parsed.results).toHaveLength(0);
    // The human re-poll hint goes to stderr, never stdout.
    expect(io.err.join("\n")).toContain(`wego flights results ${SEARCH_ID}`);
    expect(io.out.join("\n")).not.toContain("re-run");
  });

  it("search: a 401 during the results read refreshes + retries the READ, never re-creating the search", async () => {
    // Regression: create + read must be separate withAccessToken calls, so a
    // token expiry between them retries only the read (same searchId) — not the
    // whole callback, which would spawn a second upstream search.
    await saveCredentials(credPath, {
      accessToken: "tok-1",
      refreshToken: "rt",
    });
    const as = authServer(() => Response.json({ access_token: "fresh" }));
    let creates = 0;
    let firstRead = true;
    // The create accepts the initial token; the first results read raises the
    // `UnauthorizedError` `api.ts` raises on a 401, then only the refreshed
    // "fresh" token is accepted.
    const api = {
      createFlightSearch: async (_b: string, token: string) => {
        guard(["tok-1"], token);
        creates++;
        return Promise.resolve({ searchId: SEARCH_ID });
      },
      fetchFlightResults: async (_b: string, token: string) => {
        if (firstRead) {
          firstRead = false;
          throw new UnauthorizedError();
        }
        guard(["fresh"], token);
        return Promise.resolve(
          resultsBody(false) as Awaited<ReturnType<typeof fetchFlightResults>>,
        );
      },
    };
    const io = sink();
    const code = await run(
      wego("flights", "search", "SIN", "BKK", "2026-03-01"),
      runDeps(io, config({ as: as.url, api: API }), api),
    );
    expect(code).toBe(0);
    expect(creates).toBe(1); // create ran exactly once, despite the read 401
    expect(io.out.join("\n")).toContain('"hasWegoFare": true');
  });

  it("results: after a reactive refresh, a non-auth failure keeps its typed exit class (not AUTH)", async () => {
    // Regression (#1130 review): a 401 on the first read refreshes + retries, but
    // if the RETRIED read fails with a non-auth error (503 here), it must be
    // classified by the shared taxonomy — EXIT.RETRYABLE (5) — not swallowed as
    // EXIT.AUTH (3) merely because it happened inside the refresh-retry path.
    await saveCredentials(credPath, {
      accessToken: "tok-1",
      refreshToken: "rt",
    });
    const as = authServer(() => Response.json({ access_token: "fresh" }));
    let firstRead = true;
    const api = {
      fetchFlightResults: async (_b: string, token: string) => {
        if (firstRead) {
          firstRead = false;
          throw new UnauthorizedError();
        }
        guard(["fresh"], token);
        // The refreshed token is accepted, but the upstream is unavailable.
        throw new ApiHttpError(
          503,
          "GET /v1/flights/searches/:searchId/results",
        );
      },
    };
    const io = sink();
    const code = await run(
      wego("flights", "results", SEARCH_ID),
      runDeps(io, config({ as: as.url, api: API }), api),
    );
    expect(code).toBe(5); // retryable (503): refresh succeeded, the retried call did not
  });

  it("search: a non-401 results-read failure exits 1 with only the 'Search created – re-run' hint (no raw error, no JSON)", async () => {
    // The primary failure surface of the simplified command: create succeeds,
    // the immediate read 500s (non-401 → no refresh). stdout must stay empty
    // (no JSON) and stderr must carry the single recovery hint — not the raw
    // upstream error plus a second hint line.
    await saveCredentials(credPath, { accessToken: "tok-1" });
    const api = {
      createFlightSearch: async (_b: string, token: string) => {
        guard(["tok-1"], token);
        return Promise.resolve({ searchId: SEARCH_ID });
      },
      fetchFlightResults: async (_b: string, token: string) => {
        guard(["tok-1"], token);
        throw new ApiHttpError(
          500,
          "GET /v1/flights/searches/:searchId/results",
        );
      },
    };
    const io = sink();
    const code = await run(
      wego("flights", "search", "SIN", "BKK", "2026-03-01"),
      runDeps(io, config({ api: API }), api),
    );
    expect(code).toBe(1);
    expect(io.out.join("\n")).toBe(""); // no JSON on a failed read
    const err = io.err.join("\n");
    expect(err).toContain(
      `Search created – re-run: wego flights results ${SEARCH_ID} --wait`,
    );
    // Exactly the hint — the raw 5xx is not surfaced alongside it.
    expect(err).not.toMatch(/500|boom|failed: 5/);
  });

  it("search: a MID-settle non-401 read failure surfaces its exit-code taxonomy (not the attempt-0 fold)", async () => {
    // The attempt-0 fold (test above) is scoped to the first, right-after-create
    // read. A failure on a LATER settle re-read is a genuine transient/upstream
    // fault (the search was already returning snapshots), so it must surface with
    // its real exit-code class + trace-id, NOT collapse to the generic exit-1
    // "Search created — re-run" hint. Read #1 succeeds with a non-converged count
    // (forcing a re-read); read #2 (mid-settle) 500s → EXIT.PERMANENT (6).
    await saveCredentials(credPath, { accessToken: "tok-1" });
    let reads = 0;
    const api = {
      createFlightSearch: async (_b: string, token: string) => {
        guard(["tok-1"], token);
        return Promise.resolve({ searchId: SEARCH_ID });
      },
      fetchFlightResults: async (_b: string, token: string) => {
        guard(["tok-1"], token);
        reads++;
        // Attempt 0: a valid snapshot with a count that cannot converge yet
        // (convergence needs two equal reads) → the settle proceeds to a second.
        if (reads === 1) {
          return Promise.resolve(
            resultsBodyWithCount(1) as Awaited<
              ReturnType<typeof fetchFlightResults>
            >,
          );
        }
        // Attempt 1 (mid-settle): a hard 500 (not 429/503, so no GET retry).
        throw new ApiHttpError(
          500,
          "GET /v1/flights/searches/:searchId/results",
        );
      },
    };
    const io = sink();
    const code = await run(
      wego("flights", "search", "SIN", "BKK", "2026-03-01"),
      runDeps(io, config({ api: API }), api),
    );
    // The real taxonomy (500 → permanent), not the folded exit 1.
    expect(code).toBe(6);
    expect(io.out.join("\n")).toBe(""); // still no JSON on a failed settle
    // The fold hint must NOT appear — the mid-settle error is surfaced on its own.
    expect(io.err.join("\n")).not.toContain("Search created – re-run");
    expect(reads).toBeGreaterThanOrEqual(2); // it did re-read past the first
  });

  it("search: blocks to settled – re-reads past the first snapshot, stamps settled (issue #1084)", async () => {
    // #1084 unifies the two verticals: `flights search` now BLOCKS to settled
    // through the shared engine (it used to return the first snapshot
    // immediately). The first read is empty, so the settle must re-read until
    // the count converges — never a single read.
    await saveCredentials(credPath, { accessToken: "tok-1" });
    let reads = 0;
    const api = flightsApi("tok-1", {
      emptyReads: 1,
      onResults: () => {
        reads++;
      },
    });
    const io = sink();
    const code = await run(
      wego("flights", "search", "SIN", "BKK", "2026-03-01"),
      runDeps(io, config({ api: API }), api),
    );
    expect(code).toBe(0);
    // It re-read past the first (empty) snapshot rather than returning it.
    expect(reads).toBeGreaterThan(1);
    const parsed = JSON.parse(io.out.join("\n")) as {
      settled: string;
      results: unknown[];
    };
    expect(parsed.settled).toBe("converged");
    expect(parsed.results.length).toBeGreaterThan(0);
  });

  it("results --wait: settles when snapshotFareCount stops growing → JSON with settled:'converged'", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    // empty → partial → stable: reads report 0, then 3, then 3 again. The
    // second stable read means the snapshot converged (issue #1112).
    const api = flightsResultsSequence("tok-1", [0, 3, 3]);
    const io = sink();
    const code = await run(
      wego("flights", "results", SEARCH_ID, "--wait"),
      runDeps(io, config({ api: API }), api),
    );
    expect(code).toBe(0);
    // stdout is a single JSON object (agent-parseable) carrying the honest
    // heuristic label; the settle field is part of the JSON, not a stderr hint.
    const parsed = JSON.parse(io.out.join("\n")) as {
      searchId: string;
      settled: string;
      metadata: { snapshotFareCount: number };
    };
    expect(parsed.searchId).toBe(SEARCH_ID);
    expect(parsed.settled).toBe("converged");
    expect(parsed.metadata.snapshotFareCount).toBe(3);
    // It stopped early on convergence — well short of the full read budget.
    expect(api.reads()).toBe(3);
  });

  it("results --wait: with no count to trust, the settle falls back to item-presence", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    // The `.catch(undefined)` that drops a malformed `snapshotFareCount` lives in
    // `api.ts`'s response schema, so it is asserted there ("drops a malformed
    // snapshotFareCount"). What belongs here is the consequence: with the count
    // absent, item-presence carries the settle to converged.
    const api = {
      fetchFlightResults: async (_b: string, token: string) => {
        guard(["tok-1"], token);
        return Promise.resolve({
          searchId: SEARCH_ID,
          currencyCode: "USD",
          metadata: {
            page: 1,
            pageSize: 10,
            resultCount: 1,
            totalCandidates: 1,
            hasMore: false,
          },
          results: [cardBody()],
        } as Awaited<ReturnType<typeof fetchFlightResults>>);
      },
    };
    const io = sink();
    const code = await run(
      wego("flights", "results", SEARCH_ID, "--wait"),
      runDeps(io, config({ api: API }), api),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(io.out.join("\n")) as {
      settled: string;
      metadata: { snapshotFareCount?: number };
    };
    // The malformed count is dropped (undefined), not surfaced as a number;
    // item-presence carries the settle to converged.
    expect(parsed.metadata.snapshotFareCount).toBeUndefined();
    expect(parsed.settled).toBe("converged");
  });

  it("results --wait: a transient count drop does not converge – waits for equality", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    // A transient prune/dedup drops the count (12 → 10) before it holds steady.
    // Convergence is defined as two successive *equal* non-zero reads, so the
    // drop must reset the baseline and keep waiting — never converge on 10 ≤ 12.
    const api = flightsResultsSequence("tok-1", [0, 12, 10, 10]);
    const io = sink();
    const code = await run(
      wego("flights", "results", SEARCH_ID, "--wait"),
      runDeps(io, config({ api: API }), api),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(io.out.join("\n")) as {
      settled: string;
      metadata: { snapshotFareCount: number };
    };
    // It settled only once the count held equal (10 == 10), not at the 12 → 10
    // decrease — which required a fourth read past the drop.
    expect(parsed.settled).toBe("converged");
    expect(parsed.metadata.snapshotFareCount).toBe(10);
    expect(api.reads()).toBe(4);
  });

  it("results --wait: a never-stabilizing snapshot exhausts the budget → settled:'budget_exhausted' + stderr hint", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    // A count that grows on every read never converges — the budget must cap it.
    const api = flightsResultsSequence(
      "tok-1",
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    );
    const io = sink();
    const code = await run(
      wego("flights", "results", SEARCH_ID, "--wait"),
      runDeps(io, config({ api: API }), api),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(io.out.join("\n")) as { settled: string };
    expect(parsed.settled).toBe("budget_exhausted");
    // The re-poll hint is human guidance → stderr, keeping stdout JSON-only.
    expect(io.err.join("\n")).toMatch(/re-run|still (growing|accruing)/i);
    // The read budget is bounded by the unified engine (issue #1084): one
    // initial read + DEFAULT_SETTLE_BUDGET.maxRereads (12) re-reads = 13, never
    // unbounded.
    expect(api.reads()).toBe(13);
  });

  it("results --wait: a 401 mid-settle refreshes once and restarts the whole poll (never resumes)", async () => {
    // The whole settle loop runs inside ONE withAccessToken call, which retries
    // its entire callback once on a 401. So a token expiry partway through the
    // re-reads restarts settleFlightResults from read #1 against the same id —
    // correctness-safe (reads are idempotent), it just re-walks the sequence.
    await saveCredentials(credPath, {
      accessToken: "tok-1",
      refreshToken: "rt",
    });
    const as = authServer(() => Response.json({ access_token: "fresh" }));
    const counts = [0, 2, 2]; // first pass: 0 → 2, then a 401 before it holds
    let reads = 0;
    const api = {
      fetchFlightResults: async (_b: string, token: string) => {
        // "tok-1" expires on its 3rd read (mid-settle); only "fresh" works after.
        if (token === "tok-1" && reads >= 2) throw new UnauthorizedError();
        guard(["tok-1", "fresh"], token);
        const count = counts[Math.min(reads, counts.length - 1)] as number;
        reads++;
        return Promise.resolve(
          resultsBodyWithCount(count) as Awaited<
            ReturnType<typeof fetchFlightResults>
          >,
        );
      },
    };
    const io = sink();
    const code = await run(
      wego("flights", "results", SEARCH_ID, "--wait"),
      runDeps(io, config({ as: as.url, api: API }), api),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(io.out.join("\n")) as {
      settled: string;
      metadata: { snapshotFareCount: number };
    };
    // The restarted poll converges once the count holds equal on "fresh".
    expect(parsed.settled).toBe("converged");
    expect(parsed.metadata.snapshotFareCount).toBe(2);
    // Reads before the 401 count toward the total: the restart re-walks read #1.
    expect(reads).toBeGreaterThan(3);
  });

  it("results: without --wait, reads exactly once (no settle loop) and stamps settled:unsettled (issue #1084)", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    const api = flightsResultsSequence("tok-1", [1, 2, 3]);
    const io = sink();
    const code = await run(
      wego("flights", "results", SEARCH_ID),
      runDeps(io, config({ api: API }), api),
    );
    expect(code).toBe(0);
    expect(api.reads()).toBe(1);
    // A bare (un-waited) read is a single snapshot → honestly stamped
    // `unsettled` so an empty page is never mistaken for a definitive
    // no-results (the metasearch has no completion flag).
    const parsed = JSON.parse(io.out.join("\n")) as { settled?: string };
    expect(parsed.settled).toBe("unsettled");
  });

  it("results: renders the fares-less card body and sends no view param (issues #1117 + #1308)", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    let seen: FlightResultsQuery | undefined;
    const api = flightsApi("tok-1", { onResults: (q) => (seen = q) });
    const io = sink();
    const code = await run(
      wego("flights", "results", SEARCH_ID),
      runDeps(io, config({ api: API }), api),
    );
    expect(code).toBe(0);
    // No projection to choose: the CLI stopped sending `view` with #1308. Asserted
    // on the KEY, not on a typed field - `view` is off `FlightResultsQuery`, so a
    // stray one would only ever show up as an extra key on what the command passed.
    expect(seen && "view" in seen).toBe(false);
    const printed = io.out.join("\n");
    expect(printed).toContain(`"tripId": "${TRIP_ID}"`);
    expect(printed).toContain('"scope": "party"');
    // A card carries no fares — the render must not invent them.
    expect(printed).not.toContain('"fares"');
    // Trip-level stops/duration ARE on the card, so an agent never folds legs[].
    expect(printed).toContain('"durationMinutes": 205');
  });

  // --- stored travel preferences (issue #1386) -------------------------------

  it("results: a stored currency reaches a bare read, which used to revert to USD", async () => {
    // THE bug in issue #1386: `--currency SAR` on the search, then a plain read
    // came back priced in USD, and 216 SAR looked like it had fallen to 58. The
    // query the read passed is where that is decided; `api.test.ts` owns what it
    // then becomes on the wire.
    await saveCredentials(credPath, { accessToken: "tok-1" });
    let seen: FlightResultsQuery | undefined;
    const api = flightsApi("tok-1", { onResults: (q) => (seen = q) });
    const io = sink();
    const code = await run(
      wego("flights", "results", SEARCH_ID),
      runDeps(io, config({ api: API }), api, {
        currency: "SAR",
        locale: "ar",
      }),
    );
    expect(code).toBe(0);
    expect(seen).toMatchObject({ currency: "SAR", locale: "ar" });
  });

  it("results: an explicit --currency still beats the stored one", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    let seen: FlightResultsQuery | undefined;
    const api = flightsApi("tok-1", { onResults: (q) => (seen = q) });
    const io = sink();
    const code = await run(
      wego("flights", "results", SEARCH_ID, "--currency", "USD"),
      runDeps(io, config({ api: API }), api, { currency: "SAR" }),
    );
    expect(code).toBe(0);
    expect(seen?.currency).toBe("USD");
  });

  it("search: a stored site is sent and reported as source `setting`, over the account market", async () => {
    // The account says AE; the user buys from SA. The setting wins and the
    // output says which layer decided, so an agent can report the market.
    await saveCredentials(credPath, { accessToken: "tok-1", market: "AE" });
    const api = flightsApi("tok-1", {
      createExtra: { siteCode: "SA", siteCodeSource: "explicit" },
    });
    const io = sink();
    const code = await run(
      wego("flights", "search", "RUH", "DXB", "2099-03-01"),
      runDeps(io, config({ api: API }), api, { site: "SA", currency: "SAR" }),
    );
    expect(code).toBe(0);
    const printed = io.out.join("\n");
    expect(printed).toContain('"siteCode": "SA"');
    expect(printed).toContain('"siteCodeSource": "setting"');
  });

  it("search: names the layer the CURRENCY came from, which the API cannot see", async () => {
    // Issue #1400. The request carries one currency string either way, so the
    // API's own `metadata.currencyCodeSource` calls a stored currency `explicit`
    // — only the CLI can say `setting`. Each rung also pins the invariant that
    // erasing the source used to protect: the create and its settle read go out
    // in the SAME resolved currency, or the search and its first page are priced
    // in different units.
    await saveCredentials(credPath, { accessToken: "tok-1" });
    const search = async (settings: UserSettings, extraArgs: string[]) => {
      let created: CreateFlightSearchBody | undefined;
      let read: FlightResultsQuery | undefined;
      const io = sink();
      const code = await run(
        wego("flights", "search", "RUH", "DXB", "2099-03-01", ...extraArgs),
        runDeps(
          io,
          config({ api: API }),
          flightsApi("tok-1", {
            onCreate: (b) => (created = b),
            onResults: (q) => (read = q),
          }),
          settings,
        ),
      );
      expect(code).toBe(0);
      const printed = JSON.parse(io.out.join("\n")) as Record<string, unknown>;
      return { source: printed.currencyCodeSource, created, read };
    };

    const explicit = await search({ currency: "SAR" }, ["--currency", "USD"]);
    expect(explicit.source).toBe("explicit");
    expect(explicit.created?.currency).toBe("USD");
    expect(explicit.read?.currency).toBe("USD");

    const stored = await search({ currency: "SAR" }, []);
    expect(stored.source).toBe("setting");
    expect(stored.created?.currency).toBe("SAR");
    expect(stored.read?.currency).toBe("SAR");

    // Nothing stored and no flag: the request carries no currency at all, so the
    // API's USD default owns the decision and the label says so.
    const defaulted = await search({}, []);
    expect(defaulted.source).toBe("default");
    expect(defaulted.created?.currency).toBeUndefined();
    expect(defaulted.read?.currency).toBeUndefined();
  });

  it("every priced read names the rung, not just the two searches", async () => {
    // #1529 labelled the two `search`es. A search is not where most prices are
    // read: `results` re-prices a page, and `trip` / `fares` are where a number
    // is actually quoted from. Each decides its own unit (a `searchId` carries
    // no currency), so each owes the same label — otherwise the rung is legible
    // exactly once per funnel, at the step nobody quotes.
    await saveCredentials(credPath, { accessToken: "tok-1" });
    // `fares` lives on its own stub, so both are merged: `runDeps` takes one api
    // bag and the real functions would otherwise reach the network.
    const sourceOf = async (argv: string[], settings: UserSettings) => {
      const io = sink();
      const code = await run(
        wego(...argv),
        runDeps(
          io,
          config({ api: API }),
          { ...flightsApi("tok-1"), ...faresApi(["tok-1"]) },
          settings,
        ),
      );
      expect(code).toBe(0);
      return (JSON.parse(io.out.join("\n")) as Record<string, unknown>)
        .currencyCodeSource;
    };

    expect(await sourceOf(["flights", "results", SEARCH_ID], {})).toBe(
      "default",
    );
    expect(
      await sourceOf(["flights", "results", SEARCH_ID], { currency: "SAR" }),
    ).toBe("setting");
    expect(
      await sourceOf(["flights", "results", SEARCH_ID, "--currency", "USD"], {
        currency: "SAR",
      }),
    ).toBe("explicit");

    expect(
      await sourceOf(["flights", "trip", TRIP_ID, "--search", SEARCH_ID], {
        currency: "SAR",
      }),
    ).toBe("setting");
    expect(
      await sourceOf(["flights", "fares", "f_88_1"], { currency: "SAR" }),
    ).toBe("setting");
  });

  it("a read's currency reaches the wire from the rung the label names", async () => {
    // The label is only worth reading if it describes the request that was
    // actually made. Moving `results` off `applyPreferences` is where that could
    // silently break: the source would still print while the query went out
    // bare.
    await saveCredentials(credPath, { accessToken: "tok-1" });
    let seen: FlightResultsQuery | undefined;
    const io = sink();
    const code = await run(
      wego("flights", "results", SEARCH_ID),
      runDeps(
        io,
        config({ api: API }),
        flightsApi("tok-1", { onResults: (q) => (seen = q) }),
        { currency: "SAR", locale: "ar" },
      ),
    );
    expect(code).toBe(0);
    // Locale still rides `applyPreferences`; only currency moved.
    expect(seen).toMatchObject({ currency: "SAR", locale: "ar" });
  });

  it("every priced read prints ONE *Source per knob, top level, CLI vocabulary (flights four of the eight)", async () => {
    // The #1534 rule (decision Q2: "strip"). The API's request-scoped copies
    // inside `metadata` — `currencyCodeSource`, `localeSource` — answer a
    // narrower question in a narrower vocabulary: with a currency stored in
    // settings.json the two fields disagree by construction ("setting" outside,
    // "explicit" inside). So the copies are stripped at print time and the
    // CLI's own top-level label is the ONE answer a payload carries. The
    // `currencyCode` / `locale` echoes themselves are kept. The other four
    // priced reads are the hotels half, pinned in `hotels.test.ts`.
    await saveCredentials(credPath, { accessToken: "tok-1" });
    const printedFor = async (argv: string[]) => {
      const io = sink();
      const code = await run(
        wego(...argv),
        runDeps(
          io,
          config({ api: API }),
          { ...flightsApi("tok-1"), ...faresApi(["tok-1"]) },
          { currency: "SAR" },
        ),
      );
      expect(code).toBe(0);
      return io.out.join("\n");
    };

    for (const argv of [
      ["flights", "search", "RUH", "DXB", "2099-03-01"],
      ["flights", "results", SEARCH_ID],
      ["flights", "trip", TRIP_ID, "--search", SEARCH_ID],
      ["flights", "fares", "f_88_1"],
    ]) {
      const printed = await printedFor(argv);
      const which = argv.join(" ");
      // The echoes stay; every `*Source` inside metadata is gone.
      expect(printed, which).toContain('"locale": "en"');
      expect(printed, which).not.toContain("localeSource");
      const parsed = JSON.parse(printed) as {
        currencyCodeSource: string;
        metadata: Record<string, unknown>;
      };
      // Exactly one currency label: top level, CLI vocabulary (`setting` is the
      // rung the API cannot see), and no copy left in metadata.
      expect(parsed.currencyCodeSource, which).toBe("setting");
      expect(printed.split('"currencyCodeSource"').length - 1, which).toBe(1);
      expect(
        Object.keys(parsed.metadata).filter((k) => k.endsWith("Source")),
        which,
      ).toEqual([]);
    }
  });

  it("search: prints the currency hint on a fresh machine, and not once one is stored", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    const fresh = sink();
    expect(
      await run(
        wego("flights", "search", "RUH", "DXB", "2099-03-01"),
        runDeps(fresh, config({ api: API }), flightsApi("tok-1")),
      ),
    ).toBe(0);
    expect(fresh.err.join("\n")).toContain("config set currency");

    const configured = sink();
    expect(
      await run(
        wego("flights", "search", "RUH", "DXB", "2099-03-01"),
        runDeps(configured, config({ api: API }), flightsApi("tok-1"), {
          currency: "SAR",
        }),
      ),
    ).toBe(0);
    expect(configured.err.join("\n")).not.toContain("config set currency");
  });

  it("search: an explicit --currency also silences the hint (nothing was defaulted)", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    const io = sink();
    expect(
      await run(
        wego(
          "flights",
          "search",
          "RUH",
          "DXB",
          "2099-03-01",
          "--currency",
          "SAR",
        ),
        runDeps(io, config({ api: API }), flightsApi("tok-1")),
      ),
    ).toBe(0);
    expect(io.err.join("\n")).not.toContain("config set currency");
  });

  it("results --wait: falls back to item-presence when the count is ABSENT (a count-less page) (issue #1084)", async () => {
    // When a snapshot carries no `snapshotFareCount` (a legacy API, or a
    // count-less page), the unified settle can't converge on the count — it must
    // fall back to item-presence and stop as soon as cards appear, not burn the
    // whole re-read budget.
    await saveCredentials(credPath, { accessToken: "tok-1" });
    let reads = 0;
    const api = flightsApi("tok-1", {
      onResults: () => {
        reads++;
      },
    });
    const io = sink();
    const code = await run(
      wego("flights", "results", SEARCH_ID, "--wait"),
      runDeps(io, config({ api: API }), api),
    );
    expect(code).toBe(0);
    // The fake always carries one card → converges on the first read's
    // item-presence; it must NOT run the full 13-read budget.
    expect(reads).toBeLessThanOrEqual(2);
    const parsed = JSON.parse(io.out.join("\n")) as { settled: string };
    expect(parsed.settled).toBe("converged");
  });

  it("results: an expired/unknown search prints a friendly message (exit 4, not_found)", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    const api = flightsApi("tok-1");
    const io = sink();
    const code = await run(
      wego("flights", "results", "gone123msr"),
      runDeps(io, config({ api: API }), api),
    );
    expect(code).toBe(4); // not_found: a 404 keeps its typed exit class
    expect(io.err.join("\n")).toMatch(/expired|not found/i);
  });

  it("trip: forwards --view to the trip read, and sends none without the flag", async () => {
    // The projection axis the API publishes on this read (`default|detail`). Before
    // the flag, `?view=detail` was reachable only by calling the API directly — which
    // is what tier C's `apiGet` bypass existed for.
    await saveCredentials(credPath, { accessToken: "tok-1" });
    const views: Array<string | undefined> = [];
    const api = flightsApi("tok-1", {
      onTripView: (view) => views.push(view),
    });
    const deps = runDeps(sink(), config({ api: API }), api);
    expect(
      await run(
        wego(
          "flights",
          "trip",
          TRIP_ID,
          "--search",
          SEARCH_ID,
          "--view",
          "detail",
        ),
        deps,
      ),
    ).toBe(0);
    expect(
      await run(wego("flights", "trip", TRIP_ID, "--search", SEARCH_ID), deps),
    ).toBe(0);
    // `undefined` on the second call, NOT the string "default": the CLI omits the
    // param rather than spelling out the server's own default, so the query string
    // of an unflagged read is unchanged by this feature.
    expect(views).toEqual(["detail", undefined]);
  });

  it("trip: rejects an unknown --view locally (exit 2, no network)", async () => {
    // Guarded against the published enum, like `hotels details --view`. The api URL
    // is a closed port, so a call escaping the guard fails as a fault, not a 400.
    await saveCredentials(credPath, { accessToken: "tok-1" });
    const io = sink();
    const code = await run(
      wego(
        "flights",
        "trip",
        TRIP_ID,
        "--search",
        SEARCH_ID,
        "--view",
        "detials",
      ),
      runDeps(io, config({ api: "http://127.0.0.1:1" })),
    );
    expect(code).toBe(2);
    expect(io.err.join("\n")).toContain(
      "--view must be one of default, detail",
    );
  });

  it("trip: requires --search (usage error, no network)", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    const io = sink();
    const code = await run(
      wego("flights", "trip", TRIP_ID),
      runDeps(io, config({ api: "http://127.0.0.1:1" })),
    );
    expect(code).toBe(2); // usage error
    expect(io.err.join("\n")).toMatch(/--search/);
  });

  it("rejects an unknown flights sub-command with usage (exit 2)", async () => {
    const io = sink();
    const code = await run(
      wego("flights", "bogus"),
      runDeps(io, config({ api: "http://127.0.0.1:1" })),
    );
    expect(code).toBe(2); // usage error
    expect(io.err.join("\n")).toMatch(/Usage:/);
  });
});

// --- flights (issue #1014) — driven through the REAL `run` entry point -------

describe("flights fares + booking-link (through run – the argv entry point)", () => {
  const runDeps = (
    io: ReturnType<typeof sink>,
    cfg: CliConfig,
    api: Partial<ReturnType<typeof faresApi>> = refusingApi(),
    // Stored travel preferences (issue #1386). Default: none stored, the state
    // every pre-existing test in this block was written against.
    settings: UserSettings = {},
  ): RunDeps => {
    const cmdIo = { log: io.log, error: io.error };
    const notExercised = () => {
      throw new Error("not exercised by the flights tests");
    };
    return {
      loadConfig: () => cfg,
      io: cmdIo,
      login: notExercised,
      whoami: notExercised,
      places: notExercised,
      info: notExercised,
      flights: (c, args) =>
        flights(c, args, {
          ...cmdIo,
          loadCredentials,
          saveCredentials,
          refreshTokens,
          loadSettings: async () => settings,
          recordAuthFailure: async () => {},
          createFlightSearch,
          fetchFlightResults,
          fetchFlightTrip,
          fetchTripExperience,
          fetchFareOptions,
          fetchBookingLink,
          fetchSearchLink,
          ...api,
          sleep: () => Promise.resolve(),
        }),
      hotels: notExercised,
      feedback: notExercised,
      skill: notExercised,
      update: notExercised,
      uninstall: notExercised,
      config: notExercised,
      telemetry: notExercised,
      sendTelemetry: notExercised,
      logout: (c) =>
        logout(c, { ...cmdIo, clearCredentials, clearSession: async () => {} }),
    };
  };
  const wego = (...args: string[]) => ["bun", "wego", ...args];

  it("fares: prints the branded-fare options JSON and forwards currency/locale", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    let seen: { fareId: string; query: Record<string, unknown> } | undefined;
    const api = faresApi(["tok-1"], { capture: (call) => (seen = call) });
    const io = sink();

    const code = await run(
      wego("flights", "fares", "f_88_1", "--currency", "USD", "--locale", "en"),
      runDeps(io, config({ api: API }), api),
    );

    expect(code).toBe(0);
    expect(io.out.join("")).toContain('"fareOptionId": "SQ_ECO_LITE"');
    expect(seen?.fareId).toBe("f_88_1");
    expect(String(seen?.query.currency)).toBe("USD");
    expect(String(seen?.query.locale)).toBe("en");
  });

  it("fares: an expired fare (API 404) prints the re-search hint (exit 4, not_found)", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    // The API returns 404 for an expired fare (its upstream compare 410'd).
    const api = faresApi(["tok-1"], { optionsStatus: 404 });
    const io = sink();

    const code = await run(
      wego("flights", "fares", "f_88_1"),
      runDeps(io, config({ api: API }), api),
    );

    expect(code).toBe(4); // not_found: an expired fare keeps its typed exit class
    expect(io.err.join("")).toMatch(/expired|search again|re-open/i);
  });

  it("experience: prints the per-leg signals and sends no query by default", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    let seen: { fareId: string; query: Record<string, unknown> } | undefined;
    const api = faresApi(["tok-1"], { capture: (call) => (seen = call) });
    const io = sink();

    const code = await run(
      wego("flights", "experience", "s1msr:TR638~3~1250~1425"),
      runDeps(io, config({ api: API }), api),
    );

    expect(code).toBe(0);
    expect(io.out.join("")).toContain('"lateArrival": true');
    // The tripId reaches the call unmangled; `api.ts` owns the percent-encoding
    // into the path, which `api.test.ts` asserts on the URL it builds.
    expect(seen?.fareId).toBe("s1msr:TR638~3~1250~1425");
    // No `searchId` unless the caller asked for the cross-check.
    expect(seen?.query).toEqual({});
  });

  it("experience: forwards --search as the cross-check", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    let seen: { fareId: string; query: Record<string, unknown> } | undefined;
    const api = faresApi(["tok-1"], { capture: (call) => (seen = call) });
    const io = sink();

    const code = await run(
      wego(
        "flights",
        "experience",
        "s1msr:TR638~3~1250~1425",
        "--search",
        "s1msr",
      ),
      runDeps(io, config({ api: API }), api),
    );

    expect(code).toBe(0);
    expect(seen?.query.searchId).toBe("s1msr");
  });

  it("experience: an expired trip (API 404) prints the re-search hint (exit 4)", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    const api = faresApi(["tok-1"], { experienceStatus: 404 });
    const io = sink();

    const code = await run(
      wego("flights", "experience", "s1msr:TR638~3~1250~1425"),
      runDeps(io, config({ api: API }), api),
    );

    expect(code).toBe(4);
    expect(io.err.join("")).toMatch(/expired|search again|re-open/i);
  });

  it("experience: a missing tripId is a usage error with no network call", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    let called = false;
    const api = faresApi(["tok-1"], { capture: () => (called = true) });
    const io = sink();

    const code = await run(
      wego("flights", "experience"),
      runDeps(io, config({ api: API }), api),
    );

    expect(code).toBe(2);
    expect(called).toBe(false);
    expect(io.err.join("")).toContain("flights experience <tripId>");
  });

  it("booking-link: maps every flag to the query and prints { bookingUrl }", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    let seen: { fareId: string; query: Record<string, unknown> } | undefined;
    const api = faresApi(["tok-1"], { capture: (call) => (seen = call) });
    const io = sink();

    const code = await run(
      wego(
        "flights",
        "booking-link",
        "f_88_1",
        "--trip",
        "trip-abc:xyz",
        "--search",
        "search-1",
        "--fare-option",
        "uuid-1",
        "--from",
        "SIN",
        "--to",
        "BKK",
        "--date",
        "2026-08-01",
        "--return",
        "2026-08-08",
        "--cabin",
        "business",
        "--adults",
        "2",
        "--children",
        "1",
        "--infants",
        "1",
        "--site",
        "SG",
        "--currency",
        "USD",
        "--locale",
        "en",
        "--from-city",
        "--to-city",
      ),
      runDeps(io, config({ api: API }), api),
    );

    expect(code).toBe(0);
    expect(io.out.join("")).toContain('"bookingUrl"');
    expect(seen?.fareId).toBe("f_88_1");
    expect(String(seen?.query.tripId)).toBe("trip-abc:xyz");
    expect(String(seen?.query.searchId)).toBe("search-1");
    expect(String(seen?.query.fareOptionId)).toBe("uuid-1");
    expect(String(seen?.query.from)).toBe("SIN");
    expect(String(seen?.query.to)).toBe("BKK");
    expect(String(seen?.query.fromDate)).toBe("2026-08-01");
    expect(String(seen?.query.toDate)).toBe("2026-08-08");
    expect(String(seen?.query.cabin)).toBe("business");
    expect(String(seen?.query.adults)).toBe("2");
    expect(String(seen?.query.children)).toBe("1");
    expect(String(seen?.query.infants)).toBe("1");
    expect(String(seen?.query.siteCode)).toBe("SG");
    expect(String(seen?.query.currency)).toBe("USD");
    expect(String(seen?.query.locale)).toBe("en");
    expect(String(seen?.query.fromCity)).toBe("true");
    expect(String(seen?.query.toCity)).toBe("true");
  });

  it("share: maps positionals and every flag to the query and prints { searchUrl, expires }", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    let seen: { fareId: string; query: Record<string, unknown> } | undefined;
    const api = faresApi(["tok-1"], { capture: (call) => (seen = call) });
    const io = sink();

    const code = await run(
      wego(
        "flights",
        "share",
        "SIN",
        "BKK",
        "2026-09-15",
        "--return",
        "2026-09-22",
        "--cabin",
        "business",
        "--adults",
        "2",
        "--children",
        "1",
        "--infants",
        "1",
        "--site",
        "SG",
        "--currency",
        "USD",
        "--locale",
        "en",
        "--from-city",
        "--to-city",
      ),
      runDeps(io, config({ api: API }), api),
    );

    expect(code).toBe(0);
    expect(io.out.join("")).toContain('"searchUrl"');
    // `expires: false` reaches the agent — the whole point of the pair (#1326 Q5).
    expect(io.out.join("")).toContain('"expires"');
    // What this command owns is the argv -> params mapping. The wire KEYS those
    // params land under are `api.ts`'s job, asserted in `api.test.ts`
    // ("fetchSearchLink puts the whole search context on the wire").
    expect(seen?.query).toEqual({
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
    });
    // `toEqual` is exhaustive, so it already proves no search-scoped id rides along -
    // which the `SearchLinkParams` Omit also forbids at the type level.
  });

  it("share: inherits the stored currency, locale and market (issue #1386)", async () => {
    // The share URL carries all three, and it is DURABLE: a link built in the
    // API's USD hands the wrong currency to everyone it reaches, not once.
    await saveCredentials(credPath, { accessToken: "tok-1", market: "AE" });
    let seen: { fareId: string; query: Record<string, unknown> } | undefined;
    const api = faresApi(["tok-1"], { capture: (call) => (seen = call) });
    const code = await run(
      wego("flights", "share", "SIN", "BKK", "2026-09-15"),
      runDeps(sink(), config({ api: API }), api, {
        currency: "SAR",
        locale: "ar",
        site: "SA",
      }),
    );
    expect(code).toBe(0);
    expect(seen?.query).toMatchObject({
      currency: "SAR",
      locale: "ar",
      // The stored site beats the account market (AE), same rung order as search.
      siteCode: "SA",
    });
  });

  it("share: an explicit flag still beats the stored setting", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    let seen: { fareId: string; query: Record<string, unknown> } | undefined;
    const api = faresApi(["tok-1"], { capture: (call) => (seen = call) });
    const code = await run(
      wego(
        "flights",
        "share",
        "SIN",
        "BKK",
        "2026-09-15",
        "--currency",
        "USD",
        "--site",
        "SG",
      ),
      runDeps(sink(), config({ api: API }), api, {
        currency: "SAR",
        site: "SA",
      }),
    );
    expect(code).toBe(0);
    expect(seen?.query).toMatchObject({ currency: "USD", siteCode: "SG" });
  });

  it("share: a missing positional is a usage error BEFORE any network call", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    let hits = 0;
    const api = faresApi(["tok-1"], { capture: () => (hits += 1) });
    const io = sink();

    for (const args of [
      ["flights", "share"],
      ["flights", "share", "SIN"],
      ["flights", "share", "SIN", "BKK"],
    ]) {
      const code = await run(
        wego(...args),
        runDeps(io, config({ api: API }), api),
      );
      expect(code, args.join(" ")).toBe(2);
    }
    expect(hits).toBe(0);
  });

  it("share: an unknown flag and a fourth positional are usage errors", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    let hits = 0;
    const api = faresApi(["tok-1"], { capture: () => (hits += 1) });
    const io = sink();

    for (const args of [
      ["flights", "share", "SIN", "BKK", "2026-09-15", "--trip", "abc:TR1"],
      ["flights", "share", "SIN", "BKK", "2026-09-15", "extra"],
    ]) {
      const code = await run(
        wego(...args),
        runDeps(io, config({ api: API }), api),
      );
      expect(code, args.join(" ")).toBe(2);
    }
    expect(hits).toBe(0);
  });

  it("share: an out-of-range pax count is rejected client-side, costing no request", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    let hits = 0;
    const api = faresApi(["tok-1"], { capture: () => (hits += 1) });
    const io = sink();

    // Both ends of every published cap (apps/api linkContextShape: adults 1-9,
    // children 0-8, infants 0-8), so a one-sided bound cannot pass.
    for (const flags of [
      ["--adults", "0"],
      ["--adults", "10"],
      ["--children", "-1"],
      ["--children", "9"],
      ["--infants", "-1"],
      ["--infants", "9"],
    ]) {
      const code = await run(
        wego("flights", "share", "SIN", "BKK", "2026-09-15", ...flags),
        runDeps(io, config({ api: API }), api),
      );
      expect(code, flags.join(" ")).toBe(2);
    }
    expect(hits).toBe(0);
  });

  it("share: more infants than adults is rejected client-side, resolved defaults included", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    let hits = 0;
    const api = faresApi(["tok-1"], { capture: () => (hits += 1) });
    const io = sink();

    // The second case omits --adults: the API still resolves it to 1, so the
    // cross-field rule has to read the defaulted count, not just the flags.
    for (const flags of [
      ["--adults", "1", "--infants", "2"],
      ["--infants", "2"],
    ]) {
      const code = await run(
        wego("flights", "share", "SIN", "BKK", "2026-09-15", ...flags),
        runDeps(io, config({ api: API }), api),
      );
      expect(code, flags.join(" ")).toBe(2);
    }
    expect(hits).toBe(0);
  });

  it("share: an unknown --cabin is rejected client-side, costing no request", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    let hits = 0;
    const api = faresApi(["tok-1"], { capture: () => (hits += 1) });
    const io = sink();

    const code = await run(
      wego("flights", "share", "SIN", "BKK", "2026-09-15", "--cabin", "coach"),
      runDeps(io, config({ api: API }), api),
    );

    expect(code).toBe(2);
    expect(io.err.join("")).toContain("--cabin must be one of");
    expect(hits).toBe(0);
  });

  it("share: every published cabin is accepted", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    const api = faresApi(["tok-1"]);
    const io = sink();

    for (const cabin of ["economy", "premium_economy", "business", "first"]) {
      const code = await run(
        wego("flights", "share", "SIN", "BKK", "2026-09-15", "--cabin", cabin),
        runDeps(io, config({ api: API }), api),
      );
      expect(code, cabin).toBe(0);
    }
  });

  it("share: a date that is not a real calendar day is a usage error, costing no request", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    let hits = 0;
    const api = faresApi(["tok-1"], { capture: () => (hits += 1) });
    const io = sink();

    // The command's other malformed inputs are all exit 2; a date was the one that
    // reached the route and came back as a 400 the caller reads as exit 6. Only the
    // SHAPE is checked here - past and beyond-horizon stay the route's call, since
    // they depend on the server's clock.
    for (const args of [
      ["SIN", "BKK", "15-09-2026"],
      ["SIN", "BKK", "2026-02-30"],
      ["SIN", "BKK", "2026-09-15", "--return", "2026-13-01"],
      ["SIN", "BKK", "2026-09-15", "--return", "nope"],
    ]) {
      const code = await run(
        wego("flights", "share", ...args),
        runDeps(io, config({ api: API }), api),
      );
      expect(code, args.join(" ")).toBe(2);
    }
    expect(hits).toBe(0);
  });

  it("share: `--help` prints usage on stdout with exit 0", async () => {
    const io = sink();
    const code = await run(
      wego("flights", "share", "--help"),
      runDeps(io, config({ api: "http://unused.invalid" })),
    );
    expect(code).toBe(0);
    expect(io.out.join("")).toContain("flights share");
    expect(io.err.join("")).toBe("");
  });

  it("booking-link: missing required flags → usage error BEFORE any network call", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    let hits = 0;
    const api = faresApi(["tok-1"], { capture: () => (hits += 1) });
    const io = sink();

    // No --trip/--from/--to/--date.
    const code = await run(
      wego("flights", "booking-link", "f_88_1"),
      runDeps(io, config({ api: API }), api),
    );

    expect(code).toBe(2); // usage error
    expect(io.err.join("")).toMatch(/--trip is required|Usage/);
    expect(hits).toBe(0);
  });

  it("booking-link: missing --fare-option → usage error BEFORE any network call", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    let hits = 0;
    const api = faresApi(["tok-1"], { capture: () => (hits += 1) });
    const io = sink();

    // Every flag EXCEPT --fare-option: a Book-on-Wego link without a selected
    // branded fare dead-ends at "Fare is no longer available", so the CLI must
    // refuse client-side rather than emit an uncheckoutable link.
    const code = await run(
      wego(
        "flights",
        "booking-link",
        "f_88_1",
        "--trip",
        "trip-1",
        "--from",
        "SIN",
        "--to",
        "BKK",
        "--date",
        "2026-08-01",
      ),
      runDeps(io, config({ api: API }), api),
    );

    expect(code).toBe(2); // usage error
    expect(io.err.join("")).toMatch(/--fare-option is required/);
    expect(io.err.join("")).toContain("wego flights fares");
    expect(hits).toBe(0); // refused before the booking-link request
  });

  it("booking-link: a non-calendar --date, an over-cap pax count and infants above adults are usage errors", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    let hits = 0;
    const api = faresApi(["tok-1"], { capture: () => (hits += 1) });
    const io = sink();

    // This command shared nothing with its siblings, so it carried NO upper pax
    // cap, no date-shape check, and no `infants <= adults` check at all - all three
    // now come from `applyFlightPax` and `parseIsoDate`, the one source `share` and
    // `search` read.
    for (const extra of [
      ["--date", "2026-02-30"],
      ["--date", "01-08-2026"],
      ["--date", "2026-08-01", "--adults", "10"],
      ["--date", "2026-08-01", "--children", "9"],
      ["--date", "2026-08-01", "--infants", "9"],
      ["--date", "2026-08-01", "--adults", "1", "--infants", "2"],
      ["--date", "2026-08-01", "--return", "2026-13-01"],
    ]) {
      const code = await run(
        wego(
          "flights",
          "booking-link",
          "f_88_1",
          "--trip",
          "trip-1",
          "--fare-option",
          "uuid-1",
          "--from",
          "SIN",
          "--to",
          "BKK",
          ...extra,
        ),
        runDeps(io, config({ api: API }), api),
      );
      expect(code, extra.join(" ")).toBe(2);
    }
    expect(hits).toBe(0);
  });

  it("booking-link: accepts --children 0 and --infants 0 (no-child/no-infant search)", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    let seen: { fareId: string; query: Record<string, unknown> } | undefined;
    const api = faresApi(["tok-1"], { capture: (call) => (seen = call) });
    const io = sink();

    const code = await run(
      wego(
        "flights",
        "booking-link",
        "f_88_1",
        "--trip",
        "trip-1",
        "--fare-option",
        "uuid-1",
        "--from",
        "SIN",
        "--to",
        "BKK",
        "--date",
        "2026-08-01",
        "--children",
        "0",
        "--infants",
        "0",
      ),
      runDeps(io, config({ api: API }), api),
    );

    expect(code).toBe(0);
    expect(String(seen?.query.children)).toBe("0");
    expect(String(seen?.query.infants)).toBe("0");
  });

  // --- the per-leg handoff (#1254) ------------------------------------------

  it("booking-link: --fare-option repeats and comma lists both send one id per leg", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    const forms = [
      ["--fare-option", "uuid-1", "--fare-option", "uuid-2"],
      ["--fare-option", "uuid-1,uuid-2"],
    ];
    for (const form of forms) {
      let seen: { fareId: string; query: Record<string, unknown> } | undefined;
      const api = faresApi(["tok-1"], { capture: (call) => (seen = call) });
      const code = await run(
        wego(
          "flights",
          "booking-link",
          "f_88_1",
          "--trip",
          "trip-1",
          ...form,
          "--from",
          "SIN",
          "--to",
          "BKK",
          "--date",
          "2026-08-01",
        ),
        runDeps(sink(), config({ api: API }), api),
      );
      expect(code, form.join(" ")).toBe(0);
      expect(String(seen?.query.fareOptionId), form.join(" ")).toBe(
        "uuid-1,uuid-2",
      );
    }
  });

  it("booking-link: a repeated fare option is a usage error before any network call", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    let hits = 0;
    const api = faresApi(["tok-1"], { capture: () => (hits += 1) });
    const io = sink();

    const code = await run(
      wego(
        "flights",
        "booking-link",
        "f_88_1",
        "--trip",
        "trip-1",
        "--fare-option",
        "uuid-1",
        "--fare-option",
        "uuid-1",
        "--from",
        "SIN",
        "--to",
        "BKK",
        "--date",
        "2026-08-01",
      ),
      runDeps(io, config({ api: API }), api),
    );
    expect(code).toBe(2);
    expect(io.err.join("")).toMatch(/must not repeat a fare option id/);
    expect(hits).toBe(0);
  });

  it("booking-link: a blank fare option id is a usage error, never silently dropped", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    // `splitCsv` drops empty parts, so these would otherwise under-send as one id.
    const forms = [
      ["--fare-option", "uuid-1,,uuid-2"],
      ["--fare-option", "uuid-1,"],
      ["--fare-option", ",uuid-1"],
      ["--fare-option", " "],
      ["--fare-option=uuid-1,,uuid-2"],
      ["--fare-option", "uuid-1", "--fare-option", " "],
    ];
    for (const form of forms) {
      let hits = 0;
      const api = faresApi(["tok-1"], { capture: () => (hits += 1) });
      const io = sink();
      const code = await run(
        wego(
          "flights",
          "booking-link",
          "f_88_1",
          "--trip",
          "trip-1",
          ...form,
          "--from",
          "SIN",
          "--to",
          "BKK",
          "--date",
          "2026-08-01",
        ),
        runDeps(io, config({ api: API }), api),
      );
      expect(code, form.join(" ")).toBe(2);
      expect(io.err.join(""), form.join(" ")).toMatch(/blank fare option id/);
      expect(hits, form.join(" ")).toBe(0);
    }
  });

  it("booking-link: an absent --fare-option still reports required, not blank", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    const io = sink();
    const code = await run(
      wego(
        "flights",
        "booking-link",
        "f_88_1",
        "--trip",
        "trip-1",
        "--from",
        "SIN",
        "--to",
        "BKK",
        "--date",
        "2026-08-01",
      ),
      runDeps(io, config({ api: API }), faresApi(["tok-1"])),
    );
    expect(code).toBe(2);
    expect(io.err.join("")).toMatch(/--fare-option is required/);
  });

  it("unknown/missing subcommand → usage error", async () => {
    const io = sink();
    expect(await run(wego("flights", "nope"), runDeps(io, config()))).toBe(2);
    expect(io.err.join("")).toMatch(/Unknown flights sub-command/);

    const io2 = sink();
    expect(await run(wego("flights"), runDeps(io2, config()))).toBe(2);
    expect(io2.err.join("")).toMatch(/Usage/);
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

// --- flights help: -h/--help/help short-circuit (issue #1119) --------------
//
// Before the fix, every level below the root treated `--help`/`-h` as an
// unknown sub-command/option: usage went to STDERR with exit 1 (an "Unknown
// flights sub-command: --help" / "Unknown option: --help" error), breaking
// help discovery and any automation that treats a nonzero exit as failure.
// These are golden tests: they pin the FIXED behavior (stdout, exit 0, empty
// stderr, no network call) for every flights command node, plus a negative
// case per level proving a genuinely unknown sub-command/option is still a
// real error (stderr, exit 1) — `--help` is special-cased, not silently
// tolerant of anything.
describe("flights help: -h/--help/help short-circuit (issue #1119)", () => {
  function flightsDeps(io: ReturnType<typeof sink>): FlightsDeps {
    return {
      log: io.log,
      error: io.error,
      loadCredentials,
      saveCredentials,
      refreshTokens,
      loadSettings: async () => ({}),
      recordAuthFailure: async () => {},
      createFlightSearch,
      fetchFlightResults,
      fetchFlightTrip,
      fetchTripExperience,
      fetchFareOptions,
      fetchBookingLink,
      fetchSearchLink,
      // Help short-circuits before any settle, so a no-op sleep suffices.
      sleep: () => Promise.resolve(),
    };
  }
  // An unreachable API host: were the fix to regress and `--help` fall through
  // to a real sub-command's network call, these tests would see it as a
  // connection failure (wrong exit code/stderr) rather than silently passing —
  // that's the "no network dependency" assertion for this matrix.
  const noNetwork = () => config({ api: "http://127.0.0.1:1" });

  for (const help of ["-h", "--help", "help"]) {
    it(`flights ${help}: prints the group usage to stdout, exit 0, empty stderr`, async () => {
      const io = sink();
      const code = await flights(noNetwork(), [help], flightsDeps(io));
      expect(code).toBe(0);
      const printed = io.out.join("\n");
      expect(printed).toMatch(/^Usage: wego flights/);
      expect(printed).toMatch(/^ {2}search /m);
      expect(printed).toMatch(/^ {2}booking-link /m);
      expect(io.err.length).toBe(0);
    });
  }

  // Every leaf is exercised with all three help tokens — bare `help`, `-h`, and
  // `--help` — so a leaf can never regress to recognizing only the dash forms
  // while the group dispatcher accepts bare `help` (the #1119 leaf-level bug).
  const leaves = [
    "search",
    "results",
    "trip",
    "experience",
    "fares",
    "booking-link",
  ];
  for (const sub of leaves) {
    for (const help of ["help", "--help", "-h"]) {
      it(`flights ${sub} ${help}: prints that command's usage to stdout, exit 0, empty stderr, no network call`, async () => {
        const io = sink();
        const code = await flights(noNetwork(), [sub, help], flightsDeps(io));
        expect(code).toBe(0);
        expect(io.out.join("\n")).toContain(`Usage: wego flights ${sub}`);
        expect(io.err.length).toBe(0);
      });
    }
  }

  it("negative: a genuinely unknown flights sub-command exits 2 (usage) on stderr", async () => {
    const io = sink();
    const code = await flights(noNetwork(), ["bogus"], flightsDeps(io));
    expect(code).toBe(2); // usage: bad sub-command, before any network call
    expect(io.out.length).toBe(0);
    expect(io.err.join("\n")).toMatch(/Unknown flights sub-command: bogus/);
  });

  it("negative: a genuinely unknown leaf option exits 2 (usage) on stderr (not confused with --help)", async () => {
    const io = sink();
    const code = await flights(
      noNetwork(),
      ["results", "--bogus"],
      flightsDeps(io),
    );
    expect(code).toBe(2); // usage: bad option, before any network call
    expect(io.out.length).toBe(0);
    expect(io.err.join("\n")).toMatch(/Unknown option: --bogus/);
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

describe("feedback command", () => {
  const deps = (
    io: ReturnType<typeof sink>,
    api: ReturnType<typeof feedbackApi>,
  ) => ({
    ...io,
    loadCredentials,
    saveCredentials,
    refreshTokens,
    loadSettings: async () => ({}),
    recordAuthFailure: async () => {},
    sendFeedback: api,
    version: "9.9.9",
  });

  it("sends feedback and prints a confirmation, stamping the CLI version", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    let body: Record<string, unknown> | undefined;
    const api = feedbackApi(["tok-1"], (b) => {
      body = b;
    });
    const io = sink();

    const code = await feedback(
      config({ api: API }),
      ["--rating", "5", "--category", "flights", "--message", "nice"],
      deps(io, api),
    );

    expect(code).toBe(0);
    expect(io.out.join("")).toContain("Thanks");
    expect(body).toEqual({
      rating: 5,
      category: "flights",
      message: "nice",
      version: "9.9.9",
    });
  });

  it("prints scoped usage on --help (exit 0)", async () => {
    const io = sink();
    const code = await feedback(
      config(),
      ["--help"],
      deps(io, feedbackApi([])),
    );
    expect(code).toBe(0);
    expect(io.out.join("")).toContain("feedback");
  });

  it("returns a usage error (exit 2) on a malformed submission", async () => {
    const io = sink();
    const code = await feedback(
      config(),
      ["--rating", "9"],
      deps(io, feedbackApi([])),
    );
    expect(code).toBe(2);
    expect(io.err.join("")).toContain("--rating");
  });

  it("recovers from a 401 by refreshing once and retrying the submission", async () => {
    await saveCredentials(credPath, {
      accessToken: "stale",
      refreshToken: "rt",
    });
    const as = authServer(() => Response.json({ access_token: "fresh" }));
    let body: Record<string, unknown> | undefined;
    const api = feedbackApi(["fresh"], (b) => {
      body = b;
    }); // "stale" → 401 drives the reactive refresh
    const io = sink();

    const code = await feedback(
      config({ as: as.url, api: API }),
      ["--rating", "5"],
      deps(io, api),
    );

    expect(code).toBe(0);
    expect(body).toMatchObject({ rating: 5 });
    // The refreshed access token is persisted; the refresh token is preserved.
    expect(await readStored()).toMatchObject({
      accessToken: "fresh",
      refreshToken: "rt",
    });
  });

  it("exits 3 (auth) on a persistent 401 with no refresh token", async () => {
    await saveCredentials(credPath, { accessToken: "stale" });
    const api = feedbackApi([]); // always 401
    const io = sink();

    const code = await feedback(
      config({ api: API }),
      ["--rating", "5"],
      deps(io, api),
    );

    expect(code).toBe(3);
    expect(io.err.join("")).toBeTruthy();
  });

  it("exits 3 (auth) when not logged in", async () => {
    const io = sink();
    const code = await feedback(
      config(),
      ["--rating", "5"],
      deps(io, feedbackApi([])),
    );
    expect(code).toBe(3);
    expect(io.err.join("")).toMatch(/login/);
  });

  it("exits 7 (network) when the api host is unreachable", async () => {
    await saveCredentials(credPath, { accessToken: "tok-1" });
    const io = sink();
    // The api call fails the way `api.ts` reports an unreachable host: a typed
    // `ApiUnreachableError`, which is what the command layer classifies.
    const unreachable = (() => {
      throw new ApiUnreachableError("http://127.0.0.1:1", new Error("refused"));
    }) as ReturnType<typeof feedbackApi>;
    const code = await feedback(
      config({ api: "http://127.0.0.1:1" }),
      ["--rating", "5"],
      deps(io, unreachable),
    );
    expect(code).toBe(7);
    expect(io.err.join("")).toMatch(/reach/i);
  });
});

/** An id_token whose `exp` is at `expiredAt`, for the carry-forward rules. */
function idTokenExpiring(expiredAtMs: number): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(expiredAtMs / 1000) }),
  ).toString("base64url");
  return `h.${payload}.s`;
}
