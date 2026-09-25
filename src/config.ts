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
 * The CLI is a public PKCE OAuth client that logs in directly with
 * `auth.wego.com` (loopback, RFC 8252) and calls `apps/api` with the resulting
 * Bearer token. It stores no secret, only the issued tokens, locally.
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
  credentialsPath: string;
  /** `prod` unless a `--target` flag or `WEGO_TARGET` said otherwise. */
  target: Target;
  /** Which of those said it, so a report can name the thing to change. */
  targetSource: TargetSource;
}

const DEFAULTS = {
  scopes: "openid profile users",
  redirectPath: "/callback",
};

/**
 * Build-time baked configuration for the published binary
 * (see `scripts/build-release.ts`).
 *
 * These are read through static `process.env.WEGO_BUILD_*` member accesses so
 * `bun build --compile --env 'WEGO_BUILD_*'` inlines the literals into the
 * executable; a dynamic `env[key]` read would not be inlined. Unset (from source,
 * or `bun test`) they are `undefined`, so a source run gets the values from
 * `.env.local`.
 *
 * They are build-only knobs, not part of the runtime-config contract: excluded
 * from `CLI_ENV_VARS` and never declared in `.env.local.example`. A runtime
 * `WEGO_*` env var still overrides the baked value. All baked values are public
 * (host URLs and the public PKCE client_id); no secret is embedded.
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

function configRoot(env: NodeJS.ProcessEnv): string {
  return env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

/**
 * The config scope is a constant, so every per-install file lives under
 * `<config root>/wego/` however the binary was built, named or invoked. Renaming
 * or copying the binary cannot move a user's credentials, ring record or
 * settings, because nothing about the invocation is read when a path is built.
 *
 * A second install gets its own directory through `XDG_CONFIG_HOME` alone. That
 * works because the install script computes its record path from the same
 * variable (`${XDG_CONFIG_HOME:-$HOME/.config}/$BIN_NAME`, `BIN_NAME` defaulting
 * to `wego`), so it writes where this file reads. `config.test.ts` pins both
 * halves because they live in different repositories.
 */
const CONFIG_SCOPE = "wego";

/** `scope` is `CONFIG_SCOPE`, plus an auth-host leaf on a non-prod target
 *  (`targetConfigScope`). */
function installConfigPath(
  fileName: string,
  env: NodeJS.ProcessEnv,
  scope: string,
): string {
  return join(configRoot(env), scope, fileName);
}

/** Issued tokens, under this install's own scope, so a second install's login
 *  cannot clobber (or 401) the first one's session. */
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
 *  installer and followed by `wego update`. Not in `credentials.json`: the ring
 *  survives a `logout`, and `update` must be able to read it while logged out. */
export function defaultInstallRecordPath(
  env = process.env,
  scope = CONFIG_SCOPE,
): string {
  return installConfigPath(INSTALL_RECORD_FILE, env, scope);
}

/** The telemetry machine id and opt-out. Not in `credentials.json`, which
 *  `logout` deletes: the machine id must survive that. */
export function defaultTelemetryPath(
  env = process.env,
  scope = CONFIG_SCOPE,
): string {
  return installConfigPath("telemetry.json", env, scope);
}

/** The analytics session id. Not inside `telemetry.json`, which fails closed
 *  when unreadable: a session write must not flip the opt-out. */
export function defaultSessionPath(
  env = process.env,
  scope = CONFIG_SCOPE,
): string {
  return installConfigPath("session.json", env, scope);
}

/** The user's travel preferences (currency, site, locale). Not in
 *  `credentials.json`, which `logout` deletes: a preference must survive it. */
export function defaultSettingsPath(
  env = process.env,
  scope = CONFIG_SCOPE,
): string {
  return installConfigPath("settings.json", env, scope);
}

/** The most recent failed token exchange (investigation #1360). Not in
 *  `credentials.json`, which `logout` and a re-login delete: the trace of why a
 *  session died must survive the re-login. Not moved by `WEGO_CREDENTIALS_PATH`,
 *  which names a credentials file. */
export function defaultAuthFailurePath(
  env = process.env,
  scope = CONFIG_SCOPE,
): string {
  return installConfigPath("last-auth-failure.json", env, scope);
}

/**
 * The env vars the CLI reads as configuration: the source of truth for what may
 * appear in `.env.local` and `.env.local.example`. `loadCliConfig` reads only
 * through the `CliEnvVar`-typed accessor below, so a mistyped key is a compile
 * error and this list cannot drift from actual usage; `env-example.test.ts`
 * asserts the committed example declares nothing outside this set.
 * `XDG_CONFIG_HOME` is a standard system var, not part of the wego config
 * contract, so `configRoot` reads it directly and it is excluded here.
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

/** Typed as `CliEnvVar` so a mistyped name fails to compile and a new read
 *  forces a matching `CLI_ENV_VARS` entry. */
function read(env: NodeJS.ProcessEnv, key: CliEnvVar): string | undefined {
  return env[key];
}

/** The `--target` flag, then `WEGO_TARGET`, then prod. Throws on a value that
 *  is not a target: a typo must never fall through to prod. */
export function resolveCliTarget(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): ResolvedTarget {
  return resolveTarget(argv, read(env, TARGET_ENV_VAR));
}

/**
 * The `~/.config/<scope>/` segment for state that belongs to a token issuer: the
 * credentials, and the record of why one died. Keyed by the resolved auth host
 * on a non-prod target, so two targets on one binary never read (or 401 on)
 * each other's tokens; `prod` keeps the bare `<scope>/` leaf (see
 * `targetConfigScope`).
 *
 * Exported because `index.ts` derives the same paths without a full config
 * (`uninstall` and the pre-command telemetry snapshot both run from source,
 * where no endpoint is baked), and the two derivations must not drift. Takes no
 * `BuildDefaults`: nothing baked into the binary decides where its files live.
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
  // silently cancel would not be a switch at all. `prod` imposes nothing.
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
    // bare-origin redirect_uri and must override the default. Parsed but not
    // validated here: only `login` uses these, so a malformed login-only env var
    // must not break `whoami`/`logout` (validation lives in assertLoopback).
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

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/**
 * The `.localhost` suffix is included because portless serves the local
 * `apps/api` at `api.localhost` and a linked worktree at a branch-prefixed name
 * under the same suffix. RFC 6761 reserves the whole suffix for loopback, so
 * nothing routable can claim it.
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

/** `https` anywhere, `http` only for a loopback host. The CLI sends auth codes
 *  and refresh tokens to the token URL and the access token to the API; none may
 *  travel in cleartext. */
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

/** Called per command so a bad endpoint for one command doesn't break the
 *  others. */
export function assertSecureUrl(raw: string, name: string): void {
  const result = secureUrlSchema(name).safeParse(raw);
  if (!result.success) throw new Error(formatZodError(result.error));
}

const clientIdSchema = z.string().min(1, {
  message:
    "WEGO_CLI_CLIENT_ID is not set – the wego CLI OAuth client must be seeded " +
    "upstream (issue #883, B1) and its client_id exported as WEGO_CLI_CLIENT_ID.",
});

export function requireClientId(config: CliConfig): string {
  const result = clientIdSchema.safeParse(config.clientId);
  if (!result.success) throw new Error(formatZodError(result.error));
  return result.data;
}
