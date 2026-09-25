/**
 * What a published release is signed with: the asset names, and the identities a
 * signed build record must carry (foundations#74 rung 9).
 *
 * In `src/` rather than `scripts/` because the compiled binary verifies records, so
 * the pinned identities have to be baked in. The publish-side rules in
 * `scripts/release-signing.ts` import from here; scripts may depend on `src/`,
 * never the other way round.
 *
 * Keyless cosign rather than GitHub artifact attestations: attestations are
 * public-repo-only on the Free, Pro and Team plans and `wego/wego-ai` is private,
 * so the OIDC-token route is the one available (foundations#74).
 */

/** Names every asset's sha256. */
export const MANIFEST_ASSET = "SHA256SUMS.txt";

/**
 * A Sigstore bundle (certificate chain, signature and transparency-log inclusion
 * proof in one JSON object) as `cosign sign-blob --bundle` writes it. One
 * well-known name, so a consumer never has to discover it.
 */
export const SIGNATURE_ASSET = `${MANIFEST_ASSET}.sigstore.json`;

/**
 * An exact SAN URI, or an anchored pattern for a family of them. A pattern is used
 * only where the ref varies and a consumer cannot know it in advance, never to
 * relax a check.
 */
export type IdentityRule = string | RegExp;

/**
 * The workflow allowed to sign a release record, as Fulcio records it in the leaf
 * certificate's SAN.
 *
 * Pinned rather than derived, so a different workflow in this repo, or this
 * workflow on a fork or side branch, cannot mint a record a client would accept.
 * Ref-pinned to `main` because only main is releasable.
 */
export const SIGNING_IDENTITY =
  "https://github.com/wego/wego-ai/.github/workflows/release-cli.yml@refs/heads/main";

/**
 * The same workflow reached by its other documented entry: wego-ai's
 * `release-cli.yml` also triggers on a `cli-v*` tag push (the recovery release).
 * Fulcio names the ref it ran on, so that run signs as `@refs/tags/cli-vX.Y.Z`,
 * which `SIGNING_IDENTITY` alone would refuse: the publish gate would fail after
 * the frozen `cli/<tag>` objects were written, and a client receiving such a
 * record would refuse every update.
 *
 * The `cli-` prefix must not be "normalized" away. wego-ai's release-please sets
 * `include-component-in-tag: true` with `component: "cli"`, so every release it
 * cut is `cli-vX.Y.Z` (`cli-v1.1.0` is the last); `wego/cli` cuts a bare `vX.Y.Z`
 * (see `CLI_RELEASE_TAG_IDENTITY`). A rule for one shape matches nothing from the
 * other. v1.2.0 shipped with the prefix dropped and could never match a real
 * record (wego/cli#29).
 *
 * A pattern because the tag is the version, and `wego update` reads a ring without
 * knowing which release is behind it. Everything that carries authority stays
 * pinned: the repo, the workflow file, and `refs/tags/cli-v` plus a bare `X.Y.Z`.
 * There is no `-rc.N` line any more (rung 7), so a prerelease suffix is not a
 * release identity.
 *
 * Anchored at both ends, or it would match as a substring of an attacker-chosen
 * SAN that merely contains it.
 */
export const RELEASE_TAG_IDENTITY =
  /^https:\/\/github\.com\/wego\/wego-ai\/\.github\/workflows\/release-cli\.yml@refs\/tags\/cli-v\d+\.\d+\.\d+$/;

/**
 * The edge lane signs under its own workflow file, so a dogfood record can never
 * pass as a release record and `cli/edge`'s looser publish gate cannot reach
 * `next` or `stable`.
 */
export const EDGE_SIGNING_IDENTITY =
  "https://github.com/wego/wego-ai/.github/workflows/edge-cli.yml@refs/heads/main";

/**
 * The same two lanes in `wego/cli` (wego/foundations#127, Phase 1).
 *
 * Both strings were harvested, never typed: `scripts/extract-identities.ts` reads
 * the SAN out of each published leaf certificate with `parseCertificate`, the
 * parser `verifySignedManifest` uses. Re-derive them with:
 *
 *     STORE_ORIGIN=<store> bun run scripts/extract-identities.ts \
 *       --tag v1.0.2 --edge 0.0.0-edge.4b980c0
 *
 * They differ from the wego-ai strings by one path segment, so a transcription
 * slip would either lock every client out or quietly widen what one accepts.
 * Never edit them by hand; rerun the script.
 *
 * The wego-ai identities stay while production still serves builds signed by
 * wego-ai; a client that stopped trusting them could not update off the current
 * release. 3c removes them after the cutover.
 *
 * No `wego/cli` counterpart to `SIGNING_IDENTITY`: this repository's
 * `release-cli.yml` has one entrypoint, a `v*` tag push (no `workflow_call` or
 * `workflow_dispatch`), so it can only sign as `@refs/tags/vX.Y.Z`. A
 * `@refs/heads/main` rule would trust a run that cannot happen.
 */
export const CLI_RELEASE_TAG_IDENTITY =
  /^https:\/\/github\.com\/wego\/cli\/\.github\/workflows\/release-cli\.yml@refs\/tags\/v\d+\.\d+\.\d+$/;

/** The `wego/cli` edge lane. Harvested with the rule above; see its comment. */
export const CLI_EDGE_SIGNING_IDENTITY =
  "https://github.com/wego/cli/.github/workflows/edge-cli.yml@refs/heads/main";

/**
 * GitHub Actions' OIDC issuer. Without pinning it, any issuer Fulcio trusts could
 * assert the same SAN string.
 */
export const SIGNING_OIDC_ISSUER =
  "https://token.actions.githubusercontent.com";

/**
 * `edge` is published by the edge lane, `next` and `stable` by the release lane.
 * `stable` is only reached by promoting a `next` build, and the promote copies the
 * record rather than re-signing, so it carries the release lane's identities.
 *
 * The release lane has wego-ai's two rules (two entrypoints, see
 * `RELEASE_TAG_IDENTITY`) plus wego/cli's single tag rule. The edge lane has one
 * rule per repository, since each triggers only on main.
 *
 * Both repositories are trusted during the migration because a client updating
 * today may be offered a build signed by either. 3c drops the wego-ai rules once
 * production no longer serves anything they vouch for.
 */
export function identitiesForRing(ring: string): readonly IdentityRule[] {
  return ring === "edge"
    ? [EDGE_SIGNING_IDENTITY, CLI_EDGE_SIGNING_IDENTITY]
    : [SIGNING_IDENTITY, RELEASE_TAG_IDENTITY, CLI_RELEASE_TAG_IDENTITY];
}
