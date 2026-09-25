import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildTargetReport, formatTargetReport } from "./commands";
import { CLI_ENV_VARS, loadCliConfig, resolveConfigScope } from "./config";
import { EXIT } from "./error-report";
import {
  DEFAULT_TARGET,
  isProdTarget,
  parseTarget,
  resolveTarget,
  stripTargetFlag,
  TARGETS,
  targetConfigScope,
  targetEndpointOverrides,
} from "./target";
import { maybeSendTelemetry, type TelemetryDeps } from "./telemetry";

/**
 * One build can point at a different backend at run time, prod unless told
 * otherwise, and a non-prod run is both visible and sends no telemetry. A prod
 * build's baked config is what every bundle assertion starts from, because a
 * published binary must need no rebuild to be retargeted.
 *
 * Two mutations, and where each one is caught:
 *
 *  - staging as the default: "prod when nothing says otherwise" and "prod is
 *    the default in a loaded config" both fail.
 *  - removing the telemetry condition: "a staging run sends nothing" fails,
 *    and "a prod run does send" keeps it from passing vacuously.
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
 *  credentials path is assertable, and argv passed explicitly, never
 *  `process.argv`, which under `bun test` carries the test runner's own flags. */
function config(over: { argv?: string[]; env?: Record<string, string> } = {}) {
  return loadCliConfig(
    { XDG_CONFIG_HOME: "/tmp/xdg", ...over.env } as NodeJS.ProcessEnv,
    PROD_BUILD,
    over.argv ?? argv("whoami"),
  );
}

describe("the target axis", () => {
  it("is exactly prod and staging", () => {
    expect([...TARGETS]).toEqual(["prod", "staging"]);
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
    expect(resolveTarget(argv("--target=staging"), undefined).target).toBe(
      "staging",
    );
    // A global switch, so it must work after the subcommand too: that is where
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
    // A silent fallback would send a tester's traffic to production.
    expect(() => resolveTarget(argv("--target", "stagng"), undefined)).toThrow(
      /--target must be one of prod\|staging; got "stagng"/,
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
    expect(
      stripTargetFlag(argv("places", "--target=staging", "dubai")),
    ).toEqual(argv("places", "dubai"));
    expect(stripTargetFlag(argv("places", "dubai"))).toEqual(
      argv("places", "dubai"),
    );
    // The separated form spans two entries. A value identical to a real
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
    // This build baked prod endpoints only; naming staging still moves
    // authorize, token and api together.
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
    expect(targetEndpointOverrides("prod")).toEqual({});
    const c = config({ env: { WEGO_API_URL: "https://api.localhost" } });
    expect(c.apiBaseUrl).toBe("https://api.localhost");
  });

  it("reaches an API on this machine through WEGO_API_URL, with no target of its own", () => {
    // The shapes a developer actually has: the plain `bun dev` port, portless's
    // `api.localhost`, and a linked worktree's branch-prefixed name under the
    // same suffix, over plaintext `http`.
    for (const url of [
      "http://localhost:3001",
      "http://127.0.0.1:4321",
      "http://api.localhost",
      "http://rung2-api.localhost",
      "https://api.localhost",
    ]) {
      expect(config({ env: { WEGO_API_URL: url } }).apiBaseUrl).toBe(url);
    }
  });

  it("lets staging impose its own API URL over an ambient WEGO_API_URL", () => {
    expect(
      config({
        argv: argv("--target", "staging"),
        env: { WEGO_API_URL: "https://api.wego.com" },
      }).apiBaseUrl,
    ).toBe(STAGING_API_URL);
  });

  it("agrees with .env.local.example about the staging endpoints", () => {
    // Two copies of a public literal, so a test keeps them in sync.
    const example = readFileSync(
      join(import.meta.dir, "..", ".env.local.example"),
      "utf8",
    );
    const declared = (key: string): string | undefined =>
      example.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim();
    const staging = targetEndpointOverrides("staging");
    expect(declared("WEGO_AUTH_AUTHORIZE_URL")).toBe(staging.authorizeUrl);
    expect(declared("WEGO_AUTH_TOKEN_URL")).toBe(staging.tokenUrl);
  });

  it("declares WEGO_TARGET as a recognized config var", () => {
    expect(CLI_ENV_VARS).toContain("WEGO_TARGET");
  });
});

// --- visibility -------------------------------------------------------------
describe("a non-prod target is visible", () => {
  // What `wego info target` prints, and that stdout stays one JSON object with or
  // without --json, is `integration/target.test.ts`, which runs the binary. The
  // report it renders is built here.
  it("reports a staging run with every resolved endpoint", () => {
    expect(
      buildTargetReport(config({ env: { WEGO_TARGET: "staging" } })),
    ).toEqual({
      target: "staging",
      source: "env",
      apiUrl: STAGING_API_URL,
      authorizeUrl: `https://${STAGING_AUTH_HOST}/user-auth/v2/users/oauth/authorize`,
      tokenUrl: `https://${STAGING_AUTH_HOST}/user-auth/v2/users/oauth/token`,
      credentialsPath: `/tmp/xdg/wego/${STAGING_AUTH_HOST}/credentials.json`,
      telemetrySuppressed: true,
    });
  });

  it("renders the target, its origin and the endpoints for a reader", () => {
    const text = formatTargetReport(
      buildTargetReport(config({ argv: argv("--target", "staging") })),
    );
    expect(text).toContain("staging");
    expect(text).toContain("--target");
    expect(text).toContain(STAGING_API_URL);
    expect(text).toContain(STAGING_AUTH_HOST);
    // A reader is told that telemetry is off for this target.
    expect(text).toContain("suppressed");
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

  it("keys by the issuer, not the API host, so one login serves both", () => {
    // A local `apps/api` verifies staging tokens, so an install pointed at it
    // with WEGO_API_URL must keep reading the store staging issued into.
    expect(
      config({
        argv: argv("--target", "staging"),
        env: { WEGO_API_URL: "http://localhost:3001" },
      }).credentialsPath,
    ).toBe(config({ argv: argv("--target", "staging") }).credentialsPath);
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
