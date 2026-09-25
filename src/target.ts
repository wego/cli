import { join } from "node:path";

/**
 * The target: which backend the binary talks to. Version, ring and target are
 * independent; one build carries every target and picks one at run time, from a
 * flag or an env var, with prod as the default.
 */

export const TARGETS = ["prod", "staging"] as const;

export type Target = (typeof TARGETS)[number];

/** A default that could be non-prod is how a user reads test inventory
 *  believing it is real. */
export const DEFAULT_TARGET: Target = "prod";

export const TARGET_FLAG = "--target";

export const TARGET_ENV_VAR = "WEGO_TARGET";

/** Where the resolved target came from. Reported, so a surprised user can tell a
 *  flag they typed from an env var their shell exports. */
export type TargetSource = "flag" | "env" | "default";

export interface ResolvedTarget {
  target: Target;
  source: TargetSource;
}

/** The four values a target swaps as a unit. Swapping them individually is what
 *  produces the 401 that `.env.local.example` warns about, so the bundle, not
 *  the endpoint, is the unit of choice. */
export interface TargetBundle {
  authorizeUrl: string;
  tokenUrl: string;
  apiUrl: string;
  clientId: string;
}

/**
 * The staging endpoints, as source literals rather than baked build values.
 *
 * This departs from `config.ts`'s "no source-code defaults for environment
 * endpoints" rule on purpose: prod endpoints stay baked-or-nothing, but staging
 * has to be reachable from a binary built for prod. These are public and
 * already committed in `.env.local.example`; `target.test.ts` asserts the two
 * copies agree.
 */
const STAGING_AUTH_BASE =
  "https://auth.wegostaging.com/user-auth/v2/users/oauth";

const STAGING_ENDPOINTS = {
  authorizeUrl: `${STAGING_AUTH_BASE}/authorize`,
  tokenUrl: `${STAGING_AUTH_BASE}/token`,
  apiUrl: "https://api.wegostaging.com",
} as const;

export function isTarget(value: unknown): value is Target {
  return (
    typeof value === "string" && (TARGETS as readonly string[]).includes(value)
  );
}

function targetList(): string {
  return TARGETS.join("|");
}

/**
 * `undefined` or empty means the source said nothing, so the next source
 * decides. Anything else that is not a target throws: a mistyped
 * `--target stagng` must not silently fall through to prod.
 */
export function parseTarget(
  raw: string | undefined,
  origin: string,
): Target | undefined {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === "") return undefined;
  if (!isTarget(value)) {
    throw new Error(`${origin} must be one of ${targetList()}; got "${raw}"`);
  }
  return value;
}

/** Scans the whole argv because `--target` is a global switch, not a
 *  per-subcommand flag: `wego flights search … --target staging` has to work as
 *  well as `wego --target staging flights …`. */
function targetFromArgv(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === TARGET_FLAG) return argv[i + 1] ?? "";
    if (arg?.startsWith(`${TARGET_FLAG}=`)) {
      return arg.slice(TARGET_FLAG.length + 1);
    }
  }
  return undefined;
}

/**
 * The flag beats the env var beats prod. `envValue` is passed in rather than
 * read here so `config.ts` keeps reading every configuration var through its
 * `CliEnvVar`-typed accessor (a mistyped key stays a compile error).
 */
export function resolveTarget(
  argv: readonly string[],
  envValue: string | undefined,
): ResolvedTarget {
  const written = targetFromArgv(argv);
  if (written !== undefined) {
    // The flag and the env var are asymmetric on purpose. An exported-but-empty
    // `WEGO_TARGET=` is ordinary shell noise and means "said nothing"; a typed
    // `--target` with no value is a mistake, and must not fall back to prod.
    const fromFlag = parseTarget(written, TARGET_FLAG);
    if (!fromFlag) {
      throw new Error(
        `${TARGET_FLAG} must be one of ${targetList()}; it was given no value`,
      );
    }
    return { target: fromFlag, source: "flag" };
  }
  const fromEnv = parseTarget(envValue, TARGET_ENV_VAR);
  if (fromEnv) return { target: fromEnv, source: "env" };
  return { target: DEFAULT_TARGET, source: "default" };
}

/** Remove the global flag before a command parser sees it: every parser rejects
 *  unknown arguments, and that behaviour is worth keeping. */
export function stripTargetFlag(argv: readonly string[]): string[] {
  const out: string[] = [];
  let dropValue = false;
  for (const arg of argv) {
    if (dropValue) {
      dropValue = false;
      continue;
    }
    if (arg === TARGET_FLAG) {
      dropValue = true;
      continue;
    }
    if (arg.startsWith(`${TARGET_FLAG}=`)) continue;
    out.push(arg);
  }
  return out;
}

/** "Is prod" rather than "is staging" so a target added later is non-prod until
 *  someone says otherwise. */
export function isProdTarget(target: Target): boolean {
  return target === "prod";
}

/**
 * The endpoints a target imposes, as a **partial** bundle layered over whatever
 * `config.ts` already resolved.
 *
 * - `prod` imposes nothing, so the default path is runtime env > baked build
 *   value > configuration error.
 * - `staging` imposes all three endpoints, and beats the ambient `WEGO_*` vars.
 *   A named target is more specific than a `.env.local` a shell happens to load,
 *   and if it were not, `--target staging` would be a no-op for every developer.
 * To point at an API on this machine, set `WEGO_API_URL` on the default `prod`
 * target: the override path accepts a loopback `http` URL (see `config.ts`), so
 * a target of its own buys nothing.
 *
 * `clientId` is never swapped: the seeded public PKCE client_id is the same
 * literal in staging and prod (see `apps/api/.env.local.example` AUTH_AUDIENCE).
 */
export function targetEndpointOverrides(
  target: Target,
): Partial<Omit<TargetBundle, "clientId">> {
  switch (target) {
    case "prod":
      return {};
    case "staging":
      return { ...STAGING_ENDPOINTS };
  }
}

/** Throws on an unparseable URL: the caller already validates endpoints, and a
 *  silent `"unknown"` bucket would let two environments share one credentials
 *  file. */
export function hostOf(url: string): string {
  return new URL(url).host;
}

/**
 * The `~/.config/<scope>/` segment for a resolved target, keyed by the host that
 * issues the credentials, so two targets on one binary never read (or 401 on)
 * each other's tokens.
 *
 * Keyed by the auth host, not the API host, because that is what a token
 * belongs to: an install pointed at a local `apps/api` with `WEGO_API_URL` goes
 * on using the store of whichever target issued its credentials, which is what a
 * local API verifying staging tokens needs.
 *
 * `prod` keeps the bare `<scope>/` leaf so existing installs are not logged out.
 */
export function targetConfigScope(
  flavor: string,
  target: Target,
  authorizeUrl: string,
): string {
  if (isProdTarget(target)) return flavor;
  return join(flavor, hostOf(authorizeUrl));
}
