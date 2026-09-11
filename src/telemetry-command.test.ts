import { describe, expect, it } from "bun:test";
import { EXIT } from "./error-report";
import {
  effectiveTelemetry,
  TELEMETRY_USAGE,
  type TelemetryCommandDeps,
  telemetry,
} from "./telemetry-command";
import type { TelemetryState } from "./telemetry-state";

const STATE_PATH = "/home/u/.config/wego/telemetry.json";

function deps(
  over: Partial<TelemetryCommandDeps> & { state?: TelemetryState } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  let state: TelemetryState = over.state ?? {
    deviceId: "dev-1",
    enabled: true,
  };
  const { state: _ignored, ...rest } = over;
  const base: TelemetryCommandDeps = {
    log: (m) => out.push(m),
    error: (m) => err.push(m),
    env: {},
    statePath: STATE_PATH,
    loadState: async () => state,
    setEnabled: async (enabled) => {
      state = { ...state, enabled };
      return state;
    },
    ...rest,
  };
  return Object.assign(base, { out, err, current: () => state });
}

const json = (lines: string[]) => JSON.parse(lines[0] as string);

describe("telemetry status", () => {
  it("reports the stored setting and where it lives", async () => {
    const d = deps();
    expect(await telemetry(["status"], d)).toBe(EXIT.OK);
    expect(json(d.out)).toEqual({
      enabled: true,
      source: "default",
      mode: null,
      setting: true,
      path: STATE_PATH,
    });
  });

  it("defaults to status with no subcommand", async () => {
    const d = deps();
    expect(await telemetry([], d)).toBe(EXIT.OK);
    expect(json(d.out).source).toBe("default");
  });

  it("attributes the state to the setting when it was turned off", async () => {
    const d = deps({ state: { enabled: false } });
    expect(await telemetry(["status"], d)).toBe(EXIT.OK);
    expect(json(d.out)).toMatchObject({ enabled: false, source: "setting" });
  });

  it("attributes the state to the environment, which wins", async () => {
    const d = deps({
      env: { WEGO_CLI_TELEMETRY: "0" },
      state: { enabled: true },
    });
    expect(await telemetry(["status"], d)).toBe(EXIT.OK);
    expect(json(d.out)).toMatchObject({
      enabled: false,
      source: "environment",
      mode: "off",
      setting: true,
    });
  });

  it("reports log mode as NOT sending, since it sends nothing", async () => {
    // `enabled` answers "do events leave this machine"; `mode` explains why not.
    const d = deps({ env: { WEGO_CLI_TELEMETRY: "log" } });
    expect(await telemetry(["status"], d)).toBe(EXIT.OK);
    expect(json(d.out)).toMatchObject({ enabled: false, mode: "log" });
  });
});

describe("telemetry enable / disable", () => {
  it("persists a disable and echoes the new state", async () => {
    const d = deps();
    expect(await telemetry(["disable"], d)).toBe(EXIT.OK);
    expect(d.current().enabled).toBe(false);
    expect(json(d.out)).toEqual({ enabled: false, path: STATE_PATH });
  });

  it("persists an enable", async () => {
    const d = deps({ state: { enabled: false } });
    expect(await telemetry(["enable"], d)).toBe(EXIT.OK);
    expect(d.current().enabled).toBe(true);
    expect(json(d.out)).toEqual({ enabled: true, path: STATE_PATH });
  });

  it("keeps the machine id across a toggle", async () => {
    const d = deps();
    await telemetry(["disable"], d);
    await telemetry(["enable"], d);
    expect(d.current().deviceId).toBe("dev-1");
  });

  it("warns on stderr when the environment will override what was just stored", async () => {
    const d = deps({ env: { WEGO_CLI_TELEMETRY: "0" } });
    expect(await telemetry(["enable"], d)).toBe(EXIT.OK);
    expect(d.err.join("\n")).toMatch(/WEGO_CLI_TELEMETRY=0 overrides/);
    expect(d.current().enabled).toBe(true);
  });

  it("stays quiet when the environment agrees with the stored choice", async () => {
    const d = deps({ env: { WEGO_CLI_TELEMETRY: "0" } });
    expect(await telemetry(["disable"], d)).toBe(EXIT.OK);
    expect(d.err).toHaveLength(0);
  });
});

describe("telemetry usage errors", () => {
  it("rejects an unknown subcommand with the usage class", async () => {
    const d = deps();
    expect(await telemetry(["nuke"], d)).toBe(EXIT.USAGE);
    expect(d.err.join("\n")).toMatch(/Unknown subcommand: nuke/);
    expect(d.out).toHaveLength(0);
  });

  it("names an unknown option as such", async () => {
    const d = deps();
    expect(await telemetry(["--force"], d)).toBe(EXIT.USAGE);
    expect(d.err.join("\n")).toMatch(/Unknown option: --force/);
  });

  it("rejects a trailing argument after enable/disable", async () => {
    const d = deps();
    expect(await telemetry(["disable", "unexpected"], d)).toBe(EXIT.USAGE);
    expect(d.err.join("\n")).toMatch(/Unexpected argument: unexpected/);
    expect(d.current().enabled).toBe(true);
  });

  it("rejects a trailing option after enable/disable", async () => {
    const d = deps();
    expect(await telemetry(["enable", "--force"], d)).toBe(EXIT.USAGE);
    expect(d.err.join("\n")).toMatch(/Unknown option: --force/);
  });

  it("prints usage on --help", async () => {
    const d = deps();
    expect(await telemetry(["--help"], d)).toBe(EXIT.OK);
    expect(d.out[0]).toBe(TELEMETRY_USAGE);
  });

  it("names the single control in its usage text", () => {
    expect(TELEMETRY_USAGE).toMatch(/WEGO_CLI_TELEMETRY/);
    expect(TELEMETRY_USAGE).toMatch(/<status\|enable\|disable>/);
    expect(TELEMETRY_USAGE).toMatch(/Never your\s+search/);
  });
});

describe("effectiveTelemetry", () => {
  it.each([
    ["off", { enabled: true }, false, "environment"],
    ["on", { enabled: false }, true, "environment"],
    ["log", { enabled: true }, false, "environment"],
    [undefined, { enabled: true }, true, "default"],
    [undefined, { enabled: false }, false, "setting"],
  ] as const)("resolves mode %p against setting %p", (mode, state, enabled, source) => {
    expect(effectiveTelemetry(mode, state)).toEqual({ enabled, source });
  });
});
