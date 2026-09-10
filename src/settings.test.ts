import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveCliCurrency,
  resolveCliSite,
  stripMetadataSources,
} from "./commands";
import { EXIT, exitCodeForError, formatCliError } from "./error-report";
import {
  applyPreferences,
  loadUserSettings,
  parseSettingValue,
  SETTINGS_KEYS,
  SettingsFileError,
  saveUserSettings,
} from "./settings";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wego-settings-"));
  path = join(dir, "nested", "settings.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("settings file", () => {
  it("round-trips the three keys and creates the directory", async () => {
    await saveUserSettings(path, {
      currency: "SAR",
      site: "SA",
      locale: "ar",
    });
    expect(await loadUserSettings(path)).toEqual({
      currency: "SAR",
      site: "SA",
      locale: "ar",
    });
  });

  it("writes 0600, like every other file in the config dir", async () => {
    await saveUserSettings(path, { currency: "SAR" });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("treats an absent file as no preferences at all", async () => {
    expect(await loadUserSettings(join(dir, "absent.json"))).toEqual({});
  });

  it("FAILS on a file that exists but is not valid JSON, naming the path", async () => {
    await writeFile(join(dir, "broken.json"), "{ nope");
    const err = await loadUserSettings(join(dir, "broken.json")).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SettingsFileError);
    expect((err as SettingsFileError).path).toBe(join(dir, "broken.json"));
  });

  it("FAILS on a value the API would reject, rather than dropping it", async () => {
    // The whole point: a silently discarded currency reprices the answer, which
    // is the confident-wrong-answer bug this file exists to remove (#1386).
    await writeFile(
      join(dir, "bad.json"),
      JSON.stringify({ currency: "riyal" }),
    );
    const err = await loadUserSettings(join(dir, "bad.json")).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SettingsFileError);
    expect((err as Error).message).toContain("ISO 4217");
  });

  it("FAILS on a misspelled key instead of stripping it to `{}`", async () => {
    // A stripping `z.object` reads `{"curreny":"SAR"}` as no preferences and
    // prices in USD — the same silent repricing by a different route.
    await writeFile(
      join(dir, "typo.json"),
      JSON.stringify({ curreny: "SAR", currency: "SAR" }),
    );
    const err = await loadUserSettings(join(dir, "typo.json")).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SettingsFileError);
    // The message names the offending key AND the real ones, or it is unfixable.
    expect((err as Error).message).toContain('"curreny"');
    expect((err as Error).message).toContain("currency, site, locale");
  });

  it("FAILS on ENOTDIR: an unreachable path is not an absent file", async () => {
    // `dir/file.json/settings.json` — a component of the path is a file, so the
    // preferences the user stored cannot be read. Reporting `{}` would price in
    // USD and never say why.
    const asFile = join(dir, "file.json");
    await writeFile(asFile, "{}");
    const err = await loadUserSettings(join(asFile, "settings.json")).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SettingsFileError);
    expect((err as Error).message).toContain("could not be read");
  });

  it("maps a broken file to the USAGE class with an actionable message", () => {
    const err = new SettingsFileError(
      "settings.json is not valid: x",
      "/p/s.json",
    );
    expect(exitCodeForError(err)).toBe(EXIT.USAGE);
    const rendered = formatCliError(err, "wego");
    expect(rendered).toContain("/p/s.json");
    expect(rendered).toContain("delete it");
    // ONE physical line, ` | `-joined like every other error in the taxonomy: a
    // caller that reads one line off stderr must not lose the path or the fix.
    expect(rendered).not.toContain("\n");
  });

  it("normalizes on write: trims and upcases currency and site", async () => {
    expect(parseSettingValue("currency", " sar ")).toBe("SAR");
    expect(parseSettingValue("site", "sa")).toBe("SA");
    expect(parseSettingValue("locale", " en-GB ")).toBe("en-GB");
  });

  it("rejects a bad value with the API's own message", () => {
    expect(() => parseSettingValue("currency", "SA")).toThrow("ISO 4217");
    expect(() => parseSettingValue("site", "SAU")).toThrow("2-letter");
    expect(() => parseSettingValue("locale", "x".repeat(36))).toThrow("<= 35");
  });

  it("exposes exactly the three keys in scope", () => {
    expect(SETTINGS_KEYS).toEqual(["currency", "site", "locale"]);
  });
});

describe("precedence, pinned end to end (issue #1386)", () => {
  const settings = { currency: "SAR", site: "SA", locale: "ar" };

  it("a flag beats the setting for currency and locale", () => {
    expect(
      applyPreferences({ currency: "USD", locale: "en" }, settings),
    ).toEqual({ currency: "USD", locale: "en" });
  });

  it("the setting fills in when no flag was passed", () => {
    expect(applyPreferences({}, settings)).toEqual({
      currency: "SAR",
      locale: "ar",
    });
  });

  it("the API default applies when neither flag nor setting supplies one", () => {
    // Nothing added, so the request carries no currency and the API's USD
    // default owns the decision — the CLI never hardcodes it.
    expect(applyPreferences({}, {})).toEqual({});
  });

  it("fills only the keys the caller names (places/holidays carve-out)", () => {
    expect(applyPreferences({}, settings, ["locale"])).toEqual({
      locale: "ar",
    });
  });

  it("currency: flag > setting > API default, and the source names which won", () => {
    // The three rungs `flights search` / `hotels search` stamp as
    // `currencyCodeSource` (issue #1400). No `account` rung: the id_token carries
    // a market, never a currency.
    expect(resolveCliCurrency("USD", "SAR")).toEqual({
      currency: "USD",
      source: "explicit",
    });
    expect(resolveCliCurrency(undefined, "SAR")).toEqual({
      currency: "SAR",
      source: "setting",
    });
    // No currency at all, so the API's USD default owns the decision — the CLI
    // never hardcodes it, exactly as with the site floor.
    expect(resolveCliCurrency(undefined, undefined)).toEqual({
      source: "default",
    });
  });

  it("every request-scoped *Source copy is dropped from metadata, echoes kept", () => {
    // The #1534 rule (decision Q2: "strip"): CLI output publishes exactly one
    // `*Source` per knob, at top level, in the CLI's own vocabulary. The API's
    // request-scoped copies inside `metadata` answer a narrower question in a
    // narrower vocabulary — a stored currency arrives merged into the request,
    // so the API calls it `explicit` while the CLI's label says `setting` — and
    // forwarding one puts two disagreeing `*Source` fields in one payload.
    // Typed loosely on purpose: the helper returns its INPUT type, so a settled
    // snapshot still satisfies the signals the engine reads off it. That means
    // the static type keeps sources the value no longer has - the removal is a
    // runtime fact, which is what this asserts.
    const priced: Record<string, unknown> = {
      metadata: {
        currencyCode: "SAR",
        currencyCodeSource: "explicit",
        locale: "ar",
        localeSource: "explicit",
      },
    };
    expect(stripMetadataSources(priced)).toEqual({
      metadata: {
        // The echoes stay; only the sources are withheld.
        currencyCode: "SAR",
        locale: "ar",
      },
    });
    // The schedules shape: the API's request-scoped siteCodeSource goes the
    // same way, and the siteCode echo stays.
    const schedules: Record<string, unknown> = {
      metadata: { siteCode: "SG", siteCodeSource: "explicit" },
    };
    expect(stripMetadataSources(schedules)).toEqual({
      metadata: { siteCode: "SG" },
    });
  });

  it("stripping a payload that has no *Source copies changes nothing", () => {
    // A link route publishes no echo at all, and a legacy API may omit the pair.
    // Neither is a shape the strip may invent metadata for.
    const link = { bookingUrl: "https://wego.com/x", expires: true };
    expect(stripMetadataSources(link)).toBe(link);
    const page = { metadata: { resultCount: 1 } };
    expect(stripMetadataSources(page)).toBe(page);
  });

  it("site: flag > setting > account market > API floor, in that order", () => {
    expect(resolveCliSite("SG", "SA", "AE").source).toBe("explicit");
    expect(resolveCliSite(undefined, "SA", "AE")).toEqual({
      siteCode: "SA",
      source: "setting",
    });
    expect(resolveCliSite(undefined, undefined, "AE")).toEqual({
      siteCode: "AE",
      source: "account",
    });
    expect(resolveCliSite(undefined, undefined, undefined)).toEqual({
      source: "default",
    });
  });
});
