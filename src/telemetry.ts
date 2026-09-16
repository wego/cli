import { EXIT } from "./error-report";
import { isProdTarget, type Target } from "./target";

/**
 * One `cli_command_ran` event per invocation. User-facing disclosure and the
 * opt-out live in README.md's Telemetry section.
 *
 * WHERE THE EVENTS GO — stated here because the baked key cannot answer it (it is
 * write-only and reads nothing, including its own project's name): PostHog project
 * **521561** ("api & cli", Wego org, US cloud), https://us.posthog.com/project/521561,
 * saved views prefixed `[CLI]`. It also receives the `apps/api` funnel events
 * deliberately — PostHog cannot join across projects, so a second one would split
 * one person in two and break following them from command to request.
 */

export const TELEMETRY_EVENT = "cli_command_ran";
export const TELEMETRY_HOST = "https://us.i.posthog.com";
export const TELEMETRY_SENDER_COMMAND = "send-telemetry";

/** `device_id` in a `log` payload before any run has minted one. */
export const UNASSIGNED_DEVICE_ID = "unassigned";

/** `device_id` when the id cannot be stored (read-only or ephemeral `$HOME`).
 *  A stable sentinel, not a fresh uuid: otherwise every run on such a machine
 *  would look like a new device and inflate device counts without bound. */
export const EPHEMERAL_DEVICE_ID = "ephemeral";

/** Anything not here records as `unknown`, never its raw text. */
const KNOWN_COMMANDS = [
  "login",
  "whoami",
  "places",
  "info",
  "flights",
  "hotels",
  "feedback",
  "skill",
  "update",
  "uninstall",
  "logout",
  "config",
  "telemetry",
  "version",
  "help",
] as const;

/** `places` is absent on purpose: its first positional is the search query. */
const SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
  info: ["holidays", "visa-free", "schedules", "airports-near", "target"],
  flights: [
    "search",
    "results",
    "trip",
    "experience",
    "fares",
    "booking-link",
    "share",
  ],
  hotels: ["search", "results", "details", "reviews", "rooms", "booking-link"],
  skill: ["list", "install", "path", "uninstall"],
  // `list`/`set`/`unset` only. The VALUE a `set` carries is the second
  // positional, which no allowlist reads, so a user's currency never leaves.
  config: ["list", "set", "unset"],
  telemetry: ["status", "enable", "disable"],
};

/** Short aliases record under their long name, so one flag is one property.
 *  Only value-bearing flags reach this, so `-g`/`-y`/`-h`/`-v` need no entry. */
const FLAG_ALIASES: Readonly<Record<string, string>> = {
  "-a": "--agent",
};

/** Names outside this set are dropped, so an injected flag records nothing. */
const KNOWN_FLAGS: readonly string[] = [
  "--adults",
  "--agent",
  "--aircraft",
  "--airline",
  "--airlines",
  "--airlines-match",
  "--alliances",
  "--amenities",
  "--booking-sites",
  "--booking-types",
  "--brands",
  "--browser",
  "--cabin",
  "--category",
  "--chains",
  "--check",
  "--check-in",
  "--check-out",
  "--children",
  "--children-ages",
  "--country",
  "--currency",
  "--date",
  "--deals-only",
  "--departure-blocks",
  "--departure-range",
  "--dir",
  "--districts",
  "--embedded",
  "--fare-option",
  "--force",
  "--from",
  "--from-city",
  "--global",
  "--guest-type",
  "--help",
  "--infants",
  "--json",
  "--keep-credentials",
  "--keep-local-edits",
  "--keep-skill",
  "--locale",
  "--max-duration",
  "--max-price",
  "--max-star",
  "--max-stopover-duration",
  "--message",
  "--min-price",
  "--min-review-score",
  "--guest-type",
  "--min-guest-rating",
  "--min-star",
  "--min-stopover-duration",
  "--no-browser",
  "--page",
  "--page-size",
  "--property-types",
  "--radius",
  "--rate",
  "--rate-types",
  "--rating",
  "--refundable",
  "--return",
  "--rooms",
  "--same-airline",
  "--scope",
  "--search",
  "--site",
  "--sort",
  "--stopover-airports",
  "--stops",
  "--to",
  "--to-city",
  "--topics",
  "--trip",
  "--types",
  "--view",
  "--wait",
  "--yes",
  "-a",
  "-g",
  "-h",
  "-v",
  "-y",
];

/** The only flags whose VALUE is recorded. Free text and trip content never are. */
const VALUE_FLAGS: Readonly<Record<string, "enum" | "count">> = {
  "--agent": "enum",
  "-a": "enum",
  "--cabin": "enum",
  "--category": "enum",
  "--deals-only": "enum",
  "--guest-type": "enum",
  "--refundable": "enum",
  "--scope": "enum",
  "--sort": "enum",
  "--view": "enum",
  "--adults": "count",
  "--children": "count",
  "--infants": "count",
  "--page": "count",
  "--page-size": "count",
  "--rating": "count",
  "--rooms": "count",
};

const ENUM_VALUE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** A whitelisted flag can still be handed arbitrary text, so validate the value. */
function sanitizeValue(kind: "enum" | "count", raw: string): string | number {
  if (kind === "count") {
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 && n <= 9999 ? n : "invalid";
  }
  const v = raw.trim().toLowerCase();
  return ENUM_VALUE_PATTERN.test(v) ? v : "invalid";
}

export type TelemetryMode = "off" | "on" | "log";

const ON_VALUES = ["1", "true", "on", "yes"];
const OFF_VALUES = ["0", "false", "off", "no"];

/** `undefined` ⇒ the variable said nothing, so the stored setting decides. */
export function parseTelemetryMode(
  raw: string | undefined,
): TelemetryMode | undefined {
  const v = raw?.trim().toLowerCase();
  if (v === undefined || v === "") return undefined;
  if (v === "log") return "log";
  if (ON_VALUES.includes(v)) return "on";
  if (OFF_VALUES.includes(v)) return "off";
  // Err toward privacy: `=disabled` clearly meant off.
  return "off";
}

export function isTelemetrySender(argv: readonly string[]): boolean {
  return argv[2] === TELEMETRY_SENDER_COMMAND;
}

/** The numeric `uid` claim; `sub` (the email) is never read, non-digits dropped. */
export function uidFromAccessToken(
  token: string | undefined,
): string | undefined {
  if (!token) return undefined;
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    const uid = (claims as { uid?: unknown }).uid;
    if (typeof uid === "number") {
      return Number.isInteger(uid) && uid >= 0 ? String(uid) : undefined;
    }
    return typeof uid === "string" && /^\d+$/.test(uid) ? uid : undefined;
  } catch {
    return undefined;
  }
}

export function resolveCommand(argv: readonly string[]): string {
  const raw = argv[2];
  if (raw === undefined || raw === "help" || raw === "--help" || raw === "-h") {
    return "help";
  }
  if (raw === "version" || raw === "--version" || raw === "-v") {
    return "version";
  }
  return KNOWN_COMMANDS.includes(raw as (typeof KNOWN_COMMANDS)[number])
    ? raw
    : "unknown";
}

/** Allowlisted only, never a bare positional. */
export function resolveSubcommand(
  command: string,
  args: readonly string[],
): string | undefined {
  const allowed = SUBCOMMANDS[command];
  if (!allowed) return undefined;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === undefined) continue;
    if (token.startsWith("-")) {
      // Skip a value-flag's value, or it would be read as the subcommand.
      const { name, inline } = splitFlag(token);
      if (VALUE_FLAGS[name] && inline === undefined) i++;
      continue;
    }
    return allowed.includes(token) ? token : undefined;
  }
  return undefined;
}

function splitFlag(token: string): { name: string; inline?: string } {
  const eq = token.indexOf("=");
  return eq === -1
    ? { name: token }
    : { name: token.slice(0, eq), inline: token.slice(eq + 1) };
}

export function extractFlagNames(args: readonly string[]): string[] {
  const seen: string[] = [];
  for (const token of args) {
    if (!token.startsWith("-")) continue;
    const { name } = splitFlag(token);
    if (KNOWN_FLAGS.includes(name) && !seen.includes(name)) seen.push(name);
  }
  return seen;
}

export function extractFlagValues(
  args: readonly string[],
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === undefined || !token.startsWith("-")) continue;
    const { name, inline } = splitFlag(token);
    const kind = VALUE_FLAGS[name];
    if (!kind) continue;
    const raw = inline ?? args[i + 1];
    // `--sort` at the end, or followed by another flag, has no value.
    if (raw === undefined || (inline === undefined && raw.startsWith("-"))) {
      continue;
    }
    const canonical = FLAG_ALIASES[name] ?? name;
    out[`arg_${canonical.replace(/^-+/, "").replaceAll("-", "_")}`] =
      sanitizeValue(kind, raw);
  }
  return out;
}

export type TelemetryProperty = string | number | boolean | readonly string[];

export interface TelemetryEvent {
  event: string;
  distinct_id: string;
  timestamp: string;
  properties: Record<string, TelemetryProperty>;
}

export interface TelemetryEventInput {
  argv: readonly string[];
  exitCode: number;
  durationMs: number;
  version: string;
  platform: string;
  arch: string;
  /** Numeric `uid` when logged in. */
  uid?: string;
  deviceId: string;
  /** The same id the API events carry, so the two streams line up. */
  sessionId?: string;
  now: number;
}

/** Logged in ⇒ keyed on `uid` with a person; logged out ⇒ anonymous tier. */
export function buildTelemetryEvent(
  input: TelemetryEventInput,
): TelemetryEvent {
  const command = resolveCommand(input.argv);
  const args = input.argv.slice(3);
  const subcommand = resolveSubcommand(command, args);
  const properties: Record<string, TelemetryProperty> = {
    command,
    flags: extractFlagNames(args),
    ...extractFlagValues(args),
    exit_code: input.exitCode,
    duration_ms: input.durationMs,
    version: input.version,
    os: input.platform,
    arch: input.arch,
    device_id: input.deviceId,
  };
  if (subcommand !== undefined) properties.subcommand = subcommand;
  if (input.sessionId !== undefined) properties.$session_id = input.sessionId;
  if (input.uid === undefined) properties.$process_person_profile = false;
  return {
    event: TELEMETRY_EVENT,
    distinct_id: input.uid ?? input.deviceId,
    timestamp: new Date(input.now).toISOString(),
    properties,
  };
}

/**
 * Why a build is structurally incapable of posting, in the order `maybeSendTelemetry`
 * decides — `null` when none of them applies.
 *
 * ONE ordering, two consumers. `maybeSendTelemetry` maps it to its outcome strings;
 * `formatTargetReport` maps it to the human row in `wego info target`. They used to
 * be two hand-written copies of one precedence, and the copy had already drifted at
 * birth — the report modelled two of these three and would have called a source
 * build "unkeyed". Anything that reorders the guards now moves both at once.
 *
 * Only the guards that are a property of the BUILD live here. The run-time choices
 * (`log`, the opt-out, the persisted disable) stay in `maybeSendTelemetry`: a report
 * about what these bytes can do must not claim to know what this invocation chose.
 */
export type TelemetrySilenceReason = "non-prod" | "from-source" | "unkeyed";

export function telemetrySilenceReason(build: {
  target: Target;
  fromSource: boolean;
  keyBaked: boolean;
}): TelemetrySilenceReason | null {
  if (!isProdTarget(build.target)) return "non-prod";
  if (build.fromSource) return "from-source";
  if (!build.keyBaked) return "unkeyed";
  return null;
}

/** Returned rather than logged, so each guard is testable on a silent path. */
export type TelemetryOutcome =
  | "skipped-sender"
  | "skipped-interrupted"
  | "printed"
  | "skipped-non-prod-target"
  | "skipped-from-source"
  | "skipped-unbaked"
  | "skipped-opt-out"
  | "skipped-disabled"
  | "sent";

export interface TelemetryDeps {
  argv: readonly string[];
  exitCode: number;
  durationMs: number;
  /** Exec-path signal, not the spoofable env-stamped version. */
  fromSource: boolean;
  /** The resolved backend target. Only a `prod` run emits (foundations#74 rung
   *  2): a staging or local run is a test, and counting tests as usage is how
   *  the numbers stop describing users. */
  target: Target;
  /** The baked write-only project key; absent ⇒ nothing to post to. */
  posthogKey?: string;
  env: Record<string, string | undefined>;
  version: string;
  platform: string;
  arch: string;
  now: number;
  /** Resolved by the parent; the sender child never re-resolves it. */
  sessionId?: string;
  /** Reads only; never creates the file. */
  loadState: () => Promise<{ deviceId?: string; enabled: boolean }>;
  /** Called only on an emitting run, so a disabled run writes nothing. */
  persistDeviceId: (deviceId: string) => Promise<void>;
  readUid: () => Promise<string | undefined>;
  /** Detached child. Returns a promise on the inline paths — Windows, or a
   *  binary already deleted by `uninstall` — where the send is awaited. */
  spawnSender: (payload: string) => void | Promise<void>;
  /** stderr, never stdout. */
  printPayload: (payload: string) => void;
  randomUUID: () => string;
}

/** Never throws, never touches stdout, never affects the exit code. */
export async function maybeSendTelemetry(
  deps: TelemetryDeps,
): Promise<TelemetryOutcome> {
  // First, or the child spawns its own child forever.
  if (isTelemetrySender(deps.argv)) return "skipped-sender";
  if (deps.exitCode === EXIT.SIGINT) return "skipped-interrupted";

  const mode = parseTelemetryMode(deps.env.WEGO_CLI_TELEMETRY);
  // Above the other guards: an opted-out user is the likeliest to want an audit.
  if (mode === "log") {
    deps.printPayload(JSON.stringify(await buildEvent(deps), null, 2));
    return "printed";
  }
  // Above every other silent guard, and deliberately below `log`: a non-prod run
  // may still be audited on stderr, but nothing about it reaches PostHog. The
  // target is resolved from the flag/env, not from the endpoint, so pointing
  // `WEGO_API_URL` at staging is NOT what suppresses the event — naming the
  // target is.
  const silent = telemetrySilenceReason({
    target: deps.target,
    fromSource: deps.fromSource,
    keyBaked: Boolean(deps.posthogKey),
  });
  if (silent === "non-prod") return "skipped-non-prod-target";
  if (silent === "from-source") return "skipped-from-source";
  if (silent === "unkeyed") return "skipped-unbaked";
  if (mode === "off") return "skipped-opt-out";

  const state = await safely(() => deps.loadState());
  if (state && !state.enabled) return "skipped-disabled";

  // Minted once and persisted, so it survives `logout` deleting the credentials.
  // At most one write per machine, ever: a concurrent `telemetry disable` racing
  // it is accepted, and `disable` again fixes it for good (see README.md).
  let deviceId = state?.deviceId;
  if (deviceId === undefined) {
    const minted = deps.randomUUID();
    const stored = await safely(async () => {
      await deps.persistDeviceId(minted);
      return true;
    });
    deviceId = stored === true ? minted : EPHEMERAL_DEVICE_ID;
  }
  await deps.spawnSender(JSON.stringify(await buildEvent(deps, deviceId)));
  return "sent";
}

async function buildEvent(
  deps: TelemetryDeps,
  knownDeviceId?: string,
): Promise<TelemetryEvent> {
  // `log` arrives with none, on purpose: printing must not create the file.
  const deviceId =
    knownDeviceId ??
    (await safely(async () => (await deps.loadState()).deviceId));
  const uid = await safely(() => deps.readUid());
  return buildTelemetryEvent({
    argv: deps.argv,
    exitCode: deps.exitCode,
    durationMs: deps.durationMs,
    version: deps.version,
    platform: deps.platform,
    arch: deps.arch,
    uid,
    deviceId: deviceId ?? UNASSIGNED_DEVICE_ID,
    sessionId: deps.sessionId,
    now: deps.now,
  });
}

/** An unreadable local source degrades the event, never loses it. */
async function safely<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch {
    return undefined;
  }
}
