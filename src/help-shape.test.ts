import { describe, expect, it } from "bun:test";
import {
  AIRPORTS_NEAR_USAGE,
  BOOKING_LINK_USAGE,
  EXPERIENCE_USAGE,
  FARES_USAGE,
  FEEDBACK_USAGE,
  FLIGHTS_USAGE,
  HOLIDAYS_USAGE,
  HOTELS_BOOKING_LINK_USAGE,
  HOTELS_DETAILS_USAGE,
  HOTELS_RESULTS_USAGE,
  HOTELS_REVIEWS_USAGE,
  HOTELS_ROOMS_USAGE,
  HOTELS_SEARCH_USAGE,
  HOTELS_SHARE_USAGE,
  HOTELS_USAGE,
  INFO_USAGE,
  LOGIN_USAGE,
  LOGOUT_USAGE,
  PLACES_USAGE,
  RESULTS_USAGE,
  SCHEDULES_USAGE,
  SEARCH_USAGE,
  SHARE_USAGE,
  TARGET_USAGE,
  TRIP_USAGE,
  VERSION_USAGE,
  VISA_FREE_USAGE,
  WHOAMI_USAGE,
} from "./commands";
import { CONFIG_USAGE } from "./config-command";
import { helpText } from "./index";
import { SKILL_USAGE } from "./skill";
import { TELEMETRY_USAGE } from "./telemetry-command";
import { UNINSTALL_USAGE } from "./uninstall";
import { UPDATE_USAGE } from "./update";
import { HELP_WIDTH } from "./usage";

const GROUPS = { FLIGHTS_USAGE, HOTELS_USAGE, INFO_USAGE };
const LEAVES = {
  LOGIN_USAGE,
  WHOAMI_USAGE,
  LOGOUT_USAGE,
  VERSION_USAGE,
  PLACES_USAGE,
  FEEDBACK_USAGE,
  HOLIDAYS_USAGE,
  VISA_FREE_USAGE,
  SCHEDULES_USAGE,
  AIRPORTS_NEAR_USAGE,
  TARGET_USAGE,
  SEARCH_USAGE,
  RESULTS_USAGE,
  TRIP_USAGE,
  EXPERIENCE_USAGE,
  FARES_USAGE,
  BOOKING_LINK_USAGE,
  SHARE_USAGE,
  HOTELS_SEARCH_USAGE,
  HOTELS_RESULTS_USAGE,
  HOTELS_DETAILS_USAGE,
  HOTELS_REVIEWS_USAGE,
  HOTELS_ROOMS_USAGE,
  HOTELS_BOOKING_LINK_USAGE,
  HOTELS_SHARE_USAGE,
  CONFIG_USAGE,
  SKILL_USAGE,
  UPDATE_USAGE,
  UNINSTALL_USAGE,
  TELEMETRY_USAGE,
};
const ROOT = helpText("wego");
const ALL = { ROOT, ...GROUPS, ...LEAVES };

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

describe("help shape", () => {
  it("root under 1500 bytes, a group under 700, a leaf under 2500", () => {
    expect(bytes(ROOT)).toBeLessThan(1500);
    for (const [name, text] of Object.entries(GROUPS)) {
      expect(bytes(text), name).toBeLessThan(700);
    }
    for (const [name, text] of Object.entries(LEAVES)) {
      expect(bytes(text), name).toBeLessThan(2500);
    }
  });

  it("no line over the width, no trailing space, no em-dash", () => {
    for (const [name, text] of Object.entries(ALL)) {
      for (const line of text.split("\n")) {
        expect(line.length, `${name}: ${line}`).toBeLessThanOrEqual(HELP_WIDTH);
        expect(line, name).not.toMatch(/\s$/);
        expect(line, name).not.toContain("—");
      }
    }
  });

  it("every page opens with Usage: wego and a one-line description", () => {
    for (const [name, text] of Object.entries({ ...GROUPS, ...LEAVES })) {
      const lines = text.split("\n");
      expect(lines[0], name).toMatch(/^Usage: wego /);
      const what = lines.find((l, i) => i > 0 && !l.startsWith("   or: "));
      expect(what, name).toMatch(/^[A-Z].*\.$/);
    }
  });

  it("a group lists leaves only, a leaf lists flags only", () => {
    for (const text of Object.values(GROUPS)) {
      expect(text).not.toMatch(/^ {2}--/m);
      expect(text).toContain("<command> --help for flags.");
      expect(text).not.toContain("for the other commands.");
    }
    for (const [name, text] of Object.entries(LEAVES)) {
      expect(text, name).not.toMatch(/^ {2}[a-z]/m);
      expect(text, name).not.toMatch(/Run wego \w+ --help for flags\./);
    }
  });

  it("every root row has a page whose Usage line names that command", () => {
    const rows = [...ROOT.matchAll(/^ {2}([a-z-]+) /gm)].map((m) => m[1]);
    expect(rows.length).toBeGreaterThanOrEqual(14);
    const pages = Object.values({ ...GROUPS, ...LEAVES });
    for (const name of rows) {
      const page = pages.find((p) => p.startsWith(`Usage: wego ${name}`));
      expect(page, name).toBeDefined();
    }
  });

  it("every paged leaf states its --page-size cap", () => {
    for (const [name, text] of Object.entries(LEAVES)) {
      if (!/^ {2}--page-size N/m.test(text)) continue;
      expect(text, name).toMatch(/--page-size N +(Default \d+, max|Max) \d+\./);
    }
  });

  it("enum flags spell their values inline", () => {
    expect(RESULTS_USAGE).toMatch(/--sort VALUE\s+score_desc\|price_asc\|/);
    expect(SEARCH_USAGE).toMatch(/--cabin VALUE\s+economy\|premium_economy\|/);
    expect(HOTELS_RESULTS_USAGE).toMatch(
      /--sort VALUE\s+relevance\|price_asc\|.*review_score_desc/s,
    );
    for (const flag of [
      "--min-star",
      "--refundable",
      "--amenities",
      "--brands",
      "--chains",
      "--districts",
    ]) {
      expect(HOTELS_RESULTS_USAGE).toMatch(new RegExp(`^ {2}${flag} `, "m"));
    }
  });

  it("keeps the facts that moved out of the root", () => {
    expect(BOOKING_LINK_USAGE).toMatch(/^Usage: .*--trip ID --fare-option ID/);
    expect(BOOKING_LINK_USAGE).not.toContain("[--fare-option");
    expect(LOGIN_USAGE).toContain("--no-browser");
    expect(LOGIN_USAGE).toContain("WEGO_CLI_REDIRECT_PORT");
    expect(CONFIG_USAGE).toMatch(/flag on a command always wins/);
    expect(CONFIG_USAGE).toContain("settings.json");
    expect(UNINSTALL_USAGE).toContain("user-scope agent skill");
    expect(UNINSTALL_USAGE).toMatch(/--dir skill install is not touched/);
    expect(TELEMETRY_USAGE).toContain("WEGO_CLI_TELEMETRY");
  });
});
