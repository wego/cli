/**
 * Which lane is building, because the PostHog key's constraint INVERTS between the
 * two and a build that cannot tell them apart gets one of the incidents below.
 *
 * `release` REQUIRES it. Absent, the binary builds, runs, smokes and publishes
 * perfectly and simply never posts: v1.1.0–v1.2.1 shipped that way for two weeks
 * after `WEGO_CLI_POSTHOG_PROJECT_KEY` did not survive the wego-ai → wego/cli
 * cutover (c0685ff), with every check green throughout.
 *
 * `edge` FORBIDS it. Edge builds are dogfood and must never count as product
 * telemetry; they emitted into the production project for eleven days before
 * anyone noticed.
 *
 * Both directions were previously guarded by a COMMENT on the edge lane and by
 * nothing at all on the release lane. This is the guard instead. `build-release.ts`
 * is the single call site both lanes reach, so asserting here covers both
 * directions at once, and does it before a byte is produced.
 */
export type BuildLane = "release" | "edge";

export interface ReleaseEnvSpec {
  authorizeUrl: string;
  tokenUrl: string;
  apiUrl: string;
  clientId: string;
  /** The write-only PostHog key baked as `WEGO_BUILD_POSTHOG_PROJECT_KEY`.
   *  LANE-SCOPED rather than optional: required on `release`, forbidden on `edge`
   *  (see `BuildLane`). Absent → the binary emits nothing. */
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

/**
 * The lane rule, asserted at the one call site both lanes pass through.
 *
 * Each message carries the diagnosis rather than just the verdict, because both of
 * these have already cost someone a hunt: the release case names the SCOPE the
 * variable needs (the build job carries no `environment:`, so an environment-scoped
 * value is invisible to it — exactly how the blackout happened), and the edge case
 * names why passing it is wrong rather than merely disallowed.
 */
function assertLaneTelemetryKey(
  posthogKey: string | undefined,
  lane: BuildLane,
): void {
  if (lane === "edge") {
    if (posthogKey) {
      throw new Error(
        "WEGO_CLI_POSTHOG_PROJECT_KEY must NOT be set on the edge lane. Edge builds are " +
          "dogfood; baking a key makes them post as product telemetry and pollute the " +
          "production project. Remove it from the edge workflow's build job.",
      );
    }
    return;
  }
  if (!posthogKey) {
    throw new Error(
      "WEGO_CLI_POSTHOG_PROJECT_KEY is required on the release lane. Without it the binary " +
        "builds and runs normally and silently posts nothing, which is how v1.1.0–v1.2.1 " +
        "shipped telemetry-blind for two weeks. Define it at REPOSITORY scope: the build " +
        "job has no `environment:`, so an environment-scoped value is invisible to it.",
    );
  }
  assertPosthogProjectKey(posthogKey, "WEGO_CLI_POSTHOG_PROJECT_KEY");
}

function requiredEnv(source: NodeJS.ProcessEnv, name: string): string {
  const value = source[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/**
 * The one host family the baked AUTH/API endpoints may point at.
 *
 * The published binary's DEFAULT target is `prod`, and `prod` imposes no endpoint
 * overrides (`src/target.ts`) - it uses these baked values verbatim. So whatever is
 * baked here is what every install talks to until its user passes `--target`.
 *
 * The retired flavor axis used to police this as a two-way cross-check: a staging
 * build's hosts had to contain `wegostaging`, a prod build's had to not. With one
 * build there is no label left to contradict, but the DANGER did not go with it -
 * it got worse, because there is no longer a second build whose absence would be
 * noticed. A `Production - cli` Environment mis-set to staging values would compile
 * staging endpoints into the binary everyone installs, and nothing downstream could
 * detect it: the build succeeds, the smoke runs `version` and `logout` (neither
 * touches the network), and the binary simply talks to the wrong backend forever.
 *
 * So the check is now POSITIVE and one-way, which is both simpler and stricter than
 * what it replaces: these three must be `wego.com` hosts. Staging is reachable from
 * this same binary at RUN time (`--target staging`), which is exactly why it never
 * needs to be baked.
 *
 * A SUFFIX match on the registrable domain, not an exact host: the auth and API
 * hosts differ (`auth.wego.com`, `api.wego.com`) and neither should be pinned here,
 * where a new subdomain would be a routine change. `.wegostaging.com` does not end
 * with `.wego.com`, so the staging family is excluded by construction rather than by
 * a second rule that could drift from the first.
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
 * Read and validate THE public release bundle before any artifact is removed or
 * built. The build environment supplies the same canonical names as runtime.
 *
 * One bundle, not two. The `wegostaging` flavor is gone (foundations#74 rung 7):
 * the backend is no longer welded into the artifact, so there is exactly one
 * `wego-*` binary, baked with the PROD endpoints, and `--target staging`
 * swaps the whole auth bundle at run time from `src/target.ts`'s source literals
 * (rung 2). The flavor CHANNEL-PATH cross-check went with it - a ring is a
 * recorded install-time choice now, not something baked. The flavor HOST check did
 * not go: it came back as `assertProductionHost` above, positive instead of
 * two-way. See its comment for why one build makes that stricter, not looser.
 */
export function readReleaseEnvSpec(
  source: NodeJS.ProcessEnv,
  lane: BuildLane,
): ReleaseEnvSpec {
  // Optional: absent → the built binary's `skill install` degrades to the
  // embedded copy.
  //
  // There is no channel base here any more, on EITHER axis. `wego update` reads the
  // ring the INSTALLER recorded (foundations#74 rung 3) and the new-version notice
  // reads the same record, so nothing about where a binary looks for a newer version
  // is compiled into it. It used to be baked as `WEGO_BUILD_DOWNLOAD_BASE_URL`, which
  // made two sources of truth for one question and drifted exactly as that invites:
  // the baked value still named `cli/latest` after rung 7 retired it.
  //
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
  // HTTPS alone accepts ANY https host, staging included. These three become the
  // default-target endpoints of every published install, so they are pinned to the
  // production host family too.
  assertProductionHost(spec.authorizeUrl, "WEGO_AUTH_AUTHORIZE_URL");
  assertProductionHost(spec.tokenUrl, "WEGO_AUTH_TOKEN_URL");
  assertProductionHost(spec.apiUrl, "WEGO_API_URL");
  assertLaneTelemetryKey(posthogKey, lane);
  return spec;
}
