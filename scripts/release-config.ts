export interface ReleaseEnvSpec {
  authorizeUrl: string;
  tokenUrl: string;
  apiUrl: string;
  clientId: string;
  /** The write-only PostHog key baked as `WEGO_BUILD_POSTHOG_PROJECT_KEY`.
   *  Optional: when absent the binary emits no telemetry. */
  posthogKey?: string;
}

function assertReleaseHttps(raw: string, name: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS; got ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error(`${name} must not contain URL credentials`);
  }
}

/** Write-only project keys are `phc_`; a read-capable `phx_` must never ship. */
const POSTHOG_PROJECT_KEY_PATTERN = /^phc_[A-Za-z0-9]{32,}$/;

function assertPosthogProjectKey(raw: string, name: string): void {
  if (!POSTHOG_PROJECT_KEY_PATTERN.test(raw)) {
    throw new Error(
      `${name} must be a PostHog write-only project key (phc_ + base62); got ${raw.slice(0, 4)}…. ` +
        "A personal or read-capable key must never be compiled into a public binary.",
    );
  }
}

function requiredEnv(source: NodeJS.ProcessEnv, name: string): string {
  const value = source[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/**
 * The one host family the baked auth/API endpoints may point at.
 *
 * The published binary's default target is `prod`, and `prod` imposes no endpoint
 * overrides (`src/target.ts`): it uses these baked values verbatim. A
 * `Production - cli` Environment mis-set to staging values would compile staging
 * endpoints into the binary everyone installs, and nothing downstream would
 * notice: the build succeeds and the smoke runs `version` and `logout`, neither
 * of which touches the network. Staging is reachable at run time with
 * `--target staging`, so it never needs to be baked.
 *
 * A suffix match on the registrable domain, not an exact host: the auth and API
 * hosts differ and a new subdomain is a routine change. `.wegostaging.com` does
 * not end with `.wego.com`, so staging is excluded without a second rule.
 */
const PRODUCTION_HOST_SUFFIX = ".wego.com";

function assertProductionHost(raw: string, name: string): void {
  const { hostname } = new URL(raw);
  if (hostname !== "wego.com" && !hostname.endsWith(PRODUCTION_HOST_SUFFIX)) {
    throw new Error(
      `${name} must be a production Wego host (*${PRODUCTION_HOST_SUFFIX}); got ${hostname}. ` +
        "The published binary defaults to the prod target and uses these baked endpoints verbatim, " +
        "so a non-production host here ships an install that silently talks to the wrong backend. " +
        "Reach staging at run time with `--target staging` instead.",
    );
  }
}

/**
 * Read and validate the public release bundle before any artifact is removed or
 * built. The build environment supplies the same canonical names as runtime.
 *
 * There is one `wego-*` binary, baked with the prod endpoints; `--target staging`
 * swaps the whole auth bundle at run time from `src/target.ts`.
 */
export function readReleaseEnvSpec(source: NodeJS.ProcessEnv): ReleaseEnvSpec {
  // No channel base is baked: `wego update` and the new-version notice read the
  // ring the installer recorded, so there is one source of truth for it.
  const posthogKey = source.WEGO_CLI_POSTHOG_PROJECT_KEY?.trim() || undefined;
  const spec: ReleaseEnvSpec = {
    authorizeUrl: requiredEnv(source, "WEGO_AUTH_AUTHORIZE_URL"),
    tokenUrl: requiredEnv(source, "WEGO_AUTH_TOKEN_URL"),
    apiUrl: requiredEnv(source, "WEGO_API_URL"),
    clientId: requiredEnv(source, "WEGO_CLI_CLIENT_ID"),
    posthogKey,
  };
  assertReleaseHttps(spec.authorizeUrl, "WEGO_AUTH_AUTHORIZE_URL");
  assertReleaseHttps(spec.tokenUrl, "WEGO_AUTH_TOKEN_URL");
  assertReleaseHttps(spec.apiUrl, "WEGO_API_URL");
  // HTTPS alone accepts any host, staging included. These three become the
  // default-target endpoints of every published install, so they are pinned to the
  // production host family too.
  assertProductionHost(spec.authorizeUrl, "WEGO_AUTH_AUTHORIZE_URL");
  assertProductionHost(spec.tokenUrl, "WEGO_AUTH_TOKEN_URL");
  assertProductionHost(spec.apiUrl, "WEGO_API_URL");
  if (posthogKey) {
    assertPosthogProjectKey(posthogKey, "WEGO_CLI_POSTHOG_PROJECT_KEY");
  }
  return spec;
}
