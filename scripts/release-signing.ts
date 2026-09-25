import { MANIFEST_ASSET, SIGNATURE_ASSET } from "../src/release-signing";
import type { Ring } from "./ring-rules";

export {
  CLI_EDGE_SIGNING_IDENTITY,
  CLI_RELEASE_TAG_IDENTITY,
  EDGE_SIGNING_IDENTITY,
  identitiesForRing,
  MANIFEST_ASSET,
  SIGNATURE_ASSET,
  SIGNING_IDENTITY,
  SIGNING_OIDC_ISSUER,
} from "../src/release-signing";

/**
 * What a published release is signed with, and the rules a publish has to satisfy
 * before a pointer may name it.
 *
 * Checksums fetched from the same place as the binary prove the download was not
 * corrupted, not that it came from us: anyone who can write the release store can
 * replace the binary and `SHA256SUMS.txt` together. For a public `curl ... | bash`
 * install that gap matters.
 *
 * Each publish therefore signs its `SHA256SUMS.txt` with keyless cosign, using the
 * release workflow's own OIDC token: no key to store, rotate or leak, and the
 * signing event is also recorded in Sigstore's public transparency log, the one
 * copy of the record we do not host. GitHub's artifact attestations were the other
 * option, but they are public-repo-only on the Free/Pro/Team plans and
 * `wego/wego-ai` is private.
 *
 * One record covers every published file. The signature is over the manifest, not
 * each asset, because the manifest already names every asset by sha256; N
 * signatures could disagree, one cannot. `manifestCoversAll` is the other half: a
 * publish whose object set and manifest disagree is refused rather than
 * half-signed.
 *
 * Separate from `ring-rules.ts`, which owns which version shape a pointer accepts.
 * The two meet only at `Ring`.
 *
 * Pure rules, no I/O. `upload-release-blob.ts` enforces them at publish time,
 * `apps/api`'s `/install` serves the record, and `src/release-signing/signature.ts`
 * verifies it on the client.
 */

/**
 * Where a publish's signed build record lives: a sibling top-level prefix, never
 * inside the prefix the downloads are served from.
 *
 * The threat is write access to where the binaries are served from; a record next
 * to the manifest it signs would fall to the same write. Separate prefixes mean the
 * credential that publishes downloads is not, on its own, enough to also write a
 * matching record, and Sigstore's transparency log holds a copy we do not host.
 *
 * Parallel to `ring-rules.ts`'s `prefixForRing`: `cli/next` and `cli-sig/next`,
 * `cli/<tag>` and `cli-sig/<tag>`. `apps/api`'s `/install` derives the same swap
 * when it serves a record, and one publish writes both halves.
 */
export function sigPrefixForRing(ring: Ring): string {
  return `cli-sig/${ring}`;
}

/**
 * The immutable record prefix for one release tag, the counterpart of `cli/<tag>`.
 * A promote copies it onto a ring exactly as it copies the downloads, so promotion
 * stays a pointer move over byte-identical objects, records included.
 */
export function sigPrefixForTag(tag: string): string {
  return `cli-sig/${tag}`;
}

/**
 * Where the commit-binding sidecar lives: on the record prefix, never beside the
 * downloads it describes.
 *
 * `COMMIT` is publisher metadata, not a deliverable. It exists so a resume of a
 * partially-published tag can refuse a different commit, because `bun build
 * --compile` is not reproducible. Nothing downloads it.
 *
 * It cannot live under `cli/<tag>/`: `manifestCoversAll` requires every object
 * there to be listed in the signed manifest, and the sidecar is written after the
 * manifest was hashed and signed. Here coverage sees only real deliverables, the
 * sidecar keeps its own equality check, and nothing unsigned is served.
 */
export function commitSidecarPath(tag: string): string {
  return `${sigPrefixForTag(tag)}/COMMIT`;
}

/**
 * Every object name a manifest body lists, in the `<sha256>␠␠<name>` shape
 * `sha256sum` writes. Unparseable lines are skipped rather than guessed at, so a
 * blank result means "this manifest lists nothing", which `manifestCoversAll`
 * refuses rather than treating as vacuously satisfied.
 */
export function manifestEntries(body: string): string[] {
  const names: string[] = [];
  for (const line of body.split("\n")) {
    const match = /^[0-9a-f]{64}\s+\*?(\S.*)$/i.exec(line.trim());
    if (match) names.push(match[1].trim());
  }
  return names;
}

/**
 * `null` when `manifest` is a build record for exactly the files being published,
 * else the reason as one line for stderr.
 *
 * A pointer must never name an unsigned file. The signature covers the manifest,
 * so an object the manifest omits is one no record vouches for, and serving it
 * from a signed-looking prefix makes it look covered. The manifest is excluded
 * (it cannot list its own hash), and so is the record, which lives on another
 * prefix.
 */
export function manifestCoversAll(
  manifest: string,
  objects: string[],
): string | null {
  const listed = new Set(manifestEntries(manifest));
  if (listed.size === 0) {
    return `Refusing to advance a pointer: ${MANIFEST_ASSET} lists no files.`;
  }
  const required = objects.filter(
    (name) => name !== MANIFEST_ASSET && name !== SIGNATURE_ASSET,
  );
  const missing = required.filter((name) => !listed.has(name));
  if (missing.length > 0) {
    return (
      `Refusing to advance a pointer: ${missing.join(", ")} ` +
      `${missing.length === 1 ? "is" : "are"} not listed in the signed ${MANIFEST_ASSET}.`
    );
  }
  return null;
}

/**
 * The refusal a publisher prints when a ring's signed build record does not vouch
 * for its manifest.
 *
 * The bare verdict reason names the ring, not the signer. The record was written
 * seconds earlier by the same run, so "ring next refused this" sends an operator
 * to the publisher when the fault is in how the bundle was produced (runs
 * 32977203696 and 32930712877 were both misdiagnosed this way).
 *
 * So when the reason says the record could not be read, as opposed to read and
 * failed verification, append the one known cause: `cosign sign-blob` writing the
 * legacy bundle because `--new-bundle-format` is missing. A wrong identity or a
 * tampered payload parses and then fails, with a reason that says so.
 */
export function signedRecordRefusal(
  manifestPath: string,
  ring: string,
  reason: string,
): string {
  const base = `${manifestPath} is not vouched for on ring ${ring}: ${reason}`;
  return UNREADABLE_RECORD.test(reason)
    ? `${base}\n` +
        `The record could not be PARSED, which is a signer fault rather than a ring fault: ` +
        `a wrong identity or a tampered payload would parse and then fail verification. ` +
        `The known cause is \`cosign sign-blob\` writing the legacy cosign bundle - check the ` +
        `signing step passes \`--new-bundle-format\`.`
    : base;
}

/**
 * A verdict reason that means "could not read the record at all". Matched on the
 * parse-failure vocabulary `@wego/release-signing` uses, deliberately not on the
 * cosign-specific text, so a reworded parser message still routes here.
 */
const UNREADABLE_RECORD = /unreadable|malformed|not an object|not JSON|parse/i;
