import { readFile } from "node:fs/promises";
import { z } from "zod";
import { writeOwnerJson } from "./config-dir";

/**
 * User-owned travel preferences (issue #1386), in `~/.config/<scope>/settings.json`.
 *
 * Currency, market and locale all change the numbers a traveller is shown, so
 * they must be visible and settable. The precedence chain is
 *
 *   flag on this command  >  this file  >  account market (site only)  >  server default
 *
 * There is no env var on purpose: `--currency`, `--site` and `--locale` already
 * give a per-run override, and it is visible in the command line, which is where
 * a repricing decision belongs.
 *
 * Not stored in `credentials.json`: `logout` deletes that, and a preference must
 * survive it. Written 0600 in the 0700 dir like every other file there, not
 * because a currency is secret but because `config-dir.ts` owns that rule.
 */

/** In the order `config list` prints them. */
export const SETTINGS_KEYS = ["currency", "site", "locale"] as const;

export type SettingsKey = (typeof SETTINGS_KEYS)[number];

/** Same bound the API's `localeQuery` uses (`apps/api/src/flights/schema.ts`). */
const MAX_LOCALE_LEN = 35;

/** Mirrors the API's own validation so a value this file accepts can never be
 *  rejected by the API afterwards: a local exit 2 is better than a round-tripped
 *  400.
 *
 *  Strict, not stripping: `{"curreny":"SAR"}` must not parse to `{}`. A plain
 *  `z.object` drops the unknown key, the file reads as empty, and the command
 *  silently reprices in USD. */
const UserSettingsSchema = z.strictObject({
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, {
      message: "currency must be a 3-letter ISO 4217 code (e.g. SAR)",
    })
    .optional(),
  site: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, {
      message: "site must be a 2-letter market code (e.g. SA)",
    })
    .optional(),
  locale: z
    .string()
    .trim()
    .min(1, { message: "locale must not be empty" })
    .max(MAX_LOCALE_LEN, {
      message: `locale must be <= ${MAX_LOCALE_LEN} characters`,
    })
    .optional(),
});

export type UserSettings = z.infer<typeof UserSettingsSchema>;

/** Thrown for a settings file that exists but cannot be used. Carries the path
 *  so the caller can name it; an unnamed file is hard to fix. */
export class SettingsFileError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "SettingsFileError";
  }
}

/** Replaces zod's "Unrecognized key": a misspelled key is only fixable next to
 *  the list of the real ones. */
function unknownKeysMessage(keys: readonly (string | number)[]): string {
  const named = keys.map((key) => `"${key}"`).join(", ");
  const plural = keys.length > 1 ? "s" : "";
  return `unknown setting${plural} ${named}; the settings are ${SETTINGS_KEYS.join(", ")}`;
}

/** Join the issue messages without `formatZodError`'s field prefix: every message
 *  here already names its field ("currency must be a 3-letter…"), so prefixing
 *  would print the field twice. */
function messages(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      issue.code === "unrecognized_keys"
        ? unknownKeysMessage(issue.keys)
        : issue.message,
    )
    .join("; ");
}

/** Validate one `key=value` pair, returning the normalized (trimmed/uppercased)
 *  value. Used by `config set` before anything is written. */
export function parseSettingValue(key: SettingsKey, value: string): string {
  const result = UserSettingsSchema.safeParse({ [key]: value });
  if (!result.success) throw new Error(messages(result.error));
  // The key was just parsed as present, so the normalized value is defined.
  return result.data[key] as string;
}

/**
 * Read the settings file. Absent ⇒ `{}` (the whole chain then falls through to
 * the account market and the server defaults).
 *
 * A file that exists but does not parse throws, unlike `telemetry-state.ts`,
 * which fails closed because it may hold an opt-out. Here a discarded value
 * would silently reprice a result.
 */
export async function loadUserSettings(path: string): Promise<UserSettings> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    // ENOENT only. `ENOTDIR` means a component of the path is a file, so the
    // stored preferences are unreachable; reporting that as "no preferences"
    // would price in USD and never say why.
    if (code === "ENOENT") return {};
    throw new SettingsFileError(
      `settings.json could not be read: ${(err as Error).message}`,
      path,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new SettingsFileError(
      `settings.json is not valid JSON: ${(err as Error).message}`,
      path,
    );
  }
  const parsed = UserSettingsSchema.safeParse(json);
  if (!parsed.success) {
    throw new SettingsFileError(
      `settings.json is not valid: ${messages(parsed.error)}`,
      path,
    );
  }
  return parsed.data;
}

export async function saveUserSettings(
  path: string,
  settings: UserSettings,
): Promise<void> {
  await writeOwnerJson(path, settings);
}

/** The query fields a command may inherit. Named per command by the caller, not
 *  inferred from the object: `places` and `info holidays` accept a `siteCode`
 *  key that must never carry the user's market (place resolution is
 *  market-neutral by design; a holidays site code is the country in the path). */
export type PreferenceKey = "currency" | "locale";

interface TravelQuery {
  currency?: string;
  locale?: string;
}

/**
 * Only fills an absent key, so a flag always wins.
 *
 * `site` is not handled here: it needs the account-market rung too, so it goes
 * through {@link resolveCliSite} in `commands.ts` instead.
 */
export function applyPreferences<T extends TravelQuery>(
  query: T,
  settings: UserSettings,
  keys: readonly PreferenceKey[] = ["currency", "locale"],
): T {
  const merged = { ...query };
  for (const key of keys) {
    if (merged[key] === undefined && settings[key] !== undefined) {
      merged[key] = settings[key];
    }
  }
  return merged;
}
