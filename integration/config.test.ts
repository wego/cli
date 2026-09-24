/**
 * `wego config`: the stored travel preferences, read and written in the binary's
 * own settings file, and the layer that decided each effective value.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { useScenario } from "./harness/scenario";
import { type CliResult, json, signIn, writeSettings } from "./harness/wego";

const s = useScenario();

const settingsPath = () => join(s.home.configDir, "settings.json");
const stored = () =>
  existsSync(settingsPath())
    ? JSON.parse(readFileSync(settingsPath(), "utf8"))
    : {};
type Effective = { value: string | null; source: string };
const printed = (r: CliResult) =>
  json<{
    currency: Effective;
    site: Effective;
    locale: Effective;
    path: string;
  }>(r);

/** Logged in with an account market, which `site` falls back to. */
function signInWithMarket(market: string) {
  signIn(s.home, { accessToken: "access-1", market });
}

describe("config list", () => {
  it("prints every value with the layer that decided it, plus the path", async () => {
    writeSettings(s.home, { currency: "SAR" });
    signInWithMarket("SG");
    const result = await s.run(["config", "list"]);

    expect(result.code).toBe(0);
    expect(printed(result)).toEqual({
      currency: { value: "SAR", source: "setting" },
      site: { value: "SG", source: "account" },
      locale: { value: null, source: "default" },
      path: settingsPath(),
    });
  });

  it("defaults to `list` when no subcommand is given", async () => {
    const result = await s.run(["config"]);
    expect(result.code).toBe(0);
    expect(printed(result).path).toBe(settingsPath());
  });

  it("reports `setting` for a site that overrides the account market", async () => {
    writeSettings(s.home, { site: "SA" });
    signInWithMarket("SG");
    const result = await s.run(["config", "list"]);
    expect(printed(result).site).toEqual({ value: "SA", source: "setting" });
  });

  it("reports `default` for site when logged out and nothing is stored", async () => {
    const result = await s.run(["config", "list"]);
    expect(printed(result).site).toEqual({ value: null, source: "default" });
  });

  it("prints usage on --help, on stdout, exit 0", async () => {
    const result = await s.run(["config", "--help"]);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/^Usage: wego config/);
  });

  it("rejects a stray argument, exit 2", async () => {
    const result = await s.run(["config", "list", "extra"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("Unexpected argument: extra");
  });
});

describe("config set", () => {
  it("stores a normalized value and prints the new effective config", async () => {
    const result = await s.run(["config", "set", "currency", "sar"]);
    expect(result.code).toBe(0);
    expect(stored()).toEqual({ currency: "SAR" });
    expect(printed(result).currency).toEqual({
      value: "SAR",
      source: "setting",
    });
  });

  it("keeps the other keys", async () => {
    writeSettings(s.home, { locale: "ar" });
    expect((await s.run(["config", "set", "site", "SA"])).code).toBe(0);
    expect(stored()).toEqual({ locale: "ar", site: "SA" });
  });

  it("rejects a value the API would reject, writing nothing", async () => {
    const result = await s.run(["config", "set", "currency", "riyal"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("ISO 4217");
    expect(stored()).toEqual({});
  });

  it("rejects an unknown setting name", async () => {
    const result = await s.run(["config", "set", "cabin", "business"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("Unknown setting: cabin");
  });

  it("needs a value", async () => {
    const result = await s.run(["config", "set", "currency"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("needs a value");
  });
});

describe("config unset", () => {
  it("drops one key and leaves the rest", async () => {
    writeSettings(s.home, { currency: "SAR", site: "SA" });
    expect((await s.run(["config", "unset", "currency"])).code).toBe(0);
    expect(stored()).toEqual({ site: "SA" });
  });

  it("falls back to the account market once the site setting is gone", async () => {
    writeSettings(s.home, { site: "SA" });
    signInWithMarket("SG");
    const result = await s.run(["config", "unset", "site"]);
    expect(result.code).toBe(0);
    expect(printed(result).site).toEqual({ value: "SG", source: "account" });
  });

  it("is a no-op on a key that was never set", async () => {
    expect((await s.run(["config", "unset", "locale"])).code).toBe(0);
    expect(stored()).toEqual({});
  });
});

describe("config (bad input)", () => {
  it("rejects an unknown subcommand with usage", async () => {
    const result = await s.run(["config", "show"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("Unknown subcommand: show");
  });

  it("calls an unknown flag an option, not a subcommand", async () => {
    const result = await s.run(["config", "--all"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("Unknown option: --all");
  });
});
