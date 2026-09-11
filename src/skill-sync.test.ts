import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIRPORTS_NEAR_USAGE,
  BOOKING_LINK_USAGE,
  EXPERIENCE_USAGE,
  FARES_USAGE,
  FLIGHTS_USAGE,
  HOLIDAYS_USAGE,
  HOTELS_BOOKING_LINK_USAGE,
  HOTELS_DETAILS_USAGE,
  HOTELS_RESULTS_USAGE,
  HOTELS_REVIEWS_USAGE,
  HOTELS_ROOMS_USAGE,
  HOTELS_SEARCH_USAGE,
  HOTELS_USAGE,
  INFO_USAGE,
  LOGIN_USAGE,
  PLACES_USAGE,
  RESULTS_USAGE,
  SCHEDULES_USAGE,
  SEARCH_USAGE,
  SHARE_USAGE,
  TRIP_USAGE,
  VISA_FREE_USAGE,
} from "./commands";
import { helpText } from "./index";

// Drift guard: every flag and enum value a leaf usage names is in SKILL.md; root names every group, each group every leaf.

// Every exported usage constant, keyed by name so a failure names the source.
const USAGE_CONSTANTS: Record<string, string> = {
  LOGIN_USAGE,
  FLIGHTS_USAGE,
  SEARCH_USAGE,
  RESULTS_USAGE,
  TRIP_USAGE,
  EXPERIENCE_USAGE,
  FARES_USAGE,
  BOOKING_LINK_USAGE,
  SHARE_USAGE,
  HOTELS_USAGE,
  HOTELS_SEARCH_USAGE,
  HOTELS_RESULTS_USAGE,
  HOTELS_DETAILS_USAGE,
  HOTELS_REVIEWS_USAGE,
  HOTELS_ROOMS_USAGE,
  HOTELS_BOOKING_LINK_USAGE,
  PLACES_USAGE,
  HOLIDAYS_USAGE,
  VISA_FREE_USAGE,
  SCHEDULES_USAGE,
  AIRPORTS_NEAR_USAGE,
};

const SKILL_MD = readFileSync(
  join(import.meta.dir, "..", ".claude", "skills", "wego", "SKILL.md"),
  "utf8",
);
const ROOT_HELP = helpText("wego");

/** The distinct `--flag` tokens appearing in a usage string, skipping the
 *  `--departure-*` doc shorthand (a wildcard standing for the real
 *  `--departure-blocks`/`--departure-range`, not a literal flag). */
function flagsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/--[a-z][a-z0-9-]*/g)) {
    if (text[m.index + m[0].length] === "*") continue; // `--departure-*`
    out.add(m[0].replace(/-+$/, "")); // drop any accidental trailing hyphen
  }
  return [...out];
}

/** Whole-token membership so `--page` is NOT satisfied by `--page-size`: the
 *  flag must not be immediately followed by another flag-name character. */
function hasFlag(haystack: string, flag: string): boolean {
  return new RegExp(`${flag}(?![a-z0-9-])`).test(haystack);
}

/** Collect `"--flag (CONSTANT_NAME)"` for every usage flag missing from `target`. */
function missingFrom(target: string): string[] {
  const missing: string[] = [];
  for (const [name, usage] of Object.entries(USAGE_CONSTANTS)) {
    for (const flag of flagsIn(usage)) {
      if (!hasFlag(target, flag)) missing.push(`${flag} (${name})`);
    }
  }
  return missing;
}

/** The enum values a usage constant advertises, as `[flag, value]` pairs. */
function enumValuesIn(text: string): [string, string][] {
  const out = new Map<string, [string, string]>();
  const unwrapped = text.replace(/\n {30}/g, "");
  for (const m of unwrapped.matchAll(
    /--([a-z][a-z0-9-]*)(?: VALUE)?\s+([a-z_]+(?:\|[a-z_]+)+)/g,
  )) {
    for (const value of m[2].split("|")) {
      out.set(`${m[1]}=${value}`, [m[1], value]);
    }
  }
  return [...out.values()];
}

/** Whether `word` appears in `line` delimited, not inside a longer identifier. */
function hasWord(line: string, word: string): boolean {
  const extends_ = (ch: string | undefined) =>
    ch !== undefined && /[a-z0-9_]/i.test(ch);
  let from = 0;
  for (;;) {
    const at = line.indexOf(word, from);
    if (at === -1) return false;
    if (!extends_(line[at - 1]) && !extends_(line[at + word.length])) {
      return true;
    }
    from = at + 1;
  }
}

/** Whether `target` documents `value` against `--flag`, not as loose prose. */
function documentsValue(target: string, flag: string, value: string): boolean {
  const token = `--${flag}`;
  return target
    .split("\n")
    .some(
      (line) => hasWord(line, token) && line !== token && hasWord(line, value),
    );
}

/** Collect `"--flag=value (CONSTANT_NAME)"` for every enum value missing from `target`. */
function missingValuesFrom(target: string): string[] {
  const missing: string[] = [];
  for (const [name, usage] of Object.entries(USAGE_CONSTANTS)) {
    for (const [flag, value] of enumValuesIn(usage)) {
      if (!documentsValue(target, flag, value)) {
        missing.push(`--${flag}=${value} (${name})`);
      }
    }
  }
  return missing;
}

describe("skill-sync: usage flags ↔ SKILL.md ↔ root help", () => {
  it("every --flag documented in a *_USAGE constant appears in SKILL.md", () => {
    // A non-empty result lists exactly which flag(s) drifted out of the skill.
    expect(missingFrom(SKILL_MD)).toEqual([]);
  });

  it("root help names every command group, and each group names every leaf", () => {
    const rowsOf = (text: string) =>
      [...text.matchAll(/^ {2}([a-z-]+) /gm)].map((m) => m[1]);
    expect(rowsOf(ROOT_HELP)).toEqual(
      expect.arrayContaining(["flights", "hotels", "info", "places", "login"]),
    );
    expect(rowsOf(FLIGHTS_USAGE)).toEqual(
      expect.arrayContaining([
        "search",
        "results",
        "trip",
        "experience",
        "fares",
        "booking-link",
        "share",
      ]),
    );
    expect(rowsOf(HOTELS_USAGE)).toEqual(
      expect.arrayContaining([
        "search",
        "results",
        "details",
        "reviews",
        "rooms",
        "booking-link",
        "share",
      ]),
    );
    // `info target` is the one leaf deliberately absent from its group index: it
    // reports which backend the binary resolved, which is a diagnostic about an
    // axis no public user can move. The command still runs and still has its own
    // `--help`; it is unlisted, not removed. Asserted NOT to be here so that
    // re-adding the row is a deliberate act rather than a silent one.
    expect(rowsOf(INFO_USAGE)).toEqual(
      expect.arrayContaining([
        "holidays",
        "visa-free",
        "schedules",
        "airports-near",
      ]),
    );
    expect(rowsOf(INFO_USAGE)).not.toContain("target");
  });

  // The flag-name checks pass while a flag's value set is absent; that shipped once.
  it("every enum VALUE a *_USAGE constant advertises appears in SKILL.md", () => {
    expect(missingValuesFrom(SKILL_MD)).toEqual([]);
  });
});
