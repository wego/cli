import { describe, expect, it } from "bun:test";
import { effectiveSettings } from "./config-command";

/**
 * The precedence `wego config` reports, which is pure. What the command prints,
 * stores and rejects is `integration/config.test.ts`, which drives the compiled
 * binary against its own settings file.
 */

describe("effectiveSettings", () => {
  it("gives site the only middle rung, because only a client knows the market", () => {
    expect(effectiveSettings({}, "AE")).toEqual({
      currency: { value: null, source: "default" },
      site: { value: "AE", source: "account" },
      locale: { value: null, source: "default" },
    });
  });

  it("lets a stored value beat the account market, and names it", () => {
    expect(effectiveSettings({ site: "SA", currency: "SAR" }, "SG")).toEqual({
      currency: { value: "SAR", source: "setting" },
      site: { value: "SA", source: "setting" },
      locale: { value: null, source: "default" },
    });
  });
});
