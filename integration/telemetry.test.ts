/**
 * `wego telemetry` and the one control over usage events. Nothing here can reach
 * an analytics service: the binary under test is pointed at nothing, and `log`
 * mode prints the event instead of sending it.
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useScenario } from "./harness/scenario";
import { json } from "./harness/wego";

const s = useScenario();

const statePath = () => join(s.home.configDir, "telemetry.json");
const state = () => JSON.parse(readFileSync(statePath(), "utf8"));
function writeState(value: Record<string, unknown>) {
  mkdirSync(s.home.configDir, { recursive: true });
  writeFileSync(statePath(), JSON.stringify(value));
}
/** The harness turns telemetry off; these scenarios say what they want. */
const env = (mode = "") => ({ env: { WEGO_CLI_TELEMETRY: mode } });

describe("telemetry status", () => {
  it("reports the stored setting and where it lives", async () => {
    writeState({ deviceId: "dev-1", enabled: true });
    const result = await s.run(["telemetry", "status"], env());
    expect(result.code).toBe(0);
    expect(json(result)).toEqual({
      enabled: true,
      source: "default",
      mode: null,
      setting: true,
      path: statePath(),
    });
  });

  it("defaults to status with no subcommand", async () => {
    const result = await s.run(["telemetry"], env());
    expect(json(result).source).toBe("default");
  });

  it("attributes the state to the setting when it was turned off", async () => {
    writeState({ enabled: false });
    const result = await s.run(["telemetry", "status"], env());
    expect(json(result)).toMatchObject({ enabled: false, source: "setting" });
  });

  it("attributes the state to the environment, which wins", async () => {
    writeState({ enabled: true });
    const result = await s.run(["telemetry", "status"], env("0"));
    expect(json(result)).toMatchObject({
      enabled: false,
      source: "environment",
      mode: "off",
      setting: true,
    });
  });

  it("reports log mode as not sending", async () => {
    const result = await s.run(["telemetry", "status"], env("log"));
    expect(json(result)).toMatchObject({ enabled: false, mode: "log" });
  });
});

describe("telemetry enable / disable", () => {
  it("persists a disable, keeps the machine id, and echoes the new state", async () => {
    writeState({ deviceId: "dev-1", enabled: true });
    const result = await s.run(["telemetry", "disable"], env());
    expect(result.code).toBe(0);
    expect(json(result)).toEqual({ enabled: false, path: statePath() });
    expect(state()).toMatchObject({ deviceId: "dev-1", enabled: false });
  });

  it("persists an enable", async () => {
    writeState({ deviceId: "dev-1", enabled: false });
    const result = await s.run(["telemetry", "enable"], env());
    expect(json(result)).toEqual({ enabled: true, path: statePath() });
    expect(state()).toMatchObject({ deviceId: "dev-1", enabled: true });
  });

  it("warns on stderr when the environment will override what was just stored", async () => {
    const result = await s.run(["telemetry", "enable"], env("0"));
    expect(result.code).toBe(0);
    expect(result.err).toMatch(/WEGO_CLI_TELEMETRY=0 overrides/);
    expect(state().enabled).toBe(true);
  });

  it("stays quiet when the environment agrees with the stored choice", async () => {
    const result = await s.run(["telemetry", "disable"], env("0"));
    expect(result.code).toBe(0);
    expect(result.err).toBe("");
  });
});

describe("telemetry usage errors", () => {
  for (const [args, message] of [
    [["nuke"], /Unknown subcommand: nuke/],
    [["--force"], /Unknown option: --force/],
    [["disable", "unexpected"], /Unexpected argument: unexpected/],
    [["enable", "--force"], /Unknown option: --force/],
  ] as const) {
    it(`rejects \`telemetry ${args.join(" ")}\` with exit 2`, async () => {
      writeState({ enabled: true });
      const result = await s.run(["telemetry", ...args], env());
      expect(result.code).toBe(2);
      expect(result.out).toBe("");
      expect(result.err).toMatch(message);
      expect(state().enabled).toBe(true);
    });
  }

  it("prints usage on --help, naming the single control", async () => {
    const result = await s.run(["telemetry", "--help"], env());
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/WEGO_CLI_TELEMETRY/);
    expect(result.out).toMatch(/<status\|enable\|disable>/);
  });
});

describe("the usage event", () => {
  it("in log mode, prints the event on stderr and never the command's arguments", async () => {
    const result = await s.run(["places", "Secret Street 42"], env("log"));

    // Logged out, so the command itself fails; the event is still built.
    expect(result.code).toBe(3);
    expect(result.out).toBe("");
    expect(result.err).toContain("cli_command_ran");
    expect(result.err).not.toContain("Secret Street");
  });
});
