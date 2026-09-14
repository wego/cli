/**
 * What a published release is signed with: the names, and the identities a signed
 * build record must carry (foundations#74 rung 9).
 *
 * In `src/` rather than `scripts/` because the COMPILED BINARY needs these: `wego
 * update` verifies a record before it trusts a manifest, so the pinned identity has
 * to be baked in. The publish-side rules that go with them are
 * `scripts/release-signing.ts`, which imports from here — scripts may depend on
 * `src/`, never the other way round.
 *
 * Keyless cosign rather than GitHub artifact attestations: attestations are
 * public-repo-only on the Free/Pro/**Team** plans and `wego/wego-ai` is private, so
 * the OIDC-token route is the one available to us. That is the design doc's own
 * note and the answer to the second plan check on foundations#74.
 */

/** The manifest every publish signs — the file that names every asset's sha256. */
export const MANIFEST_ASSET = "SHA256SUMS.txt";

/**
 * The signed build record for a publish: a Sigstore bundle — certificate chain,
 * signature and the transparency-log inclusion proof in one JSON object, exactly as
 * `cosign sign-blob --bundle` writes it. One well-known name, so a consumer never
 * has to discover it.
 */
export const SIGNATURE_ASSET = `${MANIFEST_ASSET}.sigstore.json`;

/**
 * What an acceptable identity looks like: an exact SAN URI, or an anchored pattern
 * for a family of them. A pattern is only ever used where the ref genuinely varies
 * and a consumer cannot know it in advance — never as a way to relax a check.
 */
export type IdentityRule = string | RegExp;

/**
 * The certificate identity a release record must carry: the workflow allowed to
 * sign one, as Fulcio records it in the leaf certificate's SAN.
 *
 * Pinned rather than derived, so a run of a DIFFERENT workflow in this repo — or of
 * this workflow on a fork or a side branch — cannot mint a record a client would
 * accept. Ref-pinned to `main` for the same reason only main is releasable at all.
 */
export const SIGNING_IDENTITY =
  "https://github.com/wego/wego-ai/.github/workflows/release-cli.yml@refs/heads/main";

/**
 * The SAME workflow, reached by its OTHER documented entry: `release-cli.yml` also
 * triggers on a `cli-v*` tag push, which its header calls the advanced/recovery
 * release. Fulcio names the ref it actually ran on, so that run signs as
 * `@refs/tags/cli-vX.Y.Z` and `SIGNING_IDENTITY` alone would refuse it — the
 * publish gate would fail AFTER the frozen `cli/<tag>` objects were written and
 * before `cli/next` advanced, and any client that did receive such a record would
 * refuse every update.
 *
 * THE `cli-` PREFIX IS NOT DECORATION AND MUST NOT BE "NORMALIZED" AWAY. The two
 * repositories cut DIFFERENT tag shapes, because their release-please configs
 * differ: wego-ai sets `include-component-in-tag: true` with `component: "cli"`,
 * so every release it ever cut is `cli-vX.Y.Z` (`cli-v1.1.0` is the last one);
 * `wego/cli` sets it false and cuts a bare `vX.Y.Z`. A rule written for one
 * repository's shape and pointed at the other's matches NOTHING — see
 * `CLI_RELEASE_TAG_IDENTITY` below, which is the same rule for the other repo and
 * deliberately has no prefix. That is precisely the slip this constant shipped
 * with in v1.2.0 (wego/cli#29): the port into this repository rewrote the
 * surrounding prose from wego-ai's point of view to this one and took the `cli-`
 * with it, leaving an identity that could never match a record that exists.
 *
 * A pattern rather than an exact string because the tag is the version: the
 * publisher knows it, but `wego update` reads a RING and cannot know which release
 * is behind it. What stays pinned is everything that carries the authority — the
 * repo, the workflow file, and `refs/tags/cli-v` followed by a bare `X.Y.Z`. The
 * `-rc.N` line is gone (rung 7), so a prerelease suffix is not a release identity.
 *
 * Anchored at both ends. Unanchored, `…release-cli.yml@refs/tags/cli-v1.0.0` would
 * also match as a substring of an attacker-chosen SAN that merely contains it.
 */
export const RELEASE_TAG_IDENTITY =
  /^https:\/\/github\.com\/wego\/wego-ai\/\.github\/workflows\/release-cli\.yml@refs\/tags\/cli-v\d+\.\d+\.\d+$/;

/**
 * The edge lane signs under its own workflow identity — same repo, same branch, a
 * different workflow file — so a dogfood record can never pass as a release record
 * and `cli/edge`'s much looser publish gate cannot reach `next` or `stable`.
 */
export const EDGE_SIGNING_IDENTITY =
  "https://github.com/wego/wego-ai/.github/workflows/edge-cli.yml@refs/heads/main";

/**
 * The same two lanes, in `wego/cli` — the repository the CLI now lives in
 * (wego/foundations#127, Phase 1).
 *
 * BOTH STRINGS WERE HARVESTED, NEVER TYPED. `scripts/extract-identities.ts`
 * downloaded the published records, read the SAN out of each leaf certificate
 * with `parseCertificate` — the same parser `verifySignedManifest` uses — and
 * emitted these two rules. Re-derive them at any time:
 *
 *     STORE_ORIGIN=<store> bun run scripts/extract-identities.ts \
 *       --tag v1.0.2 --edge 0.0.0-edge.4b980c0
 *
 * A hand-written identity is the failure this guards against: these differ from
 * the wego-ai strings above by a single path segment, so a transcription slip
 * either locks every client out of every update or quietly widens what one will
 * accept. Nothing here should ever be edited by hand — rerun the script.
 *
 * The wego-ai identities above STAY for now: production still serves builds
 * signed by wego-ai, and a client that stopped trusting them could not update
 * off the current release. 3c removes them, after the cutover.
 *
 * There is deliberately NO `wego/cli` counterpart to `SIGNING_IDENTITY`: unlike
 * wego-ai's, this repository's `release-cli.yml` has exactly one entrypoint, a
 * `v*` tag push (no `workflow_call`, no `workflow_dispatch`), so it can only
 * ever sign as `@refs/tags/vX.Y.Z`. A `@refs/heads/main` rule would widen the
 * trust set to cover a run that cannot happen.
 */
export const CLI_RELEASE_TAG_IDENTITY =
  /^https:\/\/github\.com\/wego\/cli\/\.github\/workflows\/release-cli\.yml@refs\/tags\/v\d+\.\d+\.\d+$/;

/** The `wego/cli` edge lane. Harvested with the rule above; see its comment. */
export const CLI_EDGE_SIGNING_IDENTITY =
  "https://github.com/wego/cli/.github/workflows/edge-cli.yml@refs/heads/main";

/**
 * GitHub Actions' OIDC issuer — the only issuer whose assertion of the identities
 * above means anything. Without pinning it, any issuer Fulcio trusts could assert
 * the same SAN string.
 */
export const SIGNING_OIDC_ISSUER =
  "https://token.actions.githubusercontent.com";

/**
 * The signing identities a ring's records may carry: `edge` is published by the edge
 * lane, `next` and `stable` by the release lane. `stable` is only ever reached by
 * promoting a `next` build, so it carries the release lane's identities too — the
 * promote copies the record, it does not re-sign.
 *
 * The release lane returns wego-ai's TWO rules because it has two documented
 * entries there (see `RELEASE_TAG_IDENTITY`), plus wego/cli's single tag rule —
 * that repository's release workflow has only the tag entrypoint. The edge lane
 * returns one rule per repository: each triggers only on main.
 *
 * BOTH REPOSITORIES ARE TRUSTED DURING THE MIGRATION, and that is the point: a
 * client updating today may be offered a build signed by either. 3c drops the
 * wego-ai rules once production no longer serves anything they vouch for.
 */
export function identitiesForRing(ring: string): readonly IdentityRule[] {
  return ring === "edge"
    ? [EDGE_SIGNING_IDENTITY, CLI_EDGE_SIGNING_IDENTITY]
    : [SIGNING_IDENTITY, RELEASE_TAG_IDENTITY, CLI_RELEASE_TAG_IDENTITY];
}
