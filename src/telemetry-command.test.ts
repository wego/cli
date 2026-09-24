import { describe, expect, it } from "bun:test";
import { effectiveTelemetry, TELEMETRY_USAGE } from "./telemetry-command";

/**
 * The precedence `wego telemetry` reports, and its usage text. What the command
 * prints and stores is `integration/telemetry.test.ts`, which drives the compiled
 * binary against its own state file.
 */

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

describe("TELEMETRY_USAGE", () => {
  it("names the single control and what is never sent", () => {
    expect(TELEMETRY_USAGE).toMatch(/WEGO_CLI_TELEMETRY/);
    expect(TELEMETRY_USAGE).toMatch(/<status\|enable\|disable>/);
    expect(TELEMETRY_USAGE).toMatch(/Never your\s+search/);
  });
});
