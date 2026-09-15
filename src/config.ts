import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { INSTALL_RECORD_FILE } from "./ring-follow";
import {
  type ResolvedTarget,
  resolveTarget,
  TARGET_ENV_VAR,
  type Target,
  type TargetSource,
  targetConfigScope,
  targetEndpointOverrides,
} from "./target";
import { formatZodError } from "./zod-error";

/**
 * `wego` CLI configuration (issue #883, M1 client side).
 *
 * The CLI is a **public + PKCE** OAuth client that logs in directly with
 * `auth.wego.com` (loopback, RFC 8252) and calls `apps/api` with the resulting
 * Bearer token. It stores no secret — only the issued tokens, locally.
 *
 * Environment-specific endpoints have no source-code defaults. A source run
 * receives them from `.env.local`; a published binary receives the same public
 * values from the GitHub release environment and bakes them at build time.
 */

export interface CliConfig {
  authorizeUrl: string;
  tokenUrl: string;
  /** The seeded public CLI client_id (upstream B1). */
  clientId: string;
  scopes: string;
  /** Base URL of the deployed `apps/api` resource server. */
  apiBaseUrl: string;
  /** Loopback callback path. Default `/callback`; set `WEGO_CLI_REDIRECT_PATH=`
   *  (empty) for a bare-origin redirect_uri when a client registers one. */
  redirectPath: string;
  /** Loopback port. 0 = ephemeral (default, RFC 8252 any-port). Set
   *  `WEGO_CLI_REDIRECT_PORT` to a fixed port when a client registers a
   *  specific loopback port rather than relying on the AS's port override. */
  redirectPort: number;
  /** Where issued tokens are persisted. */
  credentialsPath: string;
  /** The resolved backend target (foundations#74 rung 2). One binary, one axis:
   *  `prod` unless a `--target` flag or `WEGO_TARGET` said otherwise. */
  target: Target;
  /** Which of those said it, so a report can name the thing to change. */
  targetSource: TargetSource;
}

const DEFAULTS = {
  scopes: "openid profile users",
  redirectPath: "/callback",
};

/**
 * Build-time baked configuration for the published single-file binary
 * (see `scripts/build-release.ts`).
 *
 * These are read through **static** `process.env.WEGO_BUILD_*` member accesses so
 * `bun build --compile --env 'WEGO_BUILD_*'` inlines the literals set at build
 * time into the executable — a *dynamic* `env[key]` read would NOT be inlined
 * (verified). Unset (e.g. `bun run` from source, or `bun test`) they are
 * `undefined`, so a from-source run must obtain the values from `.env.local`.
 *
 * They are **build-only** knobs, deliberately NOT part of the runtime-config
 * contract: excluded from `CLI_ENV_VARS`, never declared in `.env.local.example`.
 * A runtime `WEGO_*` env var still overrides the corresponding baked value.
 * All baked values are PUBLIC (host URLs + the public PKCE client_id) — no
 * secret is ever embedded.
 */
interface BuildDefaults {
  authorizeUrl?: string;
  tokenUrl?: string;
  clientId?: string;
  apiBaseUrl?: string;
}

const BUILD: BuildDefaults = {
  authorizeUrl: process.env.WEGO_BUILD_AUTHORIZE_URL,
  tokenUrl: process.env.WEGO_BUILD_TOKEN_URL,
  clientId: process.env.WEGO_BUILD_CLIENT_ID,
  apiBaseUrl: process.env.WEGO_BUILD_API_URL,
};

/** The config root: `$XDG_CONFIG_HOME` when set, else `~/.config`. */
function configRoot(env: NodeJS.ProcessEnv): string {
  return env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

/**
 * **The config scope is the constant `wego`.** Every per-install file lives under
 * `~/.config/wego/`, on every install, from source and from a binary alike.
 *
 * It was twice a variable and is now neither. First it was the baked build
 * label, so a `wegostaging` build wrote `~/.config/wegostaging/`; then, when that
 * label stopped deciding it, the name the binary was invoked as, so a copy named
 * `wego-next` wrote `~/.config/wego-next/`. Both axes are retired: there is one
 * build, published under one name, and the second-install case the name rule
 * served is served by `XDG_CONFIG_HOME`, which is the standard answer and needs
 * no rule of ours.
 *
 * A constant is not a smaller version of that rule, it is a different guarantee:
 * renaming or copying the binary can no longer move a user's credentials, ring
 * record or settings out from under them, because nothing about the invocation
 * is read when the path is built.
 */
const CONFIG_SCOPE = "wego";

/** One rule for every `<root>/<scope>/` path. `scope` is `CONFIG_SCOPE` above,
 *  plus an auth-host leaf on a non-prod target (`targetConfigScope`). */
function installConfigPath(
  fileName: string,
  env: NodeJS.ProcessEnv,
  scope: string,
): string {
  return join(configRoot(env), scope, fileName);
}

/** Issued tokens, under this install's own scope, so a second install's login
 *  cannot clobber — or 401 — the first one's session. */
export function defaultCredentialsPath(
  env = process.env,
  scope = CONFIG_SCOPE,
): string {
  return installConfigPath("credentials.json", env, scope);
}

/** The update-notice throttle: CONTENT is the version last advertised, MTIME is
 *  when we last asked. Not movable by `WEGO_CREDENTIALS_PATH`, which names a FILE. */
export function defaultUpdateCheckPath(
  env = process.env,
  scope = CONFIG_SCOPE,
): string {
  return installConfigPath(".update-check", env, scope);
}

/** Which release ring this install came from (`ring-follow.ts`), written by the
 *  INSTALLER and followed by `wego update`. Scoped like the rest, under the one
 *  constant scope both the installer and this binary build their paths from —
 *  and deliberately not in `credentials.json`: the ring survives a `logout`, and `update` must be able to
 *  read it while logged out. */
export function defaultInstallRecordPath(
  env = process.env,
  scope = CONFIG_SCOPE,
): string {
  return installConfigPath(INSTALL_RECORD_FILE, env, scope);
}

/** The telemetry machine id + opt-out. Deliberately not in `credentials.json`,
 *  which `logout` deletes — the machine id must survive that. */
export function defaultTelemetryPath(
  env = process.env,
  scope = CONFIG_SCOPE,
): string {
  return installConfigPath("telemetry.json", env, scope);
}

/** The analytics session id. Deliberately NOT inside `telemetry.json`, which
 *  fails closed when unreadable: a session write must not flip the opt-out. */
export function defaultSessionPath(
  env = process.env,
  scope = CONFIG_SCOPE,
): string {
  return installConfigPath("session.json", env, scope);
}

/** The user's travel preferences (currency / site / locale, issue #1386). Not in
 *  `credentials.json`, which `logout` deletes — a preference must survive it. */
export function defaultSettingsPath(
  env = process.env,
  scope = CONFIG_SCOPE,
): string {
  return installConfigPath("settings.json", env, scope);
}

/** The most recent failed token exchange (investigation #1360). Deliberately NOT
 *  in `credentials.json`, which `logout` and a re-login delete — the trace of WHY
 *  a session died must survive the re-login that would otherwise erase it. Not
 *  moved by `WEGO_CREDENTIALS_PATH`, which names a credentials *file*. */
export function defaultAuthFailurePath(
  env = process.env,
  scope = CONFIG_SCOPE,
): string {
  return installConfigPath("last-auth-failure.json", env, scope);
}

/**
 * The env vars the CLI reads as configuration — the single source of truth for
 * what may appear in `.env.local` / `.env.local.example`. `loadCliConfig` reads
 * only through the `CliEnvVar`-typed accessor below, so a mistyped key is a
 * *compile* error and this list cannot silently drift from actual usage;
 * `env-example.test.ts` asserts the committed example declares nothing outside
 * this set (a typo guard for the template). `XDG_CONFIG_HOME` is a standard
 * system var, not part of the wego config contract, so `defaultCredentialsPath`
 * reads it directly and it is intentionally excluded here.
 */
export const CLI_ENV_VARS = [
  "WEGO_AUTH_AUTHORIZE_URL",
  "WEGO_AUTH_TOKEN_URL",
  "WEGO_CLI_CLIENT_ID",
  "WEGO_CLI_SCOPES",
  "WEGO_API_URL",
  "WEGO_CLI_REDIRECT_PATH",
  "WEGO_CLI_REDIRECT_PORT",
  "WEGO_CREDENTIALS_PATH",
  "WEGO_TARGET",
] as const;

export type CliEnvVar = (typeof CLI_ENV_VARS)[number];

function requiredValue(
  runtime: string | undefined,
  baked: string | undefined,
  runtimeName: CliEnvVar,
  buildName: string,
): string {
  const value = runtime?.trim() || baked?.trim();
  if (!value) {
    throw new Error(
      `${runtimeName} is required for source usage (or ${buildName} when compiling a release)`,
    );
  }
  return value;
}

/** Read a config var through a key typed as `CliEnvVar`: a mistyped name (e.g.
 *  "WEGO_CLI_CLINET_ID") fails to compile, and adding a new read forces a
 *  matching CLI_ENV_VARS entry — keeping that list an honest source of truth. */
function read(env: NodeJS.ProcessEnv, key: CliEnvVar): string | undefined {
  return env[key];
}

/** The resolved target, from the two places every caller must agree on: the
 *  `--target` flag, then `WEGO_TARGET`, then prod. Throws on a value that is not
 *  a target — a typo must never fall through to prod. */
export function resolveCliTarget(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): ResolvedTarget {
  return resolveTarget(argv, read(env, TARGET_ENV_VAR));
}

/**
 * The `~/.config/<scope>/` segment for the state that belongs to a **token
 * issuer**: the credentials, and the record of why one died. Keyed by the
 * resolved auth host on a non-prod target, so two targets on one binary never
 * read — or 401 on — each other's tokens; `prod` keeps the bare `<scope>/` leaf
 * (see `targetConfigScope`).
 *
 * Exported because `index.ts` derives the same paths without a full config —
 * `uninstall` and the pre-command telemetry snapshot both run from source, where
 * no endpoint is baked — and the two derivations must not drift.
 *
 * Takes no `BuildDefaults`: the leading segment is this install's own name now, so
 * nothing baked into the binary decides where its files live.
 */
export function resolveConfigScope(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): string {
  const { target } = resolveCliTarget(env, argv);
  const bundle = targetEndpointOverrides(target);
  // Non-prod always carries an authorize URL from the bundle; `prod` imposes
  // nothing, and `targetConfigScope` short-circuits on it before reading one.
  return targetConfigScope(CONFIG_SCOPE, target, bundle.authorizeUrl ?? "");
}

export function loadCliConfig(
  env = process.env,
  // Baked build defaults; the parameter exists so tests can inject them (the
  // real binaries get them via `--env` inlining into `BUILD`). Endpoint/client
  // precedence: named target bundle > runtime env override > baked build value >
  // configuration error.
  build: BuildDefaults = BUILD,
  argv: readonly string[] = process.argv,
): CliConfig {
  const { target, source } = resolveCliTarget(env, argv);
  // A named non-prod target imposes its whole endpoint bundle, beating the
  // ambient `WEGO_*` vars: a `--target staging` that a loaded `.env.local` could
  // silently cancel would not be a switch at all. `prod` imposes nothing, so the
  // default path stays byte-for-byte what it was before this axis existed.
  const bundle = targetEndpointOverrides(target);
  return {
    authorizeUrl:
      bundle.authorizeUrl ??
      requiredValue(
        read(env, "WEGO_AUTH_AUTHORIZE_URL"),
        build.authorizeUrl,
        "WEGO_AUTH_AUTHORIZE_URL",
        "WEGO_BUILD_AUTHORIZE_URL",
      ),
    tokenUrl:
      bundle.tokenUrl ??
      requiredValue(
        read(env, "WEGO_AUTH_TOKEN_URL"),
        build.tokenUrl,
        "WEGO_AUTH_TOKEN_URL",
        "WEGO_BUILD_TOKEN_URL",
      ),
    clientId: requiredValue(
      read(env, "WEGO_CLI_CLIENT_ID"),
      build.clientId,
      "WEGO_CLI_CLIENT_ID",
      "WEGO_BUILD_CLIENT_ID",
    ),
    scopes: read(env, "WEGO_CLI_SCOPES") || DEFAULTS.scopes,
    apiBaseUrl:
      bundle.apiUrl ??
      requiredValue(
        read(env, "WEGO_API_URL"),
        build.apiBaseUrl,
        "WEGO_API_URL",
        "WEGO_BUILD_API_URL",
      ),
    // `?? ` not `||`: an explicit empty WEGO_CLI_REDIRECT_PATH means a
    // bare-origin redirect_uri and must override the default. Parsed but NOT
    // validated here — only `login` uses these, so a malformed login-only env
    // var must not break `whoami`/`logout` (validation lives in assertLoopback).
    redirectPath: read(env, "WEGO_CLI_REDIRECT_PATH") ?? DEFAULTS.redirectPath,
    redirectPort: read(env, "WEGO_CLI_REDIRECT_PORT")
      ? Number(read(env, "WEGO_CLI_REDIRECT_PORT"))
      : 0,
    credentialsPath:
      read(env, "WEGO_CREDENTIALS_PATH") ||
      defaultCredentialsPath(
        env,
        targetConfigScope(CONFIG_SCOPE, target, bundle.authorizeUrl ?? ""),
      ),
    target,
    targetSource: source,
  };
}

/** Loopback hosts that may be reached over plaintext `http` (local dev). */
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/**
 * Whether a hostname names this machine, and so may be reached over plaintext
 * `http`.
 *
 * The `.localhost` suffix is in, not as a courtesy: portless serves the local
 * `apps/api` at `api.localhost` and a linked worktree at a branch-prefixed name
 * under the same suffix, so a rule that knew only the three literals would
 * reject every developer's actual setup. RFC 6761 reserves the whole suffix for
 * loopback, so nothing routable can claim it — this widens the plaintext
 * exception to loopback, and only loopback.
 */
function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.includes(hostname) || hostname.endsWith(".localhost");
}

/** Loopback settings, validated as a unit. `redirectPort` uses `z.custom` (not
 *  `z.number().int()...`) so a `NaN` from a non-numeric `WEGO_CLI_REDIRECT_PORT`
 *  yields the named message rather than zod's generic "expected number". */
const loopbackSchema = z.object({
  redirectPort: z.custom<number>(
    (n) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 65535,
    {
      message:
        "WEGO_CLI_REDIRECT_PORT must be an integer 0-65535 (0 = ephemeral)",
    },
  ),
  redirectPath: z.string().refine((p) => p === "" || p.startsWith("/"), {
    message: 'WEGO_CLI_REDIRECT_PATH must be empty or start with "/"',
  }),
});

/** Validate the loopback settings. Called by `login` (their only consumer) so a
 *  malformed `WEGO_CLI_REDIRECT_PORT`/`PATH` fails the login flow cleanly without
 *  breaking `whoami`/`logout`, which never touch the loopback. */
export function assertLoopback(config: CliConfig): void {
  const result = loopbackSchema.safeParse({
    redirectPort: config.redirectPort,
    redirectPath: config.redirectPath,
  });
  if (!result.success) throw new Error(formatZodError(result.error));
}

/** A string that must be a valid URL with a secure transport: `https` anywhere,
 *  `http` only for a loopback host. The CLI sends auth codes / refresh tokens to
 *  the token URL and the access token to the API — none may travel in cleartext. */
function secureUrlSchema(name: string) {
  return z.string().superRefine((raw, ctx) => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      ctx.addIssue({
        code: "custom",
        message: `${name} is not a valid URL: ${raw}`,
      });
      return;
    }
    const isLocalHttp =
      url.protocol === "http:" && isLoopbackHost(url.hostname);
    if (url.protocol !== "https:" && !isLocalHttp) {
      ctx.addIssue({
        code: "custom",
        message: `${name} must be HTTPS (http allowed only for loopback); got "${url.protocol}//${url.hostname}".`,
      });
    }
  });
}

/** Reject a plaintext `http://` endpoint for a non-localhost host. Called
 *  per-command so a bad endpoint for one command doesn't break the others. */
export function assertSecureUrl(raw: string, name: string): void {
  const result = secureUrlSchema(name).safeParse(raw);
  if (!result.success) throw new Error(formatZodError(result.error));
}

const clientIdSchema = z.string().min(1, {
  message:
    "WEGO_CLI_CLIENT_ID is not set – the wego CLI OAuth client must be seeded " +
    "upstream (issue #883, B1) and its client_id exported as WEGO_CLI_CLIENT_ID.",
});

/** Assert a client_id is configured; used by `login` before starting the flow. */
export function requireClientId(config: CliConfig): string {
  const result = clientIdSchema.safeParse(config.clientId);
  if (!result.success) throw new Error(formatZodError(result.error));
  return result.data;
}
