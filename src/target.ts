import { join } from "node:path";

/**
 * The **target** axis — which backend one binary talks to (foundations#74 rung 2).
 *
 * Version, ring and target are three independent things. Today they are welded
 * together: a `wegostaging` binary is a *different build* whose staging endpoints
 * are baked in, so "test this candidate" and "use the cheap backend" cannot be
 * decided separately. This module is the other half of that split — a single
 * build carries every target and picks one at **run time**, from a flag or an
 * env var, with prod as the default.
 *
 * What lives here, and nothing else: the enum, how it is resolved from argv/env,
 * the endpoint bundle each target implies, and the state scope a resolved target
 * gets. The baked-flavor machinery is untouched — the flavor is still the release
 * identity (rung 7 retires it); the target is a run-time choice on top of it.
 */

export const TARGETS = ["prod", "staging", "local"] as const;

export type Target = (typeof TARGETS)[number];

/**
 * Prod, and it is not a preference. A default that could be non-prod is how a
 * user reads test inventory believing it is real, so the whole point of the axis
 * is that the safe end is what you get when you say nothing.
 */
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
 *  produces the 401 that `.env.local.example` warns about, so the bundle — not
 *  the endpoint — is the unit of choice. */
export interface TargetBundle {
  authorizeUrl: string;
  tokenUrl: string;
  apiUrl: string;
  clientId: string;
}

/**
 * The staging endpoints, as source literals rather than baked build values.
 *
 * Deliberate, and the one place this file departs from `config.ts`'s "no
 * source-code defaults for environment endpoints" rule: prod endpoints stay
 * baked-or-nothing exactly as before, but the *cheap* backend has to be
 * reachable from a binary that was built for prod — that is the premise the rung
 * proves. These are public, invariant, and already committed in
 * `.env.local.example`; `target.test.ts` asserts the two copies agree, so they
 * cannot drift.
 */
const STAGING_AUTH_BASE =
  "https://auth.wegostaging.com/user-auth/v2/users/oauth";

const STAGING_ENDPOINTS = {
  authorizeUrl: `${STAGING_AUTH_BASE}/authorize`,
  tokenUrl: `${STAGING_AUTH_BASE}/token`,
  apiUrl: "https://api.wegostaging.com",
} as const;

/** Where a plain `bun dev` serves `apps/api` (its `.env.local.example` PORT).
 *  Only a fallback: `local` reads `WEGO_API_URL` first, because a portless
 *  worktree URL is machine-specific and cannot be a literal. */
export const LOCAL_API_URL_FALLBACK = "http://localhost:3001";

/**
 * Whether a URL names a host on this machine — so `local` can accept the one
 * value it genuinely cannot hardcode without accepting a value that would make
 * it a lie.
 *
 * `*.localhost` is in, not as a courtesy: portless serves the local `apps/api`
 * at `https://api.localhost`, and a linked worktree at a branch-prefixed name
 * under the same suffix, so a rule that only knew `localhost` would reject every
 * developer's actual setup.
 */
export function isLocalApiUrl(raw: string): boolean {
  let host: string;
  try {
    host = new URL(raw).hostname;
  } catch {
    return false;
  }
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".localhost")
  );
}

export function isTarget(value: unknown): value is Target {
  return (
    typeof value === "string" && (TARGETS as readonly string[]).includes(value)
  );
}

/** The allowed list, for every error message that has to name it. */
function targetList(): string {
  return TARGETS.join("|");
}

/**
 * Parse one written-down target. `undefined`/empty ⇒ the source said nothing, so
 * the next source decides. Anything else that is not a target **throws**: a
 * mistyped `--target stagng` must not silently fall through to prod, which is
 * the failure this axis exists to prevent.
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

/** `--target staging` and `--target=staging` both, scanned over the whole argv:
 *  it is a global switch, not a per-subcommand flag, so `wego flights search …
 *  --target staging` has to work as well as `wego --target staging flights …`. */
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
 * Resolve the target: the flag beats the env var beats prod. `envValue` is passed
 * in rather than read here so `config.ts` keeps reading every configuration var
 * through its `CliEnvVar`-typed accessor (a mistyped key stays a compile error).
 */
export function resolveTarget(
  argv: readonly string[],
  envValue: string | undefined,
): ResolvedTarget {
  const written = targetFromArgv(argv);
  if (written !== undefined) {
    // The flag and the env var are asymmetric on purpose. An exported-but-empty
    // `WEGO_TARGET=` is ordinary shell noise and means "said nothing"; a typed
    // `--target` with nothing after it is a person mid-sentence, and answering it
    // with prod is the silent fallback this axis exists to refuse.
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

/** Remove the global flag before a command parser sees it — every one of them
 *  rejects unknown arguments, which is exactly the behaviour we want to keep.
 *
 *  The separated form (`--target staging`) spans two argv entries, so dropping it
 *  carries one bit of state to the next iteration. That is a `dropValue` flag
 *  rather than an index the body advances: a loop whose body moves its own
 *  counter is the thing every reader has to simulate to trust, and `for…of` also
 *  removes the `undefined` an indexed read has to keep answering for. */
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

/** The one predicate every consumer asks. Written as "is prod" rather than "is
 *  staging" so a target added later is non-prod until someone says otherwise. */
export function isProdTarget(target: Target): boolean {
  return target === "prod";
}

/**
 * The endpoints a target imposes, as a **partial** bundle layered over whatever
 * `config.ts` already resolved.
 *
 * - `prod` imposes nothing, so the default path is byte-for-byte today's:
 *   runtime env > baked build value > configuration error.
 * - `staging` imposes all three endpoints, and beats the ambient `WEGO_*` vars.
 *   A named target is more specific than a `.env.local` a shell happens to load,
 *   and if it were not, `--target staging` would be a no-op for every developer.
 * - `local` imposes the staging *auth* pair and takes its API URL from
 *   `WEGO_API_URL` when that names a host on this machine (portless names it per
 *   worktree, so it cannot be a literal), else the plain `bun dev` port. Staging
 *   auth is not a compromise: the local `apps/api` verifies staging tokens, which
 *   is what `.env.local.example` already does.
 *
 *   A `WEGO_API_URL` pointing anywhere else is **refused**, not adopted and not
 *   quietly ignored. Adopting it made `--target local` report `local` while
 *   talking to `api.wego.com`, which is the exact confusion this axis exists to
 *   end; ignoring it would instead run against a backend the user did not name.
 *   Only saying so is safe.
 *
 * `clientId` is never swapped — the seeded public PKCE client_id is the same
 * literal in staging and prod (see `apps/api/.env.local.example` AUTH_AUDIENCE).
 */
export function targetEndpointOverrides(
  target: Target,
  apiUrlEnvValue: string | undefined,
): Partial<Omit<TargetBundle, "clientId">> {
  switch (target) {
    case "prod":
      return {};
    case "staging":
      return { ...STAGING_ENDPOINTS };
    case "local": {
      const named = apiUrlEnvValue?.trim();
      if (named && !isLocalApiUrl(named)) {
        throw new Error(
          `WEGO_API_URL is ${named}, which is not a host on this machine, so it cannot serve --target local. ` +
            "Point it at localhost (or a portless *.localhost name), unset it to use " +
            `${LOCAL_API_URL_FALLBACK}, or name the target that URL belongs to.`,
        );
      }
      return {
        authorizeUrl: STAGING_ENDPOINTS.authorizeUrl,
        tokenUrl: STAGING_ENDPOINTS.tokenUrl,
        apiUrl: named || LOCAL_API_URL_FALLBACK,
      };
    }
  }
}

/** The host part of a URL, for keying state by it. Throws on an unparseable URL
 *  — the caller already validates endpoints, and a silent `"unknown"` bucket
 *  would let two environments share one credentials file. */
export function hostOf(url: string): string {
  return new URL(url).host;
}

/**
 * The `~/.config/<scope>/` segment for a resolved target: **keyed by the host
 * that issues the credentials**, so two targets on one binary never read — or
 * 401 on — each other's tokens.
 *
 * Keyed by the *auth* host, not the API host, because that is what a token
 * belongs to. `staging` and `local` therefore share one store, which is correct
 * and deliberate: a local `apps/api` verifies staging tokens, so one login
 * serves both.
 *
 * `prod` keeps the historical bare `<flavor>/` leaf. That is the same rule, not
 * an exception — the prod auth host is simply aliased to the path it has always
 * had, because a rung that silently logs every existing install out is not a
 * rung anybody would take.
 */
export function targetConfigScope(
  flavor: string,
  target: Target,
  authorizeUrl: string,
): string {
  if (isProdTarget(target)) return flavor;
  return join(flavor, hostOf(authorizeUrl));
}
