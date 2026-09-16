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
  installScope,
  legacyScopeDir,
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
  inheritTelemetryOptOut,
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
 * `wego` CLI entrypoint (issue #883, M1 client side).
 *
 * A public + PKCE OAuth client: `wego login` authenticates with auth.wego.com
 * over a loopback redirect, then any `wego` command (e.g. `wego whoami`) calls
 * `apps/api` as the logged-in user. An LLM agent simply shells out to the same
 * commands and reuses the user's stored session.
 */

// Baked at build time: `bun build --env 'WEGO_BUILD_*'` (build-release.ts sets it
// from the release tag) inlines this static read, so `version` always matches the
// published release. Unset when run from source (`bun run`) → the -dev fallback.
const VERSION = process.env.WEGO_BUILD_VERSION ?? "0.0.0-dev";

// There is NO baked channel base. Which ring an install follows is a record on the
// machine (`ring-follow.ts`), read by `update` and by the new-version notice alike
// (foundations#74 rung 3: a missing record refuses rather than guesses). A build
// argument here is what let the two drift, so nothing bakes one any more.
// `?.trim() || "wego"`, not `?? "wego"`: an empty/whitespace `WEGO_BUILD_FLAVOR`
// must fall back to `wego`, or the skill dir collapses to the shared root
// (`~/.claude/skills`).
const FLAVOR = process.env.WEGO_BUILD_FLAVOR?.trim() || "wego";
// The install's own identity: the name this binary was invoked as. FLAVOR and
// SCOPE are the same string for every default install (the command is named after
// the flavor) and differ only for a deliberately renamed second install - which is
// the whole point: FLAVOR is the RELEASE (the published asset, the name text calls
// this tool, the one agent-skill dir all channels share), SCOPE is THIS INSTALL
// (its ring record, credentials, settings, telemetry). Keeping the skill on FLAVOR
// is deliberate: it lives under $HOME, one channel owns it, and splitting it would
// hand an agent instructions for a binary it is not driving.
const SCOPE = installScope();
const BUILD_API_URL = process.env.WEGO_BUILD_API_URL;
// Write-only PostHog key, baked like VERSION; absent ⇒ telemetry stays silent.
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
      `Where the login is stored. Default ~/.config/${SCOPE}/credentials.json`,
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
  /** `wego config` — local preferences only, so it takes no `CliConfig`. */
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
  // `--target` is a GLOBAL switch, already resolved by `loadConfig`, so it is
  // removed before any dispatch: every command parser below rejects arguments it
  // does not know, which is behaviour worth keeping rather than punching a hole
  // in once per parser.
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
    case "skill":
      // `skill` manages the local agent SKILL.md; it needs no CLI config (no
      // endpoints, no credentials), so it isn't handed one.
      return deps.skill(argv.slice(3));
    case "update":
      // `update` self-replaces the binary from its baked release channel; like
      // `skill` it needs no OAuth config (no endpoints, no credentials).
      return deps.update(argv.slice(3));
    case "uninstall":
      // `uninstall` self-deletes the binary + local footprint; no OAuth config.
      return deps.uninstall(argv.slice(3));
    case "config":
      // Local preferences only (no endpoints, no network) — like `telemetry`.
      return deps.config(argv.slice(3));
    case "telemetry":
      // Local setting only; no OAuth config.
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
      // An unknown command is a usage error — bad args before any network call —
      // so it takes the stable USAGE (2) class like every other usage-shaped
      // failure in this PR, not the generic exit 1.
      return EXIT.USAGE;
  }
}

/** The `skill` command's dependency bundle. Factored out of `buildRealDeps` so
 *  the background refresh can build the same wiring with silenced io and a
 *  tighter fetch deadline, instead of duplicating it.
 *
 *  `timeoutMs` overrides `skill-remote.ts`'s 5s default: on the foreground
 *  `skill install` a slow-but-alive remote is worth waiting for, but on the
 *  background refresh it is pure added latency on someone else's command, so
 *  that caller gives up sooner. Giving up there means **leaving the installed
 *  file alone**, not falling back to the embedded copy — that caller also sets
 *  `requireRemote`, because the installed body may be newer than this binary's
 *  embed and a fallback would silently downgrade it. The two settings are why a
 *  short deadline is safe here: the cost of timing out is a skipped refresh, not
 *  a worse skill. */
function buildSkillDeps(
  io: CommandIo,
  extra: {
    timeoutMs?: number;
    requireRemote?: boolean;
    refreshOnly?: boolean;
  } = {},
) {
  // ONE read of the record for both uses below. The ring the marker CLAIMS and the
  // ring the body was FETCHED FROM are then the same fact by construction — they
  // were two facts before (#1751), and the cross-channel guard compared the
  // recorded one while the fetch obeyed a baked URL, so it could never see the
  // disagreement it exists to catch.
  const ring = recordedRing();
  return {
    ...io,
    skills: SKILLS,
    version: VERSION,
    flavor: FLAVOR,
    // Stamped into the ownership marker, so a second channel's background refresh
    // can tell this skill is not its to maintain (`skill-refresh.ts`).
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

/** The ring this install follows, or `undefined` when the record is absent,
 *  unreadable or malformed (a pre-ring install, or a from-source run).
 *
 *  Sync and unmemoized because both callers are on the hot path and want it
 *  before any async work; the file is two short lines and is read at most twice
 *  per command. Deliberately NOT a refusal like `update`'s: knowing no ring
 *  disables the cross-channel guard, which is the behaviour that predates rings. */
function recordedRing(): string | undefined {
  try {
    return parseInstallRecord(
      readFileSync(defaultInstallRecordPath(process.env, SCOPE), "utf8"),
    )?.ring;
  } catch {
    return undefined;
  }
}

/** Real wiring for the proactive new-version notice (see `version-notice.ts` for
 *  why each guard exists). The file IS the record: its content is the version the
 *  channel last advertised, its mtime is the throttle stamp — no schema, matching
 *  the skill ownership marker. */
/** The installer's record for THIS binary, read fresh. Absent, unreadable and
 *  malformed all collapse to `null` - the one condition both callers treat as "no
 *  recorded channel", and both REFUSE on it rather than substituting a ring
 *  (foundations#74 rung 3).
 *
 *  One reader, deliberately: a second copy of this read is free to drift from the
 *  first while still looking correct, which is the failure this file already had
 *  once with a baked base on one side and the record on the other. */
async function readOwnInstallRecord() {
  return parseInstallRecord(
    await readFile(defaultInstallRecordPath(process.env, SCOPE), "utf8").catch(
      () => null,
    ),
  );
}

export function buildVersionNoticeDeps(): VersionNoticeDeps {
  const statePath = defaultUpdateCheckPath(process.env, SCOPE);
  return {
    command: process.argv[2],
    fromSource: runningFromSource(),
    version: VERSION,
    flavor: FLAVOR,
    // The flavor is the release identity; this is the command the user types. They
    // differ whenever the install was renamed (`WEGO_CLI_BIN`), and the notice's
    // `… update -y` hint has to name a command that exists on the machine.
    invokedAs: programName(),
    // The ring this install FOLLOWS, read the same way `update` reads it and from
    // the same path, so the notice and `update` can never name different rings.
    // SCOPE-scoped for the reason the `update` wiring states: the record
    // describes where the BINARY came from, not which auth host `--target` picked.
    readInstallRecord: readOwnInstallRecord,
    env: process.env,
    now: Date.now(),
    fetch,
    readState: async () => {
      // Opened rather than `stat`ed by path: `claimWindow` is the only writer and
      // it never replaces the file, but a handle keeps this honest if that ever
      // changes.
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(statePath, "r");
        // The mtime IS the record. The file's content is deliberately unused and
        // deliberately never written: an answer stored here is half of a
        // comparison whose other half changes on every update and reinstall.
        return { checkedAt: (await handle.stat()).mtimeMs };
      } catch {
        // Absent or unreadable — "we don't know", which the caller turns into a
        // fresh check rather than a guess.
        return null;
      } finally {
        await handle?.close().catch(() => {});
      }
    },
    claimWindow: async () => {
      try {
        await ensureOwnerDir(dirname(statePath));
        // Append rather than write: create-if-absent without truncating, and the
        // only writer there is. The file stays empty by design - its mtime is the
        // entire record.
        await appendFile(statePath, "", { mode: 0o600 });
        const now = new Date();
        await utimes(statePath, now, now);
        return true;
      } catch {
        // Report the failure rather than swallowing it: an unstampable path means
        // the throttle would not hold, so the caller skips the network read
        // instead of re-fetching on every command.
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
  // Shared by the `skill` command and `uninstall`'s skill-removal step.
  const skillDeps = buildSkillDeps(io);
  // The credentials path the same way `loadCliConfig` derives it, but without
  // requiring the full (baked) config — so `uninstall` runs from source too.
  // `resolveConfigScope`, not the bare `SCOPE`: on a non-prod target the store is
  // keyed by the issuing auth host too, and this derivation has to land on the
  // same file the command itself reads.
  const configScope = resolveConfigScope();
  const credentialsPath =
    process.env.WEGO_CREDENTIALS_PATH?.trim() ||
    defaultCredentialsPath(process.env, configScope);
  const telemetryPath = defaultTelemetryPath(process.env, SCOPE);
  const settingsPath = defaultSettingsPath(process.env, SCOPE);
  // Which ring this install came from (foundations#74 rung 3). SCOPE-scoped, not
  // `configScope`: the record describes where the BINARY came from, so it must
  // not move when a `--target` picks a different auth host.
  const installRecordPath = defaultInstallRecordPath(process.env, SCOPE);
  // Memoized: a single command resolves preferences at two or three points (the
  // query merge, the site rung, the currency hint), and they must all see the
  // SAME file — a re-read mid-command could otherwise price the create and its
  // follow-up read differently, which is the bug this file exists to prevent.
  // Also keeps a broken file to ONE parse error rather than one per read.
  let settingsOnce: Promise<UserSettings> | undefined;
  const loadSettings = (): Promise<UserSettings> =>
    (settingsOnce ??= loadUserSettings(settingsPath));
  // The trace of WHY a refresh failed. In its own file, not credentials.json,
  // which logout / re-login delete — the record must outlive the re-login that
  // would otherwise erase the only evidence (investigation #1360).
  // Scoped with the credentials it explains: a staging refresh failure recorded
  // into the prod store would read as a prod outage.
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
        // The installer's record, read fresh per run. Absent / unreadable /
        // malformed all arrive as `null`, which `update` refuses on — nothing
        // here substitutes a default ring.
        readInstallRecord: readOwnInstallRecord,
        // So a refusal on a renamed install can say where its files went, rather
        // than reading a record it no longer owns. `undefined` for every install
        // whose command name still matches its release.
        legacyScopeDir: legacyScopeDir(),
        flavor: FLAVOR,
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
          // Best-effort: no-op when the xattr / tool is absent (Linux, or a file
          // that was never quarantined) — a failure here must not fail the update.
          await $`xattr -d com.apple.quarantine ${path}`.quiet().nothrow();
        },
        confirm: confirmTty,
        // Re-install the skill from the binary that just replaced this one, so
        // the SKILL.md on disk matches the build serving it. Runs the NEW
        // binary (`execPath` post-swap), not this process, because the embedded
        // body it must write is the new one. `--owned-only` refreshes the
        // folders this machine already has and creates none; `-y` because there
        // is no one to prompt. Output is discarded: `update` already printed the
        // one line it owns, and stdout is a JSON contract for the agent funnels.
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
        // The real pinned Sigstore anchors a signed build record must chain to.
        trustedRootsPem: FULCIO_ROOTS_PEM,
        // Per-run-unique sibling of the binary (same dir ⇒ same filesystem ⇒
        // atomic rename; unique ⇒ no concurrent-run collision).
        tempPath: `${process.execPath}.${crypto.randomUUID()}.tmp`,
        sweepTemps: async () => {
          // Remove `<binary>.<uuid>.tmp` leftovers from an interrupted run
          // (SIGINT skips the in-flow cleanup). Best-effort — never fail here.
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
        flavor: FLAVOR,
        platform: process.platform,
        execPath: process.execPath,
        credentialsPath,
        settingsPath,
        updateCheckPath: defaultUpdateCheckPath(process.env, SCOPE),
        installRecordPath,
        sessionPath: defaultSessionPath(process.env, SCOPE),
        authFailurePath,
        skillPath: defaultUserSkillDir(homedir(), FLAVOR),
        telemetryStatePath: telemetryPath,
        telemetryOptedOut: async () =>
          !(await loadTelemetryState(telemetryPath)).enabled,
        rm: (path) => rm(path, { force: true }),
        removeCredentials: () => clearCredentials(credentialsPath),
        removeSkill: async () => {
          // Reuse the skill command's own uninstall (marker-guarded, -y).
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
          // Keep the memo honest: the report printed right after the write must
          // show what was just stored, not the pre-write read.
          settingsOnce = Promise.resolve(next);
        },
        // The `account` rung, read from the id_token's market at login. No
        // network call — `config` works logged out, it just has one rung fewer.
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
    // The child re-derives the baked key AND the identity here, so argv carries
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
        clearSession: () =>
          clearSession(defaultSessionPath(process.env, SCOPE)),
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
    process.env.WEGO_CREDENTIALS_PATH?.trim() ||
    defaultCredentialsPath(process.env, SCOPE);
  const uid = uidFromAccessToken(
    (await loadCredentials(credentialsPath))?.accessToken,
  );
  const { deviceId } = await loadTelemetryState(
    defaultTelemetryPath(process.env, SCOPE),
  );
  const device = deviceId ?? EPHEMERAL_DEVICE_ID;
  return { distinctId: uid ?? device, deviceId: device };
}

/** Real wiring for the post-command telemetry emit. */
/** The telemetry file a PRE-RENAME install of this binary wrote, if this install
 *  is one whose scope moved at all. Read for one purpose only — inheriting an
 *  opt-out (`inheritTelemetryOptOut`) — never for the device id. */
function legacyTelemetryPath(): string | undefined {
  const dir = legacyScopeDir();
  return dir ? join(dir, "telemetry.json") : undefined;
}

/** The three local paths telemetry reads, derived once. */
function telemetryPaths(): { telemetryPath: string; credentialsPath: string } {
  return {
    // The machine id is per MACHINE, not per backend, so it stays on the bare
    // install scope: keying it by target too would mint a new device per target
    // and inflate device counts. The credentials are the opposite — see
    // `resolveConfigScope`.
    telemetryPath: defaultTelemetryPath(process.env, SCOPE),
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
 *  not (README.md, Telemetry). Pure and exported so the consent rule is testable. */
export function resolveAnalyticsHeaders(
  snapshot: { deviceId?: string; telemetryEnabled: boolean },
  sessionId: string | undefined,
): AnalyticsHeaders {
  return {
    // Guarded on both, so "only well-formed uuids leave" is structural, not luck.
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
    // after it deletes the credentials — but NEVER for `logout`, whose whole
    // purpose is to end the session. Without that exception the inline sender
    // (Windows, or a deleted binary) reports the pre-logout account while the
    // detached child re-resolves and reports nobody: one command, two identities
    // depending on the platform.
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
  // Ctrl-C during an in-flight request should exit cleanly with the conventional
  // 128+SIGINT code and a one-line notice on stderr — not die with an empty
  // stdout/stderr (QA-002).
  process.on("SIGINT", () => {
    process.stderr.write("Interrupted.\n");
    process.exit(EXIT.SIGINT);
  });
  // From-source runs: load apps/cli/.env.local (relative to this module, not
  // cwd) so the live-source `wego` is configured from any shell/cwd without
  // direnv. No-op for compiled binaries (no sibling file) — baked config wins.
  loadSourceEnvLocal();
  // The target is resolved BEFORE anything derives a path from it, and a bad
  // value stops here: every later caller (`buildRealDeps`, `telemetryPaths`,
  // `loadConfig`) resolves it again, and a throw from any of them would surface
  // as an unhandled rejection instead of a usage error. After
  // `loadSourceEnvLocal`, so a `WEGO_TARGET` in `.env.local` counts.
  try {
    // `resolveConfigScope`, not `resolveCliTarget`: it resolves the target AND
    // the endpoint bundle, so a bundle that throws is caught here rather than
    // inside `buildRealDeps`.
    resolveConfigScope();
  } catch (err) {
    console.error(formatCliError(err, programName()));
    process.exit(EXIT.USAGE);
  }
  // Transitional, and BEFORE the first telemetry read: an install whose config
  // scope moved (its command was renamed) would otherwise come up with no
  // telemetry file at the new path, and no file means ON — silently resuming
  // sending for someone who had opted out. Zero I/O for every install whose name
  // still matches its release, where `legacyScopeDir()` is `undefined`. Never
  // allowed to fail a command: the worst case is the setting not carrying over,
  // which the user can still see and set with `telemetry status` / `telemetry off`.
  await inheritTelemetryOptOut(
    telemetryPaths().telemetryPath,
    legacyTelemetryPath(),
  ).catch(() => {});
  // Read before the command, so `uninstall` — which deletes both files — still
  // reports which machine and account it came from. Measured at 0.037ms, inside
  // the duration_ms window and deliberately not worth engineering out.
  const snapshot = await readTelemetrySnapshot();
  // Resolved HERE and nowhere else; see `shouldResolveSession`.
  const sessionId = shouldResolveSession(process.argv, process.env)
    ? (await resolveSession({ path: defaultSessionPath(process.env, SCOPE) }))
        .id
    : undefined;
  setAnalyticsHeaders(resolveAnalyticsHeaders(snapshot, sessionId));
  // Names the caller, so it follows the telemetry opt-out (README.md, Telemetry).
  setIdentityAssertion(snapshot.idToken, snapshot.telemetryEnabled);
  run(process.argv, buildRealDeps())
    .then(async (code) => {
      // Two best-effort background steps, both AFTER the real command has produced
      // its output (so neither adds latency to the funnel) and neither affecting
      // `code`: the once-a-day refresh of an already-installed agent skill — the
      // consume side of the out-of-band skill channel — and the proactive
      // new-version notice. Concurrently, because they share no path and each owns
      // a 2s network deadline; sequentially the tail would be twice as long.
      //
      // The try/catch is the thing that makes "never affects the exit code" TRUE
      // rather than merely intended. Both functions promise not to throw, but that
      // promise is kept inside two other modules, and `Promise.all` is fail-fast:
      // one rejection here would skip `process.exit(code)` entirely and fall to the
      // outer `.catch`, which reports an unrelated error and exits non-zero —
      // turning a succeeded command, whose JSON is already on stdout, into a
      // failure. The eager `build*Deps()` calls are inside the guard for the same
      // reason: they run synchronously here, and both derive a path from
      // `homedir()`.
      //
      // Both are skipped in the detached telemetry sender: that child is not a
      // user command, so it must neither refresh a skill nor print a notice.
      // duration_ms is captured BEFORE the background work, which would otherwise
      // add its network time to the number on the run that refreshes or checks.
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
      // Only on success, and only ever to stderr. stdout is a JSON contract for the
      // agent funnels; and on a FAILURE stderr must stay the single actionable line
      // the error taxonomy promises (`error-report.ts`, `AGENTS.md`, `SKILL.md`) —
      // appending an upgrade hint under an error would give an agent two lines to
      // interpret where the contract says one, right when it is recovering.
      if (code === EXIT.OK && noticeMessage) {
        process.stderr.write(`${noticeMessage}\n`);
      }
      await emitTelemetry(code, durationMs, snapshot, sessionId);
      process.exit(code);
    })
    .catch(async (err) => {
      // A rejection here would otherwise surface as an unhandled promise
      // rejection (noisy stack, nonstandard exit). Print an actionable message
      // (code/detail/trace_id/next action) and exit with the stable failure
      // class so callers/scripts can branch on it.
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
