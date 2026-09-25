/**
 * Release-tag gate for `.github/workflows/release-cli.yml` (the "Resolve version +
 * tag" step).
 *
 * `build-release.ts` bakes `${TAG#v}` into the binary as its version, and the
 * installed binary compares that string against the ring's `VERSION` object with
 * `parseSemver` (`src/version-notice.ts`). A tag the workflow accepts but the
 * parser rejects (`v0.4.3-rc.01`: a leading zero is semver-invalid) ships a binary
 * whose new-version notice can never fire.
 *
 * So this delegates to the parser the binary uses, and the workflow's regex is a
 * shape check only.
 *
 * Run: `bun scripts/validate-release-tag.ts v1.2.3`
 */

import { parseSemver } from "../src/version-notice";

/** The `v` prefix plus the character set a tag may use. Build metadata (`+`)
 *  is excluded even though semver allows it: the version becomes a Blob pathname
 *  (`cli/<tag>/`) and an asset name, and `+` is not safe in either. */
const TAG_SHAPE = /^v[0-9A-Za-z.-]+$/;

/** `null` when `tag` is releasable, else the reason as one line for stderr. */
export function releaseTagError(tag: string): string | null {
  if (!TAG_SHAPE.test(tag)) {
    return `Malformed tag '${tag}' - expected vX.Y.Z[-prerelease], with no build metadata.`;
  }
  const version = tag.slice("v".length);
  if (parseSemver(version) === null) {
    return `Unparseable version '${version}' in tag '${tag}' - the installed binary's version comparator (apps/cli/src/version-notice.ts) rejects it, so a binary stamped with it would never see a newer release. Leading zeros (rc.01), empty identifiers (a..b), and numbers past 9 digits are all invalid.`;
  }
  return null;
}

if (import.meta.main) {
  const tag = process.argv[2] ?? "";
  const error = releaseTagError(tag);
  if (error) {
    console.error(error);
    process.exit(1);
  }
  console.log(`Tag ${tag} is releasable.`);
}
