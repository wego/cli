import { readFile } from "node:fs/promises";
import { z } from "zod";
import { writeOwnerJson } from "./config-dir";

/**
 * User-owned travel preferences (issue #1386) — `~/.config/<scope>/settings.json`.
 *
 * Currency, market and locale all change the numbers a traveller is shown, and
 * before this file both were decided invisibly: `--currency` was a per-request
 * flag defaulting to USD server-side, and the market lived inside
 * `credentials.json` where nothing could print it. The precedence chain is
 *
 *   flag on this command  >  this file  >  account market (site only)  >  server default
 *
 * There is deliberately **no env rung**: `--currency` / `--site` / `--locale`
 * already give a per-run override, and it is visible in the command line, which
 * is where a repricing decision belongs.
 *
 * Not stored in `credentials.json`: `logout` deletes that, and a preference must
 * survive it. Written 0600 in the 0700 dir like every other file there, not
 * because a currency is secret but because `config-dir.ts` owns that rule.
 */

/** The three keys, in the order `config list` prints them. */
export const SETTINGS_KEYS = ["currency", "site", "locale"] as const;

export type SettingsKey = (typeof SETTINGS_KEYS)[number];

/** Same bound the API's `localeQuery` uses (`apps/api/src/flights/schema.ts`). */
const MAX_LOCALE_LEN = 35;

/** Mirrors the API's own validation so a value this file accepts can never be
 *  rejected by the API afterwards — a local 2 beats a round-tripped 400.
 *
 *  STRICT, not stripping: `{"curreny":"SAR"}` must not parse to `{}`. A plain
 *  `z.object` drops the unknown key, the file reads as empty, and the command
 *  reprices in USD without a word — the exact silent-wrong-answer failure this
 *  file exists to remove, now caused by a typo in the file it advertises. */
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
 *  so the caller can name it — "works on my machine" is the failure mode a
 *  settings file invites, and an unnamed file is unfixable. */
export class SettingsFileError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "SettingsFileError";
  }
}

/** Zod's own wording for a rejected key is "Unrecognized key". Replace it: a
 *  misspelled key is only fixable next to the list of the real ones. */
function unknownKeysMessage(keys: readonly (string | number)[]): string {
  const named = keys.map((key) => `"${key}"`).join(", ");
  const plural = keys.length > 1 ? "s" : "";
  return `unknown setting${plural} ${named}; the settings are ${SETTINGS_KEYS.join(", ")}`;
}

/** Join the issue messages WITHOUT `formatZodError`'s field prefix: every message
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
 * A file that exists but does not parse **throws**, deliberately unlike
 * `telemetry-state.ts`, which fails closed because it may hold an opt-out.
 * Here a discarded value silently reprices a result, which is exactly the
 * confident-wrong-answer bug this file exists to remove — so it fails loud.
 */
export async function loadUserSettings(path: string): Promise<UserSettings> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    // ENOENT only. `ENOTDIR` means a component of the path is a FILE, so the
    // preferences the user stored are unreachable — reporting that as "no
    // preferences" would price in USD and never say why.
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
  // Staged 0600 write through the one helper that owns the mode rule.
  await writeOwnerJson(path, settings);
}

/** The query fields a command may inherit. Named per command by the caller, not
 *  inferred from the object: `places` and `info holidays` accept a `siteCode`
 *  key that must NEVER carry the user's market (place resolution is
 *  market-neutral by design; a holidays site code is the country in the path). */
export type PreferenceKey = "currency" | "locale";

interface TravelQuery {
  currency?: string;
  locale?: string;
}

/**
 * Fill the named preference fields that the caller did not pass as flags. Only
 * ever fills an ABSENT key, so a flag always wins — the top rung of the chain.
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
