/**
 * Release-tag gate for `.github/workflows/release-cli.yml` (the "Resolve version +
 * tag" step).
 *
 * A release tag is not just a label: `build-release.ts` bakes `${TAG#cli-v}` into
 * the binary as its version, and the installed binary compares that string against
 * the channel's `VERSION` object with `parseSemver` (`src/version-notice.ts`). So a
 * tag the WORKFLOW accepts but the PARSER rejects - `cli-v0.4.3-rc.01`, whose
 * leading-zero numeric identifier is semver-invalid - ships a binary whose
 * new-version notice can never fire for that install, silently, forever.
 *
 * The fix is to have ONE authority. This module delegates to the very parser the
 * binary uses, so the two grammars cannot drift: the workflow's regex is a shape
 * check only, and everything about what a version MEANS is decided here.
 *
 * Run: `bun apps/cli/scripts/validate-release-tag.ts cli-v1.2.3`
 */

import { parseSemver } from "../src/version-notice";

/** The `cli-v` prefix plus the character set a tag may use. Build metadata (`+`)
 *  is excluded even though semver allows it: the version becomes a Blob pathname
 *  (`cli/<tag>/`) and an asset name, and `+` is not safe in either. */
const TAG_SHAPE = /^cli-v[0-9A-Za-z.-]+$/;

/**
 * `null` when `tag` is releasable, else the reason - one line, ready for stderr.
 */
export function releaseTagError(tag: string): string | null {
  if (!TAG_SHAPE.test(tag)) {
    return `Malformed tag '${tag}' - expected cli-vX.Y.Z[-prerelease], with no build metadata.`;
  }
  const version = tag.slice("cli-v".length);
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
