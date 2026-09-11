#!/usr/bin/env bun
/**
 * Build the published single-file `wego` CLI binaries for internal testing.
 *
 *   bun run scripts/build-release.ts            # wego-* for every platform
 *
 * Output → apps/cli/dist/ (gitignored). Each binary is fully self-contained
 * (embeds the Bun runtime): a tester needs no repo, no Bun/Node, and no `.env`.
 * Every binary is also published as a `<asset>.gz` copy (issue #1235).
 *
 * ONE build, not two flavors (foundations#74 rung 7): the binary bakes the PROD
 * endpoints and `--target staging|local` swaps the whole auth bundle at run time
 * (`src/target.ts`), so "which backend" is no longer a property of the artifact.
 *
 * The prod endpoints + the public PKCE client_id + the release version
 * are baked in via `--env 'WEGO_BUILD_*'`, which inlines the *static*
 * `process.env.WEGO_BUILD_*` reads in src/config.ts (`BUILD`) and src/index.ts
 * (`VERSION`). A runtime `WEGO_*` env var still overrides a baked value. Nothing
 * secret is embedded — the client_id is a public client and is the SAME literal
 * in staging and prod (only the host differs); see B1. The version comes from the
 * release tag (`RELEASE_TAG=vX.Y.Z`), defaulting to `0.0.0-dev` for a local build.
 */
import { $ } from "bun";
import { type ReleaseEnvSpec, readReleaseEnvSpec } from "./release-config";
import { releaseTagError } from "./validate-release-tag";

// Version baked into the binary so `wego version` matches the published release.
// Derived from the tag the release workflow passes as RELEASE_TAG (vX.Y.Z →
// X.Y.Z); a local build with no tag stamps `0.0.0-dev`.
//
// The tag is GATED, not just stripped: this stamp becomes the version the
// installed binary compares against the channel's `VERSION` object, so a tag its
// comparator rejects (`v0.4.3-rc.01`) would ship an install whose new-version
// notice can never fire. The workflow gates the same way; a manual build must not
// be the hole in it (`validate-release-tag.ts`).
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

// A leftover `staging` / `prod` argument from the pre-cutover two-flavor builder
// must ERROR rather than be ignored: a caller passing it believes it is selecting
// a backend, and silently building the one prod-baked binary would hand them a
// binary that talks to production. The backend is a run-time choice now.
if (process.argv[2]) {
  console.error(
    `build-release.ts takes no arguments (got "${process.argv[2]}"). The wegostaging ` +
      "flavor is gone: one `wego-*` build is produced, and the backend is chosen at " +
      "run time with `--target prod|staging|local` (or WEGO_TARGET).",
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
  const outfile = `dist/${spec.bin}-${suffix}`;
  console.log(`→ ${outfile}  (${target})`);
  // `--no-compile-autoload-dotenv`: the binary is batteries-included, so it must
  // NOT silently absorb a stray `.env`/`.env.local` in the tester's CWD (that
  // would override the baked staging/prod config). An explicit exported env var
  // (e.g. `WEGO_API_URL=…`) still overrides, via the normal process env.
  await $`bun build --compile --minify --no-compile-autoload-dotenv --env ${"WEGO_BUILD_*"} --target=${target} --outfile ${outfile} ./src/index.ts`.env(
    {
      ...process.env,
      WEGO_BUILD_AUTHORIZE_URL: spec.authorizeUrl,
      WEGO_BUILD_TOKEN_URL: spec.tokenUrl,
      WEGO_BUILD_API_URL: spec.apiUrl,
      WEGO_BUILD_CLIENT_ID: spec.clientId,
      WEGO_BUILD_VERSION: VERSION,
      // `wego update`'s one baked knob. FLAVOR is the asset-name prefix — one value
      // now (`wego`), kept as a baked key rather than a literal so `update` and the
      // publisher still read the name from one place. There is no baked ring base:
      // `update` and the new-version notice both resolve the ring from the install
      // record at run time (`src/ring-follow.ts`), which is what lets a promote move
      // a pointer instead of rebuilding.
      WEGO_BUILD_FLAVOR: spec.bin,
      // `?? ""`, not `undefined`, on purpose: passing the key — even empty —
      // makes `bun build --env 'WEGO_BUILD_*'` INLINE the static
      // `process.env.WEGO_BUILD_POSTHOG_PROJECT_KEY` read to a literal, so a
      // runtime env var cannot inject a key into a compiled binary. Omitting it
      // would leave a live runtime read; the empty value keeps the "unbaked ⇒
      // silent" degradation while closing that.
      WEGO_BUILD_POSTHOG_PROJECT_KEY: spec.posthogKey ?? "",
    },
  );
  // `-k` keeps the raw binary (shipped binaries' `update` still fetches it); `-n` drops the timestamp.
  await $`gzip -9 -n -k ${outfile}`;
}

console.log("\nDone. Binaries + .gz copies in apps/cli/dist/:");
await $`ls -1 dist`;
