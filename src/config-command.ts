import { isHelpArg } from "./commands";
import { EXIT } from "./error-report";
import {
  parseSettingValue,
  SETTINGS_KEYS,
  type SettingsKey,
  type UserSettings,
} from "./settings";
import { usage, usageErrorLabel } from "./usage";

/**
 * `wego config list|set|unset`: the travel preferences in `settings.json`
 * (issue #1386). Named `config-command.ts` because `config.ts` is the
 * endpoint and env loader.
 *
 * `list` prints every value with the layer that decided it, like
 * `git config --list --show-origin`, so a local settings file never changes
 * results invisibly.
 */

export const CONFIG_USAGE = usage({
  cmd: "config list",
  alt: [
    `config set <${SETTINGS_KEYS.join("|")}> <value>`,
    `config unset <${SETTINGS_KEYS.join("|")}>`,
  ],
  what: "Show or set the currency, market and language used when a command names none.",
  note: `A flag on a command always wins, then these settings, then your account market, then the default (USD, en, US). Stored in settings.json; config list prints the path.`,
});

/** Which layer decided an effective value. `explicit` is absent by construction:
 *  `config list` takes no travel flags, so no flag can be in force here. */
export type SettingSource = "setting" | "account" | "default";

export interface EffectiveSetting {
  /** `null` when no layer supplied one and the API's own default applies. */
  value: string | null;
  source: SettingSource;
}

export interface ConfigCommandDeps {
  log: (message: string) => void;
  error: (message: string) => void;
  settingsPath: string;
  loadSettings: () => Promise<UserSettings>;
  saveSettings: (settings: UserSettings) => Promise<void>;
  /** The market decoded from the id_token at login (the `account` source).
   *  `undefined` when logged out or when the token carried no country_code. */
  accountMarket: () => Promise<string | undefined>;
}

/** Only `site` has an `account` layer: the API cannot derive a market itself
 *  (see `apps/api/src/site-code.ts`), and the id_token carries no currency or
 *  locale. */
export function effectiveSettings(
  settings: UserSettings,
  accountMarket: string | undefined,
): Record<SettingsKey, EffectiveSetting> {
  const plain = (value: string | undefined): EffectiveSetting =>
    value === undefined
      ? { value: null, source: "default" }
      : { value, source: "setting" };
  return {
    currency: plain(settings.currency),
    site: effectiveSite(settings.site, accountMarket),
    locale: plain(settings.locale),
  };
}

/** The stored setting wins, else the market decoded from the id_token, else the
 *  API's US floor. */
function effectiveSite(
  setting: string | undefined,
  accountMarket: string | undefined,
): EffectiveSetting {
  if (setting !== undefined) return { value: setting, source: "setting" };
  if (accountMarket !== undefined) {
    return { value: accountMarket, source: "account" };
  }
  return { value: null, source: "default" };
}

function isSettingsKey(value: string): value is SettingsKey {
  return (SETTINGS_KEYS as readonly string[]).includes(value);
}

async function report(deps: ConfigCommandDeps): Promise<number> {
  const settings = await deps.loadSettings();
  const effective = effectiveSettings(settings, await deps.accountMarket());
  deps.log(JSON.stringify({ ...effective, path: deps.settingsPath }, null, 2));
  return EXIT.OK;
}

function usageError(deps: ConfigCommandDeps, message: string): number {
  deps.error(`${message}\n${CONFIG_USAGE}`);
  return EXIT.USAGE;
}

/** An option if it looks like a flag, an argument otherwise: the same wording
 *  `telemetry` uses. */
function unexpected(deps: ConfigCommandDeps, token: string): number {
  return usageError(deps, `${usageErrorLabel(token)}: ${token}`);
}

async function runList(
  args: readonly string[],
  deps: ConfigCommandDeps,
): Promise<number> {
  const extra = args[1];
  if (extra !== undefined) return unexpected(deps, extra);
  return report(deps);
}

async function runUnset(
  key: SettingsKey,
  args: readonly string[],
  deps: ConfigCommandDeps,
): Promise<number> {
  if (args[2] !== undefined) return unexpected(deps, args[2]);
  // Read-modify-write on the whole file: an invalid file throws here rather than
  // being silently replaced by a one-key rewrite.
  const next = { ...(await deps.loadSettings()) };
  delete next[key];
  await deps.saveSettings(next);
  return report(deps);
}

async function runSet(
  key: SettingsKey,
  args: readonly string[],
  deps: ConfigCommandDeps,
): Promise<number> {
  const raw = args[2];
  if (raw === undefined) return usageError(deps, `set ${key} needs a value`);
  if (args[3] !== undefined) return unexpected(deps, args[3]);
  let value: string;
  try {
    // Validate against the same rules the API applies, so a value accepted here
    // can never come back as a 400 on the next search.
    value = parseSettingValue(key, raw);
  } catch (err) {
    return usageError(deps, (err as Error).message);
  }
  const current = await deps.loadSettings();
  await deps.saveSettings({ ...current, [key]: value });
  return report(deps);
}

export async function config(
  args: readonly string[],
  deps: ConfigCommandDeps,
): Promise<number> {
  if (isHelpArg([...args])) {
    deps.log(CONFIG_USAGE);
    return EXIT.OK;
  }
  const action = args[0] ?? "list";
  if (action === "list") return runList(args, deps);
  if (action !== "set" && action !== "unset") {
    return usageError(
      deps,
      `${action.startsWith("-") ? "Unknown option" : "Unknown subcommand"}: ${action}`,
    );
  }
  const key = args[1];
  if (key === undefined) return usageError(deps, `${action} needs a key`);
  if (!isSettingsKey(key)) return usageError(deps, `Unknown setting: ${key}`);
  return action === "unset"
    ? runUnset(key, args, deps)
    : runSet(key, args, deps);
}
