import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildTargetReport,
  formatTargetReport,
  type InfoDeps,
  info,
} from "./commands";
import { CLI_ENV_VARS, loadCliConfig, resolveConfigScope } from "./config";
import { EXIT } from "./error-report";
import {
  DEFAULT_TARGET,
  isProdTarget,
  LOCAL_API_URL_FALLBACK,
  parseTarget,
  resolveTarget,
  stripTargetFlag,
  TARGETS,
  targetConfigScope,
  targetEndpointOverrides,
} from "./target";
import { maybeSendTelemetry, type TelemetryDeps } from "./telemetry";

/**
 * The **target** axis — the acceptance test for foundations#74 rung 2.
 *
 * The rung's claim, in one sentence: *one* build can point at a different backend
 * at run time, prod unless told otherwise, and a non-prod run is both visible and
 * silent. Everything ring-shaped above it (rungs 3-7) assumes that a published
 * binary needs no rebuild to be retargeted, so this suite tests the premise
 * rather than the plumbing: a **prod** build's baked config is what every bundle
 * assertion starts from.
 *
 * Two mutations the ladder names explicitly, and where each one dies:
 *
 *  - **staging as the default** → "prod when nothing says otherwise" and "prod is
 *    the default in a loaded config" both fail.
 *  - **removing the telemetry condition** → "a staging run sends nothing" and its
 *    `local` twin fail, and "a prod run does send" is the guard that keeps them
 *    from passing vacuously.
 *
 * `apps/cli/live/target.ts` resolves the same three names for the tier-C harness
 * and deliberately defaults to `local` — a harness with no argument should not
 * reach production. The product default is the opposite, for the same reason.
 */

/** A prod release's baked bundle. Deliberately carries NO staging values: the
 *  point is that this binary can still reach staging. */
const PROD_BUILD = {
  authorizeUrl: "https://auth.wego.com/user-auth/v2/users/oauth/authorize",
  tokenUrl: "https://auth.wego.com/user-auth/v2/users/oauth/token",
  apiBaseUrl: "https://api.wego.com",
  clientId: "public-pkce-client",
  flavor: "wego",
};

const STAGING_AUTH_HOST = "auth.wegostaging.com";
const STAGING_API_URL = "https://api.wegostaging.com";

/** `process.argv` shape: [runtime, script, ...user args]. */
function argv(...args: string[]): string[] {
  return ["bun", "wego", ...args];
}

/** A config as a real run would build it: baked prod bundle, an XDG root so the
 *  credentials path is assertable, and argv passed explicitly — never
 *  `process.argv`, which under `bun test` carries the test runner's own flags. */
function config(over: { argv?: string[]; env?: Record<string, string> } = {}) {
  return loadCliConfig(
    { XDG_CONFIG_HOME: "/tmp/xdg", ...over.env } as NodeJS.ProcessEnv,
    PROD_BUILD,
    over.argv ?? argv("whoami"),
  );
}

describe("the target axis", () => {
  it("is exactly prod, staging and local", () => {
    expect([...TARGETS]).toEqual(["prod", "staging", "local"]);
  });

  it("is prod when nothing says otherwise", () => {
    expect(DEFAULT_TARGET).toBe("prod");
    expect(resolveTarget([], undefined)).toEqual({
      target: "prod",
      source: "default",
    });
  });

  it("reads --target and --target= anywhere in argv", () => {
    expect(resolveTarget(argv("--target", "staging"), undefined).target).toBe(
      "staging",
    );
    expect(resolveTarget(argv("--target=local"), undefined).target).toBe(
      "local",
    );
    // A global switch, so it must work after the subcommand too — that is where
    // a person actually types it.
    expect(
      resolveTarget(argv("flights", "search", "--target", "staging"), undefined)
        .target,
    ).toBe("staging");
  });

  it("reads WEGO_TARGET, and the flag wins over it", () => {
    expect(resolveTarget([], "staging")).toEqual({
      target: "staging",
      source: "env",
    });
    expect(resolveTarget(argv("--target", "prod"), "staging")).toEqual({
      target: "prod",
      source: "flag",
    });
  });

  it("treats an empty or whitespace value as saying nothing", () => {
    expect(resolveTarget([], "").source).toBe("default");
    expect(resolveTarget([], "   ").source).toBe("default");
  });

  it("accepts any casing", () => {
    expect(resolveTarget([], "STAGING").target).toBe("staging");
  });

  it("refuses an unknown value rather than falling back to prod", () => {
    // The whole point of the axis: a typo must be loud. A silent fallback would
    // send a tester's traffic to production.
    expect(() => resolveTarget(argv("--target", "stagng"), undefined)).toThrow(
      /--target must be one of prod\|staging\|local; got "stagng"/,
    );
    expect(() => resolveTarget([], "produciton")).toThrow(/WEGO_TARGET/);
    expect(() => parseTarget("nope", "--target")).toThrow(/nope/);
  });

  it("refuses a --target with no value", () => {
    expect(() => resolveTarget(argv("--target"), undefined)).toThrow(
      /--target must be one of/,
    );
  });

  it("strips the flag so no command parser sees it", () => {
    expect(
      stripTargetFlag(argv("places", "--target", "staging", "dubai")),
    ).toEqual(argv("places", "dubai"));
    expect(stripTargetFlag(argv("places", "--target=local", "dubai"))).toEqual(
      argv("places", "dubai"),
    );
    expect(stripTargetFlag(argv("places", "dubai"))).toEqual(
      argv("places", "dubai"),
    );
    // The separated form spans two entries, so the drop has to carry one bit to
    // the next iteration. These isolate that bit: a value identical to a real
    // positional must lose only the one after the flag, and a flag at the very
    // end of argv has no value to drop.
    expect(
      stripTargetFlag(argv("places", "--target", "staging", "staging")),
    ).toEqual(argv("places", "staging"));
    expect(stripTargetFlag(argv("places", "dubai", "--target"))).toEqual(
      argv("places", "dubai"),
    );
  });

  it("classifies only prod as prod", () => {
    expect(isProdTarget("prod")).toBe(true);
    expect(isProdTarget("staging")).toBe(false);
    expect(isProdTarget("local")).toBe(false);
  });
});

describe("one binary, every backend", () => {
  it("is prod by default in a loaded config", () => {
    const c = config();
    expect(c.target).toBe("prod");
    expect(c.targetSource).toBe("default");
    expect(c.apiBaseUrl).toBe(PROD_BUILD.apiBaseUrl);
    expect(c.authorizeUrl).toBe(PROD_BUILD.authorizeUrl);
  });

  it("swaps the whole auth bundle on a PROD build, with no rebuild", () => {
    // The rung's premise. This build baked prod endpoints only; naming staging
    // still moves authorize, token AND api together.
    const c = config({ argv: argv("--target", "staging", "whoami") });
    expect(c.target).toBe("staging");
    expect(new URL(c.authorizeUrl).host).toBe(STAGING_AUTH_HOST);
    expect(new URL(c.tokenUrl).host).toBe(STAGING_AUTH_HOST);
    expect(c.apiBaseUrl).toBe(STAGING_API_URL);
  });

  it("never swaps the client_id, which is one literal in both environments", () => {
    for (const target of TARGETS) {
      expect(config({ argv: argv("--target", target) }).clientId).toBe(
        PROD_BUILD.clientId,
      );
    }
  });

  it("lets a named target beat an ambient WEGO_API_URL", () => {
    // A developer's `.env.local` points at a local API. `--target staging` has to
    // mean staging, or the switch is a no-op for exactly the people who need it.
    const c = config({
      argv: argv("--target", "staging"),
      env: { WEGO_API_URL: "https://api.localhost" },
    });
    expect(c.apiBaseUrl).toBe(STAGING_API_URL);
  });

  it("imposes nothing on prod, so the existing precedence is untouched", () => {
    expect(targetEndpointOverrides("prod", undefined)).toEqual({});
    const c = config({ env: { WEGO_API_URL: "https://api.localhost" } });
    expect(c.apiBaseUrl).toBe("https://api.localhost");
  });

  it("points local at this machine, authenticated against staging", () => {
    const bare = config({ argv: argv("--target", "local") });
    expect(bare.apiBaseUrl).toBe(LOCAL_API_URL_FALLBACK);
    expect(new URL(bare.authorizeUrl).host).toBe(STAGING_AUTH_HOST);
    // Portless names the URL per worktree, so it cannot be a literal: for
    // `local` alone, the env var is the authority.
    const named = config({
      argv: argv("--target", "local"),
      env: { WEGO_API_URL: "https://api.localhost" },
    });
    expect(named.apiBaseUrl).toBe("https://api.localhost");
    // A branch-prefixed portless name is the same case.
    expect(
      config({
        argv: argv("--target", "local"),
        env: { WEGO_API_URL: "https://rung2-api.localhost" },
      }).apiBaseUrl,
    ).toBe("https://rung2-api.localhost");
    // And a plain loopback port, which is what `bun dev` and the tier-C harness
    // actually hand it.
    expect(
      config({
        argv: argv("--target", "local"),
        env: { WEGO_API_URL: "http://127.0.0.1:4321" },
      }).apiBaseUrl,
    ).toBe("http://127.0.0.1:4321");
  });

  it("refuses a local target whose WEGO_API_URL is not on this machine", () => {
    // Found by smoke-testing the real binary: adopting the ambient value made
    // `--target local` print `local` while pointing at api.wego.com. Refusing is
    // the only answer that neither lies nor silently retargets.
    expect(() =>
      config({
        argv: argv("--target", "local"),
        env: { WEGO_API_URL: "https://api.wego.com" },
      }),
    ).toThrow(/not a host on this machine/);
    expect(() =>
      targetEndpointOverrides("local", "https://api.wego.com"),
    ).toThrow(/--target local/);
    // Staging is unaffected: it imposes its own API URL, so there is nothing to
    // contradict.
    expect(
      config({
        argv: argv("--target", "staging"),
        env: { WEGO_API_URL: "https://api.wego.com" },
      }).apiBaseUrl,
    ).toBe(STAGING_API_URL);
  });

  it("agrees with .env.local.example about the staging endpoints", () => {
    // Two copies of a public literal, so they get a guard rather than a promise.
    const example = readFileSync(
      join(import.meta.dir, "..", ".env.local.example"),
      "utf8",
    );
    const declared = (key: string): string | undefined =>
      example.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim();
    const staging = targetEndpointOverrides("staging", undefined);
    expect(declared("WEGO_AUTH_AUTHORIZE_URL")).toBe(staging.authorizeUrl);
    expect(declared("WEGO_AUTH_TOKEN_URL")).toBe(staging.tokenUrl);
  });

  it("declares WEGO_TARGET as a recognized config var", () => {
    expect(CLI_ENV_VARS).toContain("WEGO_TARGET");
  });
});

// --- visibility -------------------------------------------------------------

/** `info target` reads nothing and calls nothing, so every dep it must not touch
 *  throws if it does. */
function infoDeps(): InfoDeps & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const unreachable = (name: string) => async () => {
    throw new Error(`info target must not call ${name}`);
  };
  return {
    out,
    err,
    log: (m) => out.push(m),
    error: (m) => err.push(m),
    loadCredentials: unreachable("loadCredentials") as never,
    saveCredentials: unreachable("saveCredentials") as never,
    refreshTokens: unreachable("refreshTokens") as never,
    loadSettings: unreachable("loadSettings") as never,
    recordAuthFailure: unreachable("recordAuthFailure") as never,
    fetchHolidays: unreachable("fetchHolidays") as never,
    fetchVisaFree: unreachable("fetchVisaFree") as never,
    fetchSchedules: unreachable("fetchSchedules") as never,
    fetchNearbyPlaces: unreachable("fetchNearbyPlaces") as never,
  };
}

describe("a non-prod target is visible", () => {
  it("names the target, its origin and the resolved endpoints for a reader", async () => {
    const deps = infoDeps();
    const code = await info(
      config({ argv: argv("--target", "staging") }),
      ["target"],
      deps,
    );
    expect(code).toBe(0);
    // The readable rendering is on STDERR, where every other human line in this
    // CLI goes; stdout is the JSON contract (asserted below).
    const text = deps.err.join("\n");
    expect(text).toContain("staging");
    expect(text).toContain("--target");
    expect(text).toContain(STAGING_API_URL);
    expect(text).toContain(STAGING_AUTH_HOST);
    // The promise the axis makes, written down where a person reads it.
    expect(text).toContain("suppressed");
  });

  it("keeps stdout parseable as JSON with NO --json, like every info command", async () => {
    // The regression guard for a real defect this PR shipped and CodeRabbit
    // caught: the table used to go to stdout, so an agent following SKILL.md's
    // operating contract item 4 ("treat successful stdout from `info *` as
    // JSON") would JSON.parse a text table and throw. `--json` is absent here on
    // purpose - that is the case that was broken, and the case that a caller who
    // never read this flag's docs will hit.
    const deps = infoDeps();
    const code = await info(
      config({ argv: argv("--target", "staging") }),
      ["target"],
      deps,
    );
    expect(code).toBe(0);
    expect(JSON.parse(deps.out.join("\n")).target).toBe("staging");
  });

  it("prints the same stdout object with and without --json", async () => {
    // So the flag cannot drift into choosing a FORMAT: it only suppresses the
    // stderr decoration.
    const plain = infoDeps();
    const jsonOnly = infoDeps();
    const cfg = () => config({ argv: argv("--target", "staging") });
    expect(await info(cfg(), ["target"], plain)).toBe(0);
    expect(await info(cfg(), ["target", "--json"], jsonOnly)).toBe(0);
    expect(jsonOnly.out).toEqual(plain.out);
    // ...and that it really does suppress it.
    expect(jsonOnly.err).toEqual([]);
    expect(plain.err.length).toBe(1);
  });

  it("answers machine output as one JSON object", async () => {
    const deps = infoDeps();
    const code = await info(
      config({ env: { WEGO_TARGET: "staging" } }),
      ["target", "--json"],
      deps,
    );
    expect(code).toBe(0);
    expect(JSON.parse(deps.out.join("\n"))).toEqual({
      target: "staging",
      source: "env",
      apiUrl: STAGING_API_URL,
      authorizeUrl: `https://${STAGING_AUTH_HOST}/user-auth/v2/users/oauth/authorize`,
      tokenUrl: `https://${STAGING_AUTH_HOST}/user-auth/v2/users/oauth/token`,
      credentialsPath: `/tmp/xdg/wego/${STAGING_AUTH_HOST}/credentials.json`,
      telemetrySuppressed: true,
    });
  });

  it("reports a prod run as prod, and not suppressed", () => {
    const report = buildTargetReport(config());
    expect(report).toMatchObject({
      target: "prod",
      source: "default",
      apiUrl: PROD_BUILD.apiBaseUrl,
      telemetrySuppressed: false,
    });
    expect(formatTargetReport(report)).toContain("as configured");
  });

  it("prints its usage on --help and rejects an unknown argument", async () => {
    const help = infoDeps();
    expect(await info(config(), ["target", "--help"], help)).toBe(0);
    expect(help.out.join("\n")).toContain("info target");

    const bad = infoDeps();
    expect(await info(config(), ["target", "--jsn"], bad)).toBe(EXIT.USAGE);
    expect(bad.err.join("\n")).toContain("--jsn");
  });
});

// --- telemetry --------------------------------------------------------------

function telemetryDeps(
  over: Partial<TelemetryDeps> = {},
): TelemetryDeps & { sent: string[]; printed: string[] } {
  const sent: string[] = [];
  const printed: string[] = [];
  return {
    sent,
    printed,
    argv: argv("whoami"),
    exitCode: EXIT.OK,
    durationMs: 1,
    fromSource: false,
    target: "prod",
    posthogKey: "phc_test",
    env: {},
    version: "1.2.3",
    platform: "darwin",
    arch: "arm64",
    now: 0,
    loadState: async () => ({ deviceId: "device", enabled: true }),
    persistDeviceId: async () => {},
    readUid: async () => undefined,
    spawnSender: (payload) => {
      sent.push(payload);
    },
    printPayload: (payload) => {
      printed.push(payload);
    },
    randomUUID: () => "uuid",
    ...over,
  };
}

describe("a non-prod target sends no telemetry", () => {
  it("sends nothing on staging", async () => {
    const deps = telemetryDeps({ target: "staging" });
    expect(await maybeSendTelemetry(deps)).toBe("skipped-non-prod-target");
    expect(deps.sent).toEqual([]);
  });

  it("sends nothing on local", async () => {
    const deps = telemetryDeps({ target: "local" });
    expect(await maybeSendTelemetry(deps)).toBe("skipped-non-prod-target");
    expect(deps.sent).toEqual([]);
  });

  it("still sends on prod — so the two above are not vacuous", async () => {
    const deps = telemetryDeps();
    expect(await maybeSendTelemetry(deps)).toBe("sent");
    expect(deps.sent).toHaveLength(1);
  });

  it("keeps the log-mode audit on a non-prod target, and still sends nothing", async () => {
    // An opted-out or retargeted user is the likeliest to want to see the
    // payload, and printing it is not sending it.
    const deps = telemetryDeps({
      target: "staging",
      env: { WEGO_CLI_TELEMETRY: "log" },
    });
    expect(await maybeSendTelemetry(deps)).toBe("printed");
    expect(deps.sent).toEqual([]);
    expect(deps.printed).toHaveLength(1);
  });
});

// --- credentials ------------------------------------------------------------

describe("credentials keyed by the resolved host", () => {
  it("keeps the historical path on prod, so no install is logged out", () => {
    expect(config().credentialsPath).toBe("/tmp/xdg/wego/credentials.json");
    expect(targetConfigScope("wego", "prod", "")).toBe("wego");
  });

  it("keys a non-prod store by the auth host that issued the token", () => {
    const staging = config({ argv: argv("--target", "staging") });
    expect(staging.credentialsPath).toBe(
      `/tmp/xdg/wego/${STAGING_AUTH_HOST}/credentials.json`,
    );
    expect(staging.credentialsPath).not.toBe(config().credentialsPath);
  });

  it("gives staging and local one store, because one login serves both", () => {
    // Keyed by the ISSUER, not the API host: a local `apps/api` verifies staging
    // tokens, so splitting them would demand a second, pointless login.
    expect(config({ argv: argv("--target", "local") }).credentialsPath).toBe(
      config({ argv: argv("--target", "staging") }).credentialsPath,
    );
  });

  it("still lets WEGO_CREDENTIALS_PATH name the file outright", () => {
    expect(
      config({
        argv: argv("--target", "staging"),
        env: { WEGO_CREDENTIALS_PATH: "/tmp/explicit.json" },
      }).credentialsPath,
    ).toBe("/tmp/explicit.json");
  });

  it("derives the same scope without a full config", () => {
    // `index.ts` needs the path before any endpoint is required (`uninstall` runs
    // from source), so the two derivations have to agree.
    for (const target of TARGETS) {
      const scope = resolveConfigScope(
        { XDG_CONFIG_HOME: "/tmp/xdg" } as NodeJS.ProcessEnv,
        argv("--target", target),
      );
      expect(config({ argv: argv("--target", target) }).credentialsPath).toBe(
        `/tmp/xdg/${scope}/credentials.json`,
      );
    }
  });
});
