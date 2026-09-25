#!/usr/bin/env bun
/**
 * Build the published single-file `wego` CLI binaries.
 *
 *   bun run scripts/build-release.ts            # wego-* for every platform
 *
 * Output goes to dist/ (gitignored). Each binary embeds the Bun runtime, so it
 * needs no repo, no Bun/Node, and no `.env`. Every binary also gets a
 * `<asset>.gz` copy.
 *
 * One build for both backends: the binary bakes the prod endpoints and
 * `--target staging` swaps the whole auth bundle at run time (`src/target.ts`).
 *
 * The prod endpoints, the public PKCE client_id and the release version are
 * baked in via `--env 'WEGO_BUILD_*'`, which inlines the static
 * `process.env.WEGO_BUILD_*` reads in src/config.ts (`BUILD`) and src/index.ts
 * (`VERSION`). A runtime `WEGO_*` env var still overrides a baked value. Nothing
 * secret is embedded: the client_id is a public client and is the same literal
 * in staging and prod (upstream B1). The version comes from the release tag
 * (`RELEASE_TAG=vX.Y.Z`), defaulting to `0.0.0-dev` for a local build.
 */
import { $ } from "bun";
import { type ReleaseEnvSpec, readReleaseEnvSpec } from "./release-config";
import { releaseTagError } from "./validate-release-tag";

// The tag is validated, not just stripped: this stamp is what the installed
// binary compares against the channel's `VERSION` object, so a tag its
// comparator rejects (`v0.4.3-rc.01`) would ship an install whose new-version
// notice can never fire. The workflow validates the same way; this covers a
// manual build (`validate-release-tag.ts`).
const releaseTag = process.env.RELEASE_TAG ?? "";
if (releaseTag) {
  const tagError = releaseTagError(releaseTag);
  if (tagError) {
    console.error(tagError);
    process.exit(1);
  }
}
const VERSION = releaseTag.replace(/^v/, "") || "0.0.0-dev";

// Bun cross-compile targets → asset filename suffix.
const TARGETS: { target: string; suffix: string }[] = [
  { target: "bun-darwin-arm64", suffix: "darwin-arm64" },
  { target: "bun-darwin-x64", suffix: "darwin-x64" },
  { target: "bun-linux-x64", suffix: "linux-x64" },
  { target: "bun-linux-arm64", suffix: "linux-arm64" },
  { target: "bun-windows-x64", suffix: "windows-x64.exe" },
];

// Any argument (e.g. `staging`) must error rather than be ignored: a caller
// passing one believes it selects a backend, and silently building the
// prod-baked binary would hand them one that talks to production.
if (process.argv[2]) {
  console.error(
    `build-release.ts takes no arguments (got "${process.argv[2]}"). The wegostaging ` +
      "flavor is gone: one `wego-*` build is produced, and the backend is chosen at " +
      "run time with `--target prod|staging` (or WEGO_TARGET).",
  );
  process.exit(1);
}
// Validate the complete bundle before deleting or producing any artifacts. A
// non-empty typo such as `not-a-url` must fail the release before a binary can
// reach the publish/promote steps.
const spec: ReleaseEnvSpec = readReleaseEnvSpec(process.env);

console.log(`Building wego CLI binaries (version ${VERSION})`);
await $`rm -rf dist && mkdir -p dist`;

for (const { target, suffix } of TARGETS) {
  const outfile = `dist/wego-${suffix}`;
  console.log(`→ ${outfile}  (${target})`);
  // `--no-compile-autoload-dotenv`: the binary must not absorb a stray
  // `.env`/`.env.local` in the user's CWD, which would override the baked
  // config. An exported env var (e.g. `WEGO_API_URL=…`) still overrides.
  await $`bun build --compile --minify --no-compile-autoload-dotenv --env ${"WEGO_BUILD_*"} --target=${target} --outfile ${outfile} ./src/index.ts`.env(
    {
      ...process.env,
      WEGO_BUILD_AUTHORIZE_URL: spec.authorizeUrl,
      WEGO_BUILD_TOKEN_URL: spec.tokenUrl,
      WEGO_BUILD_API_URL: spec.apiUrl,
      WEGO_BUILD_CLIENT_ID: spec.clientId,
      WEGO_BUILD_VERSION: VERSION,
      // Nothing else is baked. The asset-name prefix is the literal `wego`, here
      // and in `update`, so it cannot disagree with the filename this loop
      // writes. There is no baked ring base: `update` and the new-version notice
      // resolve the ring from the install record at run time
      // (`src/ring-follow.ts`), so a promote moves a pointer instead of
      // rebuilding.
      // `?? ""`, not `undefined`: passing the key, even empty, makes
      // `bun build --env 'WEGO_BUILD_*'` inline the static
      // `process.env.WEGO_BUILD_POSTHOG_PROJECT_KEY` read to a literal, so a
      // runtime env var cannot inject a key into a compiled binary. An empty
      // value still means telemetry stays silent.
      WEGO_BUILD_POSTHOG_PROJECT_KEY: spec.posthogKey ?? "",
    },
  );
  // `-k` keeps the raw binary (shipped binaries' `update` still fetches it); `-n` drops the timestamp.
  await $`gzip -9 -n -k ${outfile}`;
}

console.log("\nDone. Binaries + .gz copies in apps/cli/dist/:");
await $`ls -1 dist`;
