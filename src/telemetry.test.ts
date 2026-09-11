import { describe, expect, it } from "bun:test";
import { RESULTS_FLAG_TO_PARAM } from "./commands";
import { EXIT } from "./error-report";
import {
  buildTelemetryEvent,
  EPHEMERAL_DEVICE_ID,
  extractFlagNames,
  extractFlagValues,
  isTelemetrySender,
  maybeSendTelemetry,
  parseTelemetryMode,
  resolveCommand,
  resolveSubcommand,
  TELEMETRY_EVENT,
  type TelemetryDeps,
  type TelemetryEventInput,
  UNASSIGNED_DEVICE_ID,
  uidFromAccessToken,
} from "./telemetry";

/** A silent path fails open or closed with no symptom, so every guard is asserted. */

const NOW = 1_800_000_000_000;
const KEY = "phc_testkeytestkeytestkeytestkeytest";
const DEVICE = "11111111-2222-3333-4444-555555555555";

const argv = (...args: string[]) => ["/usr/local/bin/wego", "wego", ...args];

/** Default state sends, so each test flips one field. */
function deps(over: Partial<TelemetryDeps> = {}): TelemetryDeps & {
  sent: string[];
  printed: string[];
  persisted: string[];
} {
  const sent: string[] = [];
  const printed: string[] = [];
  const persisted: string[] = [];
  let uuidCount = 0;
  const base: TelemetryDeps = {
    argv: argv("whoami"),
    exitCode: EXIT.OK,
    durationMs: 42,
    fromSource: false,
    // The default is what an ordinary install runs as; the non-prod suppression
    // is asserted in `target.test.ts`, which owns that rule.
    target: "prod",
    posthogKey: KEY,
    env: {},
    version: "1.2.3",
    platform: "darwin",
    arch: "arm64",
    now: NOW,
    loadState: async () => ({ deviceId: DEVICE, enabled: true }),
    persistDeviceId: async (id) => {
      persisted.push(id);
    },
    readUid: async () => undefined,
    spawnSender: (payload) => {
      sent.push(payload);
    },
    printPayload: (payload) => {
      printed.push(payload);
    },
    randomUUID: () => `uuid-${++uuidCount}`,
    ...over,
  };
  return Object.assign(base, { sent, printed, persisted });
}

/** The properties of the single payload a sending run handed off. */
function sentProperties(d: { sent: string[] }): Record<string, unknown> {
  expect(d.sent).toHaveLength(1);
  const payload = JSON.parse(d.sent[0] as string);
  return payload.properties as Record<string, unknown>;
}

describe("maybeSendTelemetry (the send decision)", () => {
  it("sends on a baked, enabled, non-source run", async () => {
    const d = deps();
    expect(await maybeSendTelemetry(d)).toBe("sent");
    expect(d.sent).toHaveLength(1);
    expect(JSON.parse(d.sent[0] as string).event).toBe(TELEMETRY_EVENT);
  });

  it("skips in the sender itself, before any other guard", async () => {
    const d = deps({ argv: argv("send-telemetry", "{}"), fromSource: true });
    expect(await maybeSendTelemetry(d)).toBe("skipped-sender");
    expect(d.sent).toHaveLength(0);
  });

  it("skips an interrupted run", async () => {
    const d = deps({ exitCode: EXIT.SIGINT });
    expect(await maybeSendTelemetry(d)).toBe("skipped-interrupted");
    expect(d.sent).toHaveLength(0);
  });

  it("skips a from-source run even with a key in the environment", async () => {
    const d = deps({ fromSource: true });
    expect(await maybeSendTelemetry(d)).toBe("skipped-from-source");
    expect(d.sent).toHaveLength(0);
  });

  it("skips when no key is baked (a staging binary, or a pre-go-live release)", async () => {
    const d = deps({ posthogKey: undefined });
    expect(await maybeSendTelemetry(d)).toBe("skipped-unbaked");
    expect(d.sent).toHaveLength(0);
  });

  it("skips when the environment turns it off", async () => {
    const d = deps({ env: { WEGO_CLI_TELEMETRY: "0" } });
    expect(await maybeSendTelemetry(d)).toBe("skipped-opt-out");
    expect(d.sent).toHaveLength(0);
  });

  it("skips when the persisted setting turns it off", async () => {
    const d = deps({
      loadState: async () => ({ deviceId: DEVICE, enabled: false }),
    });
    expect(await maybeSendTelemetry(d)).toBe("skipped-disabled");
    expect(d.sent).toHaveLength(0);
  });

  it("writes nothing to disk on an opted-out run", async () => {
    const d = deps({
      env: { WEGO_CLI_TELEMETRY: "off" },
      loadState: async () => {
        throw new Error("state must not be read on an opted-out run");
      },
    });
    expect(await maybeSendTelemetry(d)).toBe("skipped-opt-out");
    expect(d.persisted).toHaveLength(0);
  });

  it("mints and persists a machine id on the first emitting run", async () => {
    const d = deps({ loadState: async () => ({ enabled: true }) });
    expect(await maybeSendTelemetry(d)).toBe("sent");
    expect(d.persisted).toEqual(["uuid-1"]);
    expect(sentProperties(d).device_id).toBe("uuid-1");
  });

  it("uses one stable id when the machine id cannot be stored", async () => {
    // Read-only or ephemeral $HOME (CI images, containers). A fresh uuid per run
    // would make every invocation look like a new device, forever.
    const ids: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      const d = deps({
        loadState: async () => ({ enabled: true }),
        persistDeviceId: async () => {
          throw Object.assign(new Error("EROFS"), { code: "EROFS" });
        },
      });
      expect(await maybeSendTelemetry(d)).toBe("sent");
      ids.push(sentProperties(d).device_id);
    }
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe(EPHEMERAL_DEVICE_ID);
  });

  it("still sends when the state file cannot be read at all", async () => {
    const d = deps({
      loadState: async () => {
        throw new Error("EACCES");
      },
    });
    expect(await maybeSendTelemetry(d)).toBe("sent");
  });

  it("degrades to a logged-out event when credentials are unreadable", async () => {
    const d = deps({
      readUid: async () => {
        throw new Error("EACCES");
      },
    });
    expect(await maybeSendTelemetry(d)).toBe("sent");
    const payload = JSON.parse(d.sent[0] as string);
    expect(payload.distinct_id).toBe(DEVICE);
    expect(payload.properties.$process_person_profile).toBe(false);
  });

  it("records the exit code the command actually returned", async () => {
    const d = deps({ exitCode: EXIT.USAGE });
    expect(await maybeSendTelemetry(d)).toBe("sent");
    expect(sentProperties(d).exit_code).toBe(EXIT.USAGE);
  });
});

describe("maybeSendTelemetry (log mode)", () => {
  it("prints the payload to the injected sink and sends nothing", async () => {
    const d = deps({ env: { WEGO_CLI_TELEMETRY: "log" } });
    expect(await maybeSendTelemetry(d)).toBe("printed");
    expect(d.sent).toHaveLength(0);
    expect(d.printed).toHaveLength(1);
    expect(JSON.parse(d.printed[0] as string).event).toBe(TELEMETRY_EVENT);
  });

  it("works from source and with no key baked, so a developer can audit it", async () => {
    const d = deps({
      env: { WEGO_CLI_TELEMETRY: "log" },
      fromSource: true,
      posthogKey: undefined,
    });
    expect(await maybeSendTelemetry(d)).toBe("printed");
    expect(d.printed).toHaveLength(1);
  });

  it("works while telemetry is disabled – the likeliest person to want it", async () => {
    const d = deps({
      env: { WEGO_CLI_TELEMETRY: "log" },
      loadState: async () => ({ deviceId: DEVICE, enabled: false }),
    });
    expect(await maybeSendTelemetry(d)).toBe("printed");
    expect(d.sent).toHaveLength(0);
  });

  it("creates no state file when the machine has never emitted", async () => {
    const d = deps({
      env: { WEGO_CLI_TELEMETRY: "log" },
      loadState: async () => ({ enabled: true }),
    });
    expect(await maybeSendTelemetry(d)).toBe("printed");
    expect(d.persisted).toHaveLength(0);
    expect(JSON.parse(d.printed[0] as string).properties.device_id).toBe(
      UNASSIGNED_DEVICE_ID,
    );
  });
});

describe("parseTelemetryMode", () => {
  it("reads nothing from an unset or blank value, leaving the setting to decide", () => {
    expect(parseTelemetryMode(undefined)).toBeUndefined();
    expect(parseTelemetryMode("")).toBeUndefined();
    expect(parseTelemetryMode("   ")).toBeUndefined();
  });

  it.each([
    ["0", "off"],
    ["false", "off"],
    ["off", "off"],
    ["no", "off"],
    ["1", "on"],
    ["true", "on"],
    ["on", "on"],
    ["yes", "on"],
    ["log", "log"],
    ["LOG", "log"],
    [" Off ", "off"],
  ] as const)("maps %p to %p", (raw, expected) => {
    expect(parseTelemetryMode(raw)).toBe(expected);
  });

  it("treats an unrecognized value as off, erring toward privacy", () => {
    expect(parseTelemetryMode("disabled")).toBe("off");
    expect(parseTelemetryMode("nope")).toBe("off");
  });
});

describe("isTelemetrySender", () => {
  it("matches only the hidden sender subcommand", () => {
    expect(isTelemetrySender(argv("send-telemetry", "{}"))).toBe(true);
    expect(isTelemetrySender(argv("whoami"))).toBe(false);
    expect(isTelemetrySender(argv())).toBe(false);
  });
});

describe("uidFromAccessToken", () => {
  const token = (claims: Record<string, unknown>) =>
    `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

  it("reads a numeric uid claim", () => {
    expect(uidFromAccessToken(token({ uid: 227935 }))).toBe("227935");
  });

  it("reads an all-digits string uid (the wire form)", () => {
    expect(uidFromAccessToken(token({ uid: "227935" }))).toBe("227935");
  });

  it("keeps uid 0, which is falsy but valid", () => {
    expect(uidFromAccessToken(token({ uid: 0 }))).toBe("0");
  });

  it("drops an email-shaped uid – PII must never become the person key", () => {
    expect(
      uidFromAccessToken(token({ uid: "user@example.com" })),
    ).toBeUndefined();
  });

  it("never reads sub, which is where the AS puts the email", () => {
    expect(
      uidFromAccessToken(token({ sub: "user@example.com" })),
    ).toBeUndefined();
  });

  it("returns undefined for an absent, malformed, or non-JWT token", () => {
    expect(uidFromAccessToken(undefined)).toBeUndefined();
    expect(uidFromAccessToken("")).toBeUndefined();
    expect(uidFromAccessToken("not-a-jwt")).toBeUndefined();
    expect(uidFromAccessToken("h.!!!notbase64!!!.s")).toBeUndefined();
  });
});

describe("resolveCommand", () => {
  it("passes through a known command", () => {
    expect(resolveCommand(argv("flights", "search"))).toBe("flights");
  });

  it("normalizes the help and version aliases", () => {
    for (const a of ["help", "--help", "-h"]) {
      expect(resolveCommand(argv(a))).toBe("help");
    }
    for (const a of ["version", "--version", "-v"]) {
      expect(resolveCommand(argv(a))).toBe("version");
    }
    expect(resolveCommand(argv())).toBe("help");
  });

  it("records an unknown command as `unknown`, never its text", () => {
    // A typo is harmless; a pasted secret in the command slot is not.
    expect(resolveCommand(argv("s3cret-token-abc"))).toBe("unknown");
  });

  it("records `config` by name (issue #1386), not as `unknown`", () => {
    // The allowlist is the privacy contract, so a dispatched command missing
    // from it lands in the `unknown` bucket and corrupts the command breakdown.
    expect(resolveCommand(argv("config"))).toBe("config");
  });
});

describe("resolveSubcommand", () => {
  it("resolves an allowlisted subcommand", () => {
    expect(resolveSubcommand("flights", ["search", "SIN", "BKK"])).toBe(
      "search",
    );
    expect(resolveSubcommand("hotels", ["rooms", "85481"])).toBe("rooms");
    expect(resolveSubcommand("hotels", ["reviews", "85481"])).toBe("reviews");
    expect(resolveSubcommand("skill", ["install", "-y"])).toBe("install");
    expect(resolveSubcommand("config", ["set", "currency", "SAR"])).toBe("set");
  });

  it("never records the VALUE a `config set` carries", () => {
    // `set` is the first positional and is allowlisted; the currency is the
    // second, which no allowlist reads, so it cannot leave the machine.
    expect(resolveSubcommand("config", ["set", "currency", "SAR"])).toBe("set");
    expect(resolveSubcommand("config", ["nope", "SAR"])).toBeUndefined();
  });

  it("skips leading flags to find it", () => {
    expect(resolveSubcommand("telemetry", ["--json", "status"])).toBe("status");
  });

  it("never records a places query – the positional is free text", () => {
    expect(
      resolveSubcommand("places", ["dubai marina apartment near my hotel"]),
    ).toBeUndefined();
  });

  it("does not mistake a value-flag's value for the subcommand", () => {
    // The real dispatcher requires the subcommand first, so this is only
    // reachable on a usage error — but reading "NYC" as the subcommand would be
    // wrong either way.
    expect(
      resolveSubcommand("flights", ["--sort", "price_asc", "search"]),
    ).toBe("search");
    expect(resolveSubcommand("flights", ["--sort=price_asc", "search"])).toBe(
      "search",
    );
  });

  it("drops a positional that is not in the command's allowlist", () => {
    expect(resolveSubcommand("flights", ["s3cret"])).toBeUndefined();
  });

  it("returns nothing when every argument is a flag", () => {
    expect(
      resolveSubcommand("flights", ["--wait", "--sort", "price_asc"]),
    ).toBeUndefined();
  });

  it("returns nothing for a command with no subcommands", () => {
    expect(resolveSubcommand("whoami", [])).toBeUndefined();
  });
});

describe("extractFlagNames", () => {
  it("collects allowlisted names, deduplicated, in first-seen order", () => {
    expect(
      extractFlagNames(["--wait", "--sort", "price_asc", "--wait"]),
    ).toEqual(["--wait", "--sort"]);
  });

  it("handles the --flag=value form", () => {
    expect(extractFlagNames(["--sort=price_asc"])).toEqual(["--sort"]);
  });

  it("drops an unknown flag name rather than recording it", () => {
    expect(extractFlagNames(["--not-a-real-flag", "--wait"])).toEqual([
      "--wait",
    ]);
  });

  it("ignores positionals", () => {
    expect(extractFlagNames(["SIN", "BKK", "2026-03-01"])).toEqual([]);
  });

  it("records the reviews filter names, so the funnel sees them", () => {
    expect(
      extractFlagNames([
        "--topics",
        "breakfast,pool",
        "--guest-type",
        "couple",
      ]),
    ).toEqual(["--topics", "--guest-type"]);
  });
});

describe("extractFlagValues", () => {
  it("captures whitelisted enum and count values under an arg_ prefix", () => {
    expect(
      extractFlagValues(["--sort", "price_asc", "--page-size", "5"]),
    ).toEqual({ arg_sort: "price_asc", arg_page_size: 5 });
  });

  it("captures the --flag=value form the same way", () => {
    expect(extractFlagValues(["--cabin=business"])).toEqual({
      arg_cabin: "business",
    });
  });

  it("captures the review cohort but never the free-text topic", () => {
    const values = extractFlagValues([
      "--guest-type",
      "family_with_children",
      "--topics",
      "breakfast at the rooftop bar",
    ]);
    expect(values).toEqual({ arg_guest_type: "family_with_children" });
    expect(JSON.stringify(values)).not.toContain("rooftop");
  });

  it("never captures a feedback message – users put PII in it", () => {
    const values = extractFlagValues([
      "--rating",
      "5",
      "--message",
      "booking WGO-12345, reach me at someone@example.com",
    ]);
    expect(values).toEqual({ arg_rating: 5 });
    expect(JSON.stringify(values)).not.toContain("example.com");
  });

  it("captures nothing for a value-bearing flag outside the whitelist", () => {
    expect(
      extractFlagValues([
        "--from",
        "SIN",
        "--to",
        "BKK",
        "--date",
        "2026-03-01",
      ]),
    ).toEqual({});
  });

  it("records an out-of-shape value as `invalid` rather than passing it through", () => {
    expect(extractFlagValues(["--sort", "$(cat /etc/passwd)"])).toEqual({
      arg_sort: "invalid",
    });
    expect(extractFlagValues(["--page", "99999999"])).toEqual({
      arg_page: "invalid",
    });
    expect(extractFlagValues(["--adults", "two"])).toEqual({
      arg_adults: "invalid",
    });
  });

  it("records the -a short form of --agent", () => {
    expect(extractFlagNames(["-a", "claude"])).toEqual(["-a"]);
  });

  it("records a short alias's value under its long name, not the alias", () => {
    // `-a claude` and `--agent claude` must land in one property, or the split
    // makes agent usage look half as common as it is.
    expect(extractFlagValues(["-a", "claude"])).toEqual({
      arg_agent: "claude",
    });
    expect(extractFlagValues(["--agent", "claude"])).toEqual({
      arg_agent: "claude",
    });
  });

  it.each([
    ["--stops", "0,1"],
  ])("records %p by name only, since its value is not a scalar", (flag, value) => {
    // Typing these as count/enum made every real use record `invalid`.
    expect(extractFlagValues([flag, value])).toEqual({});
    expect(extractFlagNames([flag, value])).toEqual([flag]);
  });

  it("captures nothing when the flag has no value after it", () => {
    expect(extractFlagValues(["--sort"])).toEqual({});
    expect(extractFlagValues(["--sort", "--wait"])).toEqual({});
  });
});

describe("buildTelemetryEvent", () => {
  const input = (
    over: Partial<TelemetryEventInput> = {},
  ): TelemetryEventInput => ({
    argv: argv("flights", "search", "SIN", "BKK", "2026-03-01", "--wait"),
    exitCode: EXIT.OK,
    durationMs: 1234,
    version: "1.2.3",
    platform: "darwin",
    arch: "arm64",
    deviceId: DEVICE,
    now: NOW,
    ...over,
  });

  it("keys a logged-in event on the uid and creates a person", () => {
    const event = buildTelemetryEvent(input({ uid: "227935" }));
    expect(event.distinct_id).toBe("227935");
    expect(event.properties.$process_person_profile).toBeUndefined();
  });

  it("keys a logged-out event on the machine id, in the anonymous tier", () => {
    const event = buildTelemetryEvent(input());
    expect(event.distinct_id).toBe(DEVICE);
    expect(event.properties.$process_person_profile).toBe(false);
  });

  it("carries $session_id, which is what joins it to the API's events", () => {
    const event = buildTelemetryEvent(
      input({ sessionId: "b05d7226-701f-4892-abc3-dd92727b5683" }),
    );
    expect(event.properties.$session_id).toBe(
      "b05d7226-701f-4892-abc3-dd92727b5683",
    );
  });

  it("omits $session_id when the session could not be resolved", () => {
    expect(buildTelemetryEvent(input()).properties.$session_id).toBeUndefined();
  });

  it("carries the machine id as a property even when logged in", () => {
    const event = buildTelemetryEvent(input({ uid: "227935" }));
    expect(event.properties.device_id).toBe(DEVICE);
  });

  it("leaves login state recoverable without a dedicated property", () => {
    const out = buildTelemetryEvent(input());
    const inn = buildTelemetryEvent(input({ uid: "227935" }));
    expect(out.properties.device_id).toBe(out.distinct_id);
    expect(inn.properties.device_id).not.toBe(inn.distinct_id);
  });

  it("records the command, subcommand, environment and outcome", () => {
    const event = buildTelemetryEvent(input());
    expect(event.event).toBe(TELEMETRY_EVENT);
    expect(event.properties.command).toBe("flights");
    expect(event.properties.subcommand).toBe("search");
    expect(event.properties.flags).toEqual(["--wait"]);
    expect(event.properties.duration_ms).toBe(1234);
    expect(event.properties.os).toBe("darwin");
    expect(event.properties.arch).toBe("arm64");
    expect(event.properties.version).toBe("1.2.3");
    expect(event.timestamp).toBe(new Date(NOW).toISOString());
  });

  it("omits subcommand entirely when there is none", () => {
    const event = buildTelemetryEvent(input({ argv: argv("whoami") }));
    expect(event.properties.subcommand).toBeUndefined();
  });

  it("carries no trip content from a real flights search", () => {
    const event = buildTelemetryEvent(input());
    const serialized = JSON.stringify(event);
    for (const secret of ["SIN", "BKK", "2026-03-01"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("carries no query text from a real places search", () => {
    const event = buildTelemetryEvent({
      ...input({ argv: argv("places", "villa in bali for my anniversary") }),
    });
    expect(JSON.stringify(event)).not.toContain("anniversary");
  });
});

describe("every published hotels-results flag is measurable", () => {
  it("records each flag the results read publishes", () => {
    const flags = Object.keys(RESULTS_FLAG_TO_PARAM);
    expect(flags.length).toBeGreaterThan(0);
    expect(extractFlagNames(flags).toSorted()).toEqual(flags.toSorted());
  });
});
