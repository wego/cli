import { describe, expect, it } from "bun:test";
import {
  CONFIG_USAGE,
  type ConfigCommandDeps,
  config,
  effectiveSettings,
} from "./config-command";
import { EXIT } from "./error-report";
import type { UserSettings } from "./settings";

const PATH = "/home/u/.config/wego/settings.json";

function makeDeps(
  initial: UserSettings = {},
  accountMarket?: string,
): {
  deps: ConfigCommandDeps;
  out: string[];
  err: string[];
  stored: () => UserSettings;
} {
  const out: string[] = [];
  const err: string[] = [];
  let stored: UserSettings = initial;
  return {
    out,
    err,
    stored: () => stored,
    deps: {
      log: (m) => out.push(m),
      error: (m) => err.push(m),
      settingsPath: PATH,
      loadSettings: async () => stored,
      saveSettings: async (next) => {
        stored = next;
      },
      accountMarket: async () => accountMarket,
    },
  };
}

const json = (out: string[]) =>
  JSON.parse(out[out.length - 1] ?? "{}") as Record<
    string,
    { value: string | null; source: string } | string
  >;

describe("wego config list", () => {
  it("prints every value with the layer that decided it, plus the path", async () => {
    const { deps, out } = makeDeps({ currency: "SAR" }, "SG");
    expect(await config(["list"], deps)).toBe(EXIT.OK);
    expect(json(out)).toEqual({
      currency: { value: "SAR", source: "setting" },
      site: { value: "SG", source: "account" },
      locale: { value: null, source: "default" },
      path: PATH,
    });
  });

  it("defaults to `list` when no subcommand is given", async () => {
    const { deps, out } = makeDeps();
    expect(await config([], deps)).toBe(EXIT.OK);
    expect(json(out).path).toBe(PATH);
  });

  it("reports source `setting` for a site that overrides the account market", async () => {
    // The decision in issue #1386: an explicit setting beats the id_token market.
    const { deps, out } = makeDeps({ site: "SA" }, "SG");
    expect(await config(["list"], deps)).toBe(EXIT.OK);
    expect(json(out).site).toEqual({ value: "SA", source: "setting" });
  });

  it("reports `default` for site when logged out and nothing is stored", async () => {
    const { deps, out } = makeDeps({}, undefined);
    expect(await config(["list"], deps)).toBe(EXIT.OK);
    expect(json(out).site).toEqual({ value: null, source: "default" });
  });

  it("prints usage on --help, on stdout, exit 0", async () => {
    const { deps, out } = makeDeps();
    expect(await config(["--help"], deps)).toBe(EXIT.OK);
    expect(out[0]).toBe(CONFIG_USAGE);
  });

  it("rejects a stray argument as a usage error", async () => {
    const { deps, err } = makeDeps();
    expect(await config(["list", "extra"], deps)).toBe(EXIT.USAGE);
    expect(err.join("\n")).toContain("Unexpected argument: extra");
  });
});

describe("wego config set", () => {
  it("stores a normalized value and prints the new effective config", async () => {
    const { deps, out, stored } = makeDeps();
    expect(await config(["set", "currency", "sar"], deps)).toBe(EXIT.OK);
    expect(stored()).toEqual({ currency: "SAR" });
    expect(json(out).currency).toEqual({ value: "SAR", source: "setting" });
  });

  it("keeps the other keys (read-modify-write, not a one-key rewrite)", async () => {
    const { deps, stored } = makeDeps({ locale: "ar" });
    expect(await config(["set", "site", "SA"], deps)).toBe(EXIT.OK);
    expect(stored()).toEqual({ locale: "ar", site: "SA" });
  });

  it("rejects a value the API would reject, writing nothing", async () => {
    const { deps, err, stored } = makeDeps();
    expect(await config(["set", "currency", "riyal"], deps)).toBe(EXIT.USAGE);
    expect(err.join("\n")).toContain("ISO 4217");
    expect(stored()).toEqual({});
  });

  it("rejects an unknown setting name", async () => {
    const { deps, err } = makeDeps();
    expect(await config(["set", "cabin", "business"], deps)).toBe(EXIT.USAGE);
    expect(err.join("\n")).toContain("Unknown setting: cabin");
  });

  it("needs a value", async () => {
    const { deps, err } = makeDeps();
    expect(await config(["set", "currency"], deps)).toBe(EXIT.USAGE);
    expect(err.join("\n")).toContain("needs a value");
  });
});

describe("wego config unset", () => {
  it("drops one key and leaves the rest", async () => {
    const { deps, stored } = makeDeps({ currency: "SAR", site: "SA" });
    expect(await config(["unset", "currency"], deps)).toBe(EXIT.OK);
    expect(stored()).toEqual({ site: "SA" });
  });

  it("falls back to the account market once the site setting is gone", async () => {
    const { deps, out } = makeDeps({ site: "SA" }, "SG");
    expect(await config(["unset", "site"], deps)).toBe(EXIT.OK);
    expect(json(out).site).toEqual({ value: "SG", source: "account" });
  });

  it("is a no-op on a key that was never set", async () => {
    const { deps, stored } = makeDeps({});
    expect(await config(["unset", "locale"], deps)).toBe(EXIT.OK);
    expect(stored()).toEqual({});
  });
});

describe("effectiveSettings", () => {
  it("gives site the only middle rung, because only a client knows the market", () => {
    expect(effectiveSettings({}, "AE")).toEqual({
      currency: { value: null, source: "default" },
      site: { value: "AE", source: "account" },
      locale: { value: null, source: "default" },
    });
  });
});

describe("wego config (bad input)", () => {
  it("rejects an unknown subcommand with usage", async () => {
    const { deps, err } = makeDeps();
    expect(await config(["show"], deps)).toBe(EXIT.USAGE);
    expect(err.join("\n")).toContain("Unknown subcommand: show");
  });

  it("calls an unknown flag an option, not a subcommand", async () => {
    const { deps, err } = makeDeps();
    expect(await config(["--all"], deps)).toBe(EXIT.USAGE);
    expect(err.join("\n")).toContain("Unknown option: --all");
  });
});
