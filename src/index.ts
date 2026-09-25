#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import {
  appendFile,
  chmod,
  open,
  readdir,
  readFile,
  rename,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { $ } from "bun";
import {
  type AnalyticsHeaders,
  createFlightSearch,
  createHotelSearch,
  fetchBookingLink,
  fetchFareOptions,
  fetchFlightResults,
  fetchFlightTrip,
  fetchHolidays,
  fetchHotelBookingLink,
  fetchHotelDetails,
  fetchHotelRates,
  fetchHotelResults,
  fetchHotelReviews,
  fetchHotelSearchLink,
  fetchNearbyPlaces,
  fetchPlaces,
  fetchSchedules,
  fetchSearchLink,
  fetchTripExperience,
  fetchVisaFree,
  fetchWhoami,
  sendFeedback,
  setAnalyticsHeaders,
  setIdentityAssertion,
} from "./api";
import { type AuthFailureRecord, recordAuthFailure } from "./auth-failure";
import { openBrowser } from "./browser";
import {
  type CommandIo,
  feedback,
  flights,
  hotels,
  info,
  isHelpArg,
  LOGIN_USAGE,
  LOGOUT_USAGE,
  login,
  logout,
  places,
  VERSION_USAGE,
  WHOAMI_USAGE,
  whoami,
} from "./commands";
import {
  type CliConfig,
  defaultAuthFailurePath,
  defaultCredentialsPath,
  defaultInstallRecordPath,
  defaultSessionPath,
  defaultSettingsPath,
  defaultTelemetryPath,
  defaultUpdateCheckPath,
  loadCliConfig,
  resolveCliTarget,
  resolveConfigScope,
} from "./config";
import { config as configCommand } from "./config-command";
import { ensureOwnerDir } from "./config-dir";
import { loadSourceEnvLocal } from "./env-local";
import { EXIT, exitCodeForError, formatCliError } from "./error-report";
import { startLoopback } from "./loopback";
import { exchangeCode, isIdTokenUsable, refreshTokens } from "./oauth";
import { isRemoteShell, waitForPastedCallback } from "./paste-callback";
import { programName, runningFromSource } from "./program-name";
import { confirmTty } from "./prompt";
import { FULCIO_ROOTS_PEM } from "./release-signing";
import { parseInstallRecord } from "./ring-follow";
import { clearSession, isUuid, resolveSession } from "./session";
import {
  loadUserSettings,
  saveUserSettings,
  type UserSettings,
} from "./settings";
import { defaultUserSkillDir, skill } from "./skill";
import { SKILLS } from "./skill-embed";
import { clearCredentials, loadCredentials, saveCredentials } from "./storage";
import { stripTargetFlag } from "./target";
import {
  EPHEMERAL_DEVICE_ID,
  isTelemetrySender,
  maybeSendTelemetry,
  parseTelemetryMode,
  resolveCommand,
  TELEMETRY_SENDER_COMMAND,
  type TelemetryDeps,
  uidFromAccessToken,
} from "./telemetry";
import { telemetry } from "./telemetry-command";
import {
  INLINE_TIMEOUT_MS,
  runTelemetrySender,
  spawnTelemetrySender,
} from "./telemetry-send";
import {
  loadTelemetryState,
  persistDeviceId,
  setTelemetryEnabled,
} from "./telemetry-state";
import { uninstall } from "./uninstall";
import { update } from "./update";
import { indexRow, usageErrorLabel } from "./usage";
import {
  isOptedOut,
  maybeNotifyNewVersion,
  type VersionNoticeDeps,
} from "./version-notice";

/**
 * `wego` CLI entrypoint. A public PKCE OAuth client: `wego login` authenticates
 * over a loopback redirect, then every command calls the API as the logged-in
 * user. An agent shells out to the same commands and reuses the stored session.
 */

// Baked at build time: `bun build --env 'WEGO_BUILD_*'` (set by build-release.ts
// from the release tag) inlines this static read. Unset when run from source.
const VERSION = process.env.WEGO_BUILD_VERSION ?? "0.0.0-dev";

// No channel base is baked: which ring an install follows is a record on the
// machine (`ring-follow.ts`), read by both `update` and the new-version notice so
// the two cannot drift.
const BUILD_API_URL = process.env.WEGO_BUILD_API_URL;
// Write-only PostHog key; absent means telemetry stays silent.
const POSTHOG_KEY = process.env.WEGO_BUILD_POSTHOG_PROJECT_KEY || undefined;

// Closest we get to process start, for the telemetry event's `duration_ms`.
const STARTED_AT = Date.now();

const COMMANDS: readonly (readonly [string, string])[] = [
  ["login", "Log in with your Wego account"],
  ["whoami", "Show who is logged in"],
  ["logout", "Remove the stored login"],
  ["places", "Find a city, airport or hotel by name"],
  ["info", "Holidays, visa-free countries, flight timetables, nearby airports"],
  ["flights", "Search flights, open a trip, get a booking link"],
  ["hotels", "Search hotels, open one, list rooms, get a booking link"],
  ["config", "Show or set currency, market and language"],
  ["feedback", "Send feedback to Wego"],
  ["skill", "Install the agent skill"],
  ["update", "Update to the latest release"],
  ["uninstall", "Remove this install"],
  ["telemetry", "Show or change usage reporting"],
  ["version", "Show the version"],
];

export function helpText(prog: string): string {
  return [
    `${prog} – Wego API CLI (Research Preview)`,
    `Early and may change. Tell us how it went: \`${prog} feedback\`.`,
    "",
    `Usage: ${prog} <command> [flags]`,
    "",
    ...COMMANDS.flatMap(([name, text]) => indexRow(name, text)),
    "",
    "Env:",
    ...indexRow("WEGO_CLI_TELEMETRY", "on | off | log"),
    ...indexRow(
      "WEGO_CREDENTIALS_PATH",
      "Where the login is stored. Default ~/.config/wego/credentials.json",
    ),
    "",
    `Run ${prog} <command> --help for flags.`,
  ].join("\n");
}

export interface RunDeps {
  loadConfig: () => CliConfig;
  io: CommandIo;
  login: (config: CliConfig, args: string[]) => Promise<number>;
  whoami: (config: CliConfig) => Promise<number>;
  places: (config: CliConfig, args: string[]) => Promise<number>;
  info: (config: CliConfig, args: string[]) => Promise<number>;
  flights: (config: CliConfig, args: string[]) => Promise<number>;
  hotels: (config: CliConfig, args: string[]) => Promise<number>;
  feedback: (config: CliConfig, args: string[]) => Promise<number>;
  skill: (args: string[]) => Promise<number>;
  update: (args: string[]) => Promise<number>;
  uninstall: (args: string[]) => Promise<number>;
  /** Local preferences only, so it takes no `CliConfig`. */
  config: (args: string[]) => Promise<number>;
  telemetry: (args: string[]) => Promise<number>;
  /** The hidden subcommand the detached child runs, through the same seam. */
  sendTelemetry: (args: string[]) => Promise<number>;
  logout: (config: CliConfig) => Promise<number>;
}

function ownUsage(command: string | undefined): string | undefined {
  switch (command) {
    case "login":
      return LOGIN_USAGE;
    case "whoami":
      return WHOAMI_USAGE;
    case "logout":
      return LOGOUT_USAGE;
    case "version":
    case "--version":
    case "-v":
      return VERSION_USAGE;
    default:
      return undefined;
  }
}

function configFor(deps: RunDeps, args: string[]): CliConfig {
  const helpShaped = isHelpArg(args) || isHelpArg(args.slice(1));
  if (!helpShaped) return deps.loadConfig();
  let loaded: CliConfig | undefined;
  return new Proxy({} as CliConfig, {
    get(_target, key) {
      loaded ??= deps.loadConfig();
      return Reflect.get(loaded, key);
    },
  });
}

export async function run(rawArgv: string[], deps: RunDeps): Promise<number> {
  // `--target` is a global switch already resolved by `loadConfig`. It is removed
  // before dispatch because every command parser rejects arguments it does not
  // know, and that is better than an exception in each parser.
  const argv = stripTargetFlag(rawArgv);
  const command = argv[2];
  const args = argv.slice(3);
  const own = ownUsage(command);
  if (own) {
    if (isHelpArg(args)) {
      deps.io.log(own);
      return 0;
    }
    const extra = command === "login" ? undefined : args[0];
    if (extra !== undefined) {
      deps.io.error(`${usageErrorLabel(extra)}: ${extra}\n${own}`);
      return EXIT.USAGE;
    }
  }
  switch (command) {
    case "login":
      return deps.login(deps.loadConfig(), args);
    case "whoami":
      return deps.whoami(deps.loadConfig());
    case "places":
      return deps.places(configFor(deps, args), args);
    case "info":
      return deps.info(configFor(deps, args), args);
    case "flights":
      return deps.flights(configFor(deps, args), args);
    case "hotels":
      return deps.hotels(configFor(deps, args), args);
    case "feedback":
      return deps.feedback(configFor(deps, args), args);
    // These five need no endpoints or credentials, so they get no CLI config.
    case "skill":
      return deps.skill(argv.slice(3));
    case "update":
      return deps.update(argv.slice(3));
    case "uninstall":
      return deps.uninstall(argv.slice(3));
    case "config":
      return deps.config(argv.slice(3));
    case "telemetry":
      return deps.telemetry(argv.slice(3));
    // Hidden: the detached child, deliberately absent from `helpText`.
    case TELEMETRY_SENDER_COMMAND:
      return deps.sendTelemetry(argv.slice(3));
    case "logout":
      return deps.logout(deps.loadConfig());
    case "version":
    case "--version":
    case "-v":
      deps.io.log(VERSION);
      return 0;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      if (args[0] !== undefined && !isHelpArg(args)) {
        deps.io.error(
          `${usageErrorLabel(args[0])}: ${args[0]}\n${helpText(programName())}`,
        );
        return EXIT.USAGE;
      }
      deps.io.log(helpText(programName()));
      return 0;
    default:
      deps.io.error(
        `Unknown command: ${command}\n\n${helpText(programName())}`,
      );
      // A usage error like every other bad-argument failure, not the generic 1.
      return EXIT.USAGE;
  }
}

/** The `skill` command's dependency bundle, shared by `skill` and `uninstall`'s
 *  skill-removal step. `extra` carries the unattended-caller policies described
 *  on `SkillDeps`. */
function buildSkillDeps(
  io: CommandIo,
  extra: {
    timeoutMs?: number;
    requireRemote?: boolean;
    refreshOnly?: boolean;
  } = {},
) {
  const ring = recordedRing();
  return {
    ...io,
    skills: SKILLS,
    version: VERSION,
    // Stamped into the ownership marker, so another channel's install can tell
    // this skill is not its to maintain.
    ring,
    homedir: () => homedir(),
    cwd: () => process.cwd(),
    confirm: confirmTty,
    // The skill channel is gone: no `skillUrl` and no `fetchRemoteSkill` are
    // supplied, so `install` always uses the copy embedded in this binary.
    requireRemote: extra.requireRemote,
    refreshOnly: extra.refreshOnly,
  };
}

/** `undefined` when the record is absent, unreadable or malformed (a pre-ring
 *  install, or a from-source run). Not a refusal like `update`'s: knowing no
 *  ring just disables the cross-channel guard. */
function recordedRing(): string | undefined {
  try {
    return parseInstallRecord(readFileSync(defaultInstallRecordPath(), "utf8"))
      ?.ring;
  } catch {
    return undefined;
  }
}

/** The installer's record for this binary, read fresh. Absent, unreadable and
 *  malformed all collapse to `null`, which both callers refuse on rather than
 *  substitute a ring. One reader for both, so the two cannot drift apart. */
async function readOwnInstallRecord() {
  return parseInstallRecord(
    await readFile(defaultInstallRecordPath(), "utf8").catch(() => null),
  );
}

/** Real wiring for the new-version notice (`version-notice.ts` explains each
 *  guard). */
export function buildVersionNoticeDeps(): VersionNoticeDeps {
  const statePath = defaultUpdateCheckPath();
  return {
    command: process.argv[2],
    fromSource: runningFromSource(),
    version: VERSION,
    // A renamed install (`WEGO_CLI_BIN`) must be told to run its own name, so
    // the notice's `… update -y` hint names a command that exists.
    invokedAs: programName(),
    // Same reader and path as `update`, so the two never name different rings.
    // The record describes where the binary came from, so it does not move with
    // `--target`.
    readInstallRecord: readOwnInstallRecord,
    env: process.env,
    now: Date.now(),
    fetch,
    readState: async () => {
      // Opened rather than `stat`ed by path so this stays correct if
      // `claimWindow` ever starts replacing the file.
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(statePath, "r");
        // The mtime is the whole record. The content is never written: a stored
        // answer would be half of a comparison whose other half changes on every
        // update and reinstall.
        return { checkedAt: (await handle.stat()).mtimeMs };
      } catch {
        // Absent or unreadable: the caller does a fresh check rather than guess.
        return null;
      } finally {
        await handle?.close().catch(() => {});
      }
    },
    claimWindow: async () => {
      try {
        await ensureOwnerDir(dirname(statePath));
        // Append creates the file if absent without truncating. It stays empty;
        // the mtime is the record.
        await appendFile(statePath, "", { mode: 0o600 });
        const now = new Date();
        await utimes(statePath, now, now);
        return true;
      } catch {
        // An unstampable path means the throttle would not hold, so the caller
        // skips the network read instead of re-fetching on every command.
        return false;
      }
    },
  };
}

export function buildRealDeps(): RunDeps {
  const io: CommandIo = {
    log: (m) => console.log(m),
    error: (m) => console.error(m),
  };
  const skillDeps = buildSkillDeps(io);
  // Derived like `loadCliConfig` does, but without requiring the full baked
  // config, so `uninstall` runs from source too. `resolveConfigScope` because on
  // a non-prod target the store is also keyed by the auth host, and this must
  // land on the same file the command reads.
  const configScope = resolveConfigScope();
  const credentialsPath =
    process.env.WEGO_CREDENTIALS_PATH?.trim() ||
    defaultCredentialsPath(process.env, configScope);
  const telemetryPath = defaultTelemetryPath();
  const settingsPath = defaultSettingsPath();
  // Not keyed by `configScope`: the record describes where the binary came from,
  // so it must not move when `--target` picks a different auth host.
  const installRecordPath = defaultInstallRecordPath();
  // Memoized: one command resolves preferences at several points, and a re-read
  // mid-command could price the create and its follow-up read differently. Also
  // keeps a broken file to one parse error.
  let settingsOnce: Promise<UserSettings> | undefined;
  const loadSettings = (): Promise<UserSettings> =>
    (settingsOnce ??= loadUserSettings(settingsPath));
  // Why a token refresh failed. Its own file, not credentials.json, because
  // logout and re-login delete that and would erase the only evidence. Scoped
  // like the credentials: a staging failure in the prod store would read as a
  // prod outage.
  const authFailurePath = defaultAuthFailurePath(process.env, configScope);
  const authed = {
    loadCredentials,
    saveCredentials,
    refreshTokens,
    loadSettings,
    recordAuthFailure: (record: AuthFailureRecord) =>
      recordAuthFailure(authFailurePath, record),
  };
  return {
    loadConfig: () => loadCliConfig(),
    io,
    login: (config, args) =>
      login(
        config,
        {
          ...io,
          startLoopback,
          openBrowser,
          exchangeCode,
          saveCredentials,
          waitForPastedCallback,
          isRemoteShell,
        },
        args,
      ),
    whoami: (config) =>
      whoami(config, {
        ...io,
        ...authed,
        fetchWhoami,
      }),
    places: (config, args) =>
      places(config, args, {
        ...io,
        ...authed,
        fetchPlaces,
      }),
    info: (config, args) =>
      info(config, args, {
        ...io,
        ...authed,
        fetchHolidays,
        fetchVisaFree,
        fetchSchedules,
        fetchNearbyPlaces,
      }),
    flights: (config, args) =>
      flights(config, args, {
        ...io,
        ...authed,
        createFlightSearch,
        fetchFlightResults,
        fetchFlightTrip,
        fetchTripExperience,
        fetchFareOptions,
        fetchBookingLink,
        fetchSearchLink,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      }),
    hotels: (config, args) =>
      hotels(config, args, {
        ...io,
        ...authed,
        createHotelSearch,
        fetchHotelResults,
        fetchHotelDetails,
        fetchHotelRates,
        fetchHotelReviews,
        fetchHotelBookingLink,
        fetchHotelSearchLink,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      }),
    feedback: (config, args) =>
      feedback(config, args, {
        ...io,
        ...authed,
        sendFeedback,
        version: VERSION,
      }),
    skill: (args) => skill(args, skillDeps),
    update: (args) =>
      update(args, {
        ...io,
        version: VERSION,
        fromSource: runningFromSource(),
        installRecordPath,
        readInstallRecord: readOwnInstallRecord,
        installUrl: BUILD_API_URL
          ? `${BUILD_API_URL.replace(/\/+$/, "")}/install`
          : undefined,
        platform: process.platform,
        arch: process.arch,
        execPath: process.execPath,
        fetch,
        // The runtime is embedded, so gunzip is free; ~64 MB in memory is fine.
        gunzip: (data) => Bun.gunzipSync(data),
        // Stream the sha256 so a 60–95 MB binary isn't held in memory twice.
        hashFile: async (path) => {
          const hasher = new Bun.CryptoHasher("sha256");
          for await (const chunk of Bun.file(path).stream()) {
            hasher.update(chunk);
          }
          return hasher.digest("hex");
        },
        writeFile: (path, data) => writeFile(path, data),
        chmod: (path, mode) => chmod(path, mode),
        rename: (from, to) => rename(from, to),
        rm: (path) => rm(path, { force: true }),
        clearQuarantine: async (path) => {
          // Best-effort: the xattr or the tool may be absent (Linux, or a file
          // never quarantined), and that must not fail the update.
          await $`xattr -d com.apple.quarantine ${path}`.quiet().nothrow();
        },
        confirm: confirmTty,
        // Runs the new binary (`execPath` after the swap), not this process,
        // because the embedded body to write is the new one. `--owned-only`
        // creates no new folders; `-y` because there is no one to prompt.
        // Output is discarded: `update` already printed its line, and stdout is
        // a JSON contract for the agent funnels.
        spawnSkillInstall: async (execPath) => {
          await Bun.spawn(
            [execPath, "skill", "install", "--owned-only", "-y"],
            {
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
            },
          ).exited;
        },
        trustedRootsPem: FULCIO_ROOTS_PEM,
        // Same dir as the binary, so the rename is atomic (same filesystem);
        // unique per run, so concurrent runs cannot collide.
        tempPath: `${process.execPath}.${crypto.randomUUID()}.tmp`,
        sweepTemps: async () => {
          // Leftovers from an interrupted run (SIGINT skips the in-flow
          // cleanup). Best-effort.
          try {
            const dir = dirname(process.execPath);
            const prefix = `${basename(process.execPath)}.`;
            for (const f of await readdir(dir)) {
              if (f.startsWith(prefix) && f.endsWith(".tmp")) {
                await rm(join(dir, f), { force: true });
              }
            }
          } catch {
            /* ignore */
          }
        },
      }),
    uninstall: (args) =>
      uninstall(args, {
        ...io,
        version: VERSION,
        fromSource: runningFromSource(),
        platform: process.platform,
        execPath: process.execPath,
        credentialsPath,
        settingsPath,
        updateCheckPath: defaultUpdateCheckPath(),
        installRecordPath,
        sessionPath: defaultSessionPath(),
        authFailurePath,
        skillPath: defaultUserSkillDir(homedir()),
        telemetryStatePath: telemetryPath,
        telemetryOptedOut: async () =>
          !(await loadTelemetryState(telemetryPath)).enabled,
        rm: (path) => rm(path, { force: true }),
        removeCredentials: () => clearCredentials(credentialsPath),
        removeSkill: async () => {
          // Reuses the skill command's marker-guarded uninstall.
          await skill(["uninstall", "-y"], skillDeps);
        },
        confirm: confirmTty,
      }),
    config: (args) =>
      configCommand(args, {
        ...io,
        settingsPath,
        loadSettings,
        saveSettings: async (next) => {
          await saveUserSettings(settingsPath, next);
          // The report printed after the write must show what was stored, not
          // the memoized pre-write read.
          settingsOnce = Promise.resolve(next);
        },
        // The `account` rung, from the id_token's market stored at login. No
        // network call, so `config` works logged out with one rung fewer.
        accountMarket: async () =>
          (await loadCredentials(credentialsPath))?.market,
      }),
    telemetry: (args) =>
      telemetry(args, {
        ...io,
        env: process.env,
        statePath: telemetryPath,
        loadState: () => loadTelemetryState(telemetryPath),
        setEnabled: (enabled) => setTelemetryEnabled(telemetryPath, enabled),
      }),
    // The child derives the key and the identity itself, so argv carries
    // neither the key nor a forgeable distinct_id.
    sendTelemetry: (args) =>
      runTelemetrySender(args, {
        posthogKey: POSTHOG_KEY,
        fetch,
        resolveIdentity: resolveTelemetryIdentity,
        readStdin: () => Bun.stdin.text(),
      }),
    logout: (config) =>
      logout(config, {
        ...io,
        clearCredentials,
        clearSession: () => clearSession(defaultSessionPath()),
      }),
  };
}

/** True for a command whose point is to forget the user, so telemetry must not
 *  fall back to the identity it read before that command ran. */
export function forgetsIdentity(argv: readonly string[]): boolean {
  return resolveCommand(argv) === "logout";
}

/** False for the detached sender, which re-enters here and would re-create the
 *  file `logout` just deleted, and for the `WEGO_CLI_NO_SESSION` escape hatch. */
export function shouldResolveSession(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): boolean {
  return !isTelemetrySender(argv) && !isOptedOut(env.WEGO_CLI_NO_SESSION);
}

/** Whether to send in-process rather than via a detached child. Windows, because
 *  the detach behaviour was verified on macOS only; a missing binary because
 *  `uninstall` unlinks it before this runs and spawning it would ENOENT. Pure and
 *  exported so the branch is covered without mutating `process.platform`. */
export function shouldSendInline(
  platform: NodeJS.Platform,
  binaryExists: boolean,
): boolean {
  return platform === "win32" || !binaryExists;
}

/** Identity for the sender child, read from this machine rather than argv. */
async function resolveTelemetryIdentity(): Promise<{
  distinctId: string;
  deviceId: string;
}> {
  const credentialsPath =
    process.env.WEGO_CREDENTIALS_PATH?.trim() || defaultCredentialsPath();
  const uid = uidFromAccessToken(
    (await loadCredentials(credentialsPath))?.accessToken,
  );
  const { deviceId } = await loadTelemetryState(defaultTelemetryPath());
  const device = deviceId ?? EPHEMERAL_DEVICE_ID;
  return { distinctId: uid ?? device, deviceId: device };
}

function telemetryPaths(): { telemetryPath: string; credentialsPath: string } {
  return {
    // The machine id is per machine, not per backend: keying it by target would
    // mint a new device per target and inflate device counts. The credentials
    // are keyed by target (see `resolveConfigScope`).
    telemetryPath: defaultTelemetryPath(),
    credentialsPath:
      process.env.WEGO_CREDENTIALS_PATH?.trim() ||
      defaultCredentialsPath(process.env, resolveConfigScope()),
  };
}

/** Identity read BEFORE the command runs, so a command that deletes its own
 *  state (`uninstall`) is still attributable. Used only as a fallback. */
export async function readTelemetrySnapshot(): Promise<{
  uid?: string;
  deviceId?: string;
  idToken?: string;
  telemetryEnabled: boolean;
}> {
  const { telemetryPath, credentialsPath } = telemetryPaths();
  const [creds, state] = await Promise.all([
    loadCredentials(credentialsPath).catch(() => undefined),
    loadTelemetryState(telemetryPath).catch(() => undefined),
  ]);
  // Env wins over the stored setting, as in `maybeSendTelemetry`; `log` sends nothing.
  const mode = parseTelemetryMode(process.env.WEGO_CLI_TELEMETRY);
  const enabled =
    mode === undefined ? (state?.enabled ?? false) : mode === "on";
  return {
    uid: uidFromAccessToken(creds?.accessToken),
    deviceId: state?.deviceId,
    // Filtered here, not at the send: `refreshIdentityAssertion` cannot clear,
    // so arming a dead token would keep it for the whole process.
    idToken: isIdTokenUsable(creds?.idToken) ? creds?.idToken : undefined,
    telemetryEnabled: enabled,
  };
}

/** The device id follows the telemetry opt-out; the session id deliberately does
 *  not. Pure and exported so the consent rule is testable. */
export function resolveAnalyticsHeaders(
  snapshot: { deviceId?: string; telemetryEnabled: boolean },
  sessionId: string | undefined,
): AnalyticsHeaders {
  return {
    // Both checked, so only well-formed uuids are ever sent.
    sessionId: isUuid(sessionId) ? sessionId : undefined,
    clientId:
      snapshot.telemetryEnabled && isUuid(snapshot.deviceId)
        ? snapshot.deviceId
        : undefined,
  };
}

export function buildTelemetryDeps(
  exitCode: number,
  durationMs: number,
  snapshot: { uid?: string; deviceId?: string } = {},
  sessionId?: string,
): TelemetryDeps {
  const { telemetryPath, credentialsPath } = telemetryPaths();
  return {
    // Stripped, like `run`'s: otherwise `wego --target prod places …` would be
    // recorded as the command `--target`.
    argv: stripTargetFlag(process.argv),
    exitCode,
    durationMs,
    fromSource: runningFromSource(),
    target: resolveCliTarget().target,
    posthogKey: POSTHOG_KEY,
    env: process.env,
    version: VERSION,
    platform: process.platform,
    arch: process.arch,
    now: Date.now(),
    sessionId,
    // `enabled` always comes from the live file so a disable mid-run is honored;
    // only the machine id falls back, for the uninstall teardown case.
    loadState: async () => {
      const state = await loadTelemetryState(telemetryPath);
      return state.deviceId ? state : { ...state, deviceId: snapshot.deviceId };
    },
    persistDeviceId: (deviceId) => persistDeviceId(telemetryPath, deviceId),
    // The uid falls back to the pre-run read so `uninstall` stays attributable
    // after it deletes the credentials, but never for `logout`. Otherwise the
    // inline sender (Windows, or a deleted binary) would report the pre-logout
    // account while the detached child reports nobody.
    readUid: async () => {
      const live = uidFromAccessToken(
        (await loadCredentials(credentialsPath))?.accessToken,
      );
      return live ?? (forgetsIdentity(process.argv) ? undefined : snapshot.uid);
    },
    spawnSender: (payload) => {
      // Identity is NOT re-resolved on the inline path: the parent's is
      // authoritative there, and the credentials may already be deleted.
      if (shouldSendInline(process.platform, existsSync(process.execPath))) {
        return runTelemetrySender([payload], {
          posthogKey: POSTHOG_KEY,
          fetch,
          timeoutMs: INLINE_TIMEOUT_MS,
        }).then(() => undefined);
      }
      return spawnTelemetrySender(payload, {
        execPath: process.execPath,
        spawn: (command) =>
          Bun.spawn(command, {
            stdin: "pipe",
            stdout: "ignore",
            stderr: "ignore",
          }),
      });
    },
    // stderr, never stdout: stdout is a JSON contract for the agent funnels.
    printPayload: (payload) => {
      process.stderr.write(`${payload}\n`);
    },
    randomUUID: () => crypto.randomUUID(),
  };
}

if (import.meta.main) {
  // Ctrl-C exits with the conventional 128+SIGINT code and a one-line notice,
  // rather than dying with empty stdout and stderr.
  process.on("SIGINT", () => {
    process.stderr.write("Interrupted.\n");
    process.exit(EXIT.SIGINT);
  });
  // From-source runs load `.env.local` relative to this module, not cwd, so they
  // work from any directory without direnv. A no-op for compiled binaries.
  loadSourceEnvLocal();
  // A bad target stops here as a usage error. Every later caller
  // (`buildRealDeps`, `telemetryPaths`, `loadConfig`) resolves it again, and a
  // throw from them would surface as an unhandled rejection. After
  // `loadSourceEnvLocal`, so a `WEGO_TARGET` in `.env.local` counts.
  try {
    // `resolveConfigScope` rather than `resolveCliTarget` because it also
    // resolves the endpoint bundle, so a bundle that throws is caught here too.
    resolveConfigScope();
  } catch (err) {
    console.error(formatCliError(err, programName()));
    process.exit(EXIT.USAGE);
  }
  // Read before the command so `uninstall`, which deletes both files, still
  // reports which machine and account it came from. Costs about 0.04ms.
  const snapshot = await readTelemetrySnapshot();
  // Resolved here and nowhere else; see `shouldResolveSession`.
  const sessionId = shouldResolveSession(process.argv, process.env)
    ? (await resolveSession({ path: defaultSessionPath() })).id
    : undefined;
  setAnalyticsHeaders(resolveAnalyticsHeaders(snapshot, sessionId));
  // Names the caller, so it follows the telemetry opt-out.
  setIdentityAssertion(snapshot.idToken, snapshot.telemetryEnabled);
  run(process.argv, buildRealDeps())
    .then(async (code) => {
      // The new-version notice runs after the command has produced its output and
      // never affects `code`.
      //
      // The try/catch is what guarantees that: `maybeNotifyNewVersion` promises
      // not to throw, but a rejection here would skip `process.exit(code)` and
      // fall to the outer `.catch`, turning a succeeded command (its JSON already
      // on stdout) into a failure. `buildVersionNoticeDeps()` is inside the guard
      // for the same reason: it runs synchronously and derives a path.
      //
      // Skipped in the detached telemetry sender, which is not a user command.
      // duration_ms is captured first so the notice's network time is not counted.
      const durationMs = Date.now() - STARTED_AT;
      let noticeMessage: string | undefined;
      try {
        if (!isTelemetrySender(process.argv)) {
          const notice = await maybeNotifyNewVersion(buildVersionNoticeDeps());
          noticeMessage = notice.message;
        }
      } catch {
        /* Background work never changes what the real command reported. */
      }
      // Only on success, and only to stderr. stdout is a JSON contract for the
      // agent funnels, and on a failure stderr must stay the single actionable
      // line the error contract promises (`error-report.ts`).
      if (code === EXIT.OK && noticeMessage) {
        process.stderr.write(`${noticeMessage}\n`);
      }
      await emitTelemetry(code, durationMs, snapshot, sessionId);
      process.exit(code);
    })
    .catch(async (err) => {
      // Otherwise an unhandled rejection (noisy stack, nonstandard exit). Exit
      // with the stable failure class so scripts can branch on it.
      console.error(formatCliError(err, programName()));
      const code = exitCodeForError(err);
      // A failed command is what the exit-code breakdown exists for.
      await emitTelemetry(code, Date.now() - STARTED_AT, snapshot, sessionId);
      process.exit(code);
    });
}

/** Swallows everything: telemetry never changes output or the exit code. */
async function emitTelemetry(
  code: number,
  durationMs: number,
  snapshot: { uid?: string; deviceId?: string },
  sessionId?: string,
): Promise<void> {
  try {
    await maybeSendTelemetry(
      buildTelemetryDeps(code, durationMs, snapshot, sessionId),
    );
  } catch {
    /* ignore */
  }
}
