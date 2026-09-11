import { MANIFEST_ASSET, SIGNATURE_ASSET } from "../src/release-signing";
import type { Ring } from "./ring-rules";

export {
  EDGE_SIGNING_IDENTITY,
  identitiesForRing,
  MANIFEST_ASSET,
  SIGNATURE_ASSET,
  SIGNING_IDENTITY,
  SIGNING_OIDC_ISSUER,
} from "../src/release-signing";

/**
 * What a published release is signed with, and the rules a publish has to satisfy
 * before a pointer may name it (foundations#74 rung 9).
 *
 * Checksums fetched from the same place as the binary prove the download was not
 * corrupted, NOT that it came from us: anyone who can write the release store can
 * replace the binary and `SHA256SUMS.txt` together, and every check below them
 * still passes. For a public `curl … | bash` install that is the gap worth
 * closing, and closing it is what makes this rung's rule real rather than
 * decorative.
 *
 * Each publish therefore signs its `SHA256SUMS.txt` with **keyless cosign**, using
 * the release workflow's own OIDC token — no key to store, rotate or leak, and the
 * signing event is additionally recorded in Sigstore's public transparency log,
 * which is the one copy of the record we do not host. GitHub's artifact
 * attestations would have been the other route; they are public-repo-only on the
 * Free/Pro/**Team** plans and `wego/wego-ai` is private, so cosign it is — the
 * design doc's own note, and the answer to the issue's second plan check.
 *
 * **One record covers every published file.** The signature is over the MANIFEST,
 * not over each asset, because the manifest already names every asset by sha256.
 * Signing N files would produce N records that could disagree; signing the one file
 * that enumerates them cannot. `manifestCoversAll` is the other half of that
 * argument: a manifest is only a build record for the files it actually lists, so a
 * publish whose object set and manifest disagree is refused rather than
 * half-signed.
 *
 * A separate module from `ring-rules.ts` on purpose — that file owns the RING axis
 * (which version shape a pointer accepts); this one owns the SIGNING axis. The two
 * meet only at `Ring`.
 *
 * Pure rules, no I/O. `upload-release-blob.ts` enforces them at publish time,
 * `apps/api`'s `/install` serves the record, and `apps/cli/src/signature.ts`
 * verifies it on the client.
 */

/**
 * Where a publish's signed build record lives: a SIBLING TOP-LEVEL prefix, never
 * inside the prefix the downloads are served from.
 *
 * "Stored outside the download location" is the whole point. The threat this rung
 * answers is write access to the place the binaries are served from; a record
 * sitting next to the manifest it signs would fall to the same write, and would
 * prove nothing the manifest did not already prove. Separating the prefixes means
 * the credential that publishes downloads is not, on its own, enough to also mint a
 * matching record — and Sigstore's transparency log holds a third copy we do not
 * host at all.
 *
 * Deliberately parallel to `ring-rules.ts`'s `prefixForRing`: `cli/next` ↔
 * `cli-sig/next`, `cli/<tag>` ↔ `cli-sig/<tag>`. `apps/api`'s `/install` derives the
 * same swap when it serves a record, and one publish writes both halves.
 */
export function sigPrefixForRing(ring: Ring): string {
  return `cli-sig/${ring}`;
}

/**
 * The immutable record prefix for one release tag — the frozen counterpart of
 * `cli/<tag>`, which a promote copies onto a ring exactly as it copies the
 * downloads. Promotion stays a pointer move over byte-identical objects, records
 * included.
 */
export function sigPrefixForTag(tag: string): string {
  return `cli-sig/${tag}`;
}

/**
 * Where the commit-binding sidecar lives: on the RECORD prefix, never beside the
 * downloads it describes.
 *
 * `COMMIT` is publisher metadata, not a deliverable. It exists so a resume of a
 * partially-published tag can refuse a DIFFERENT commit, because `bun build
 * --compile` is not reproducible. Nothing downloads it and no ring needs to serve
 * it.
 *
 * It used to sit at `cli/<tag>/COMMIT`, inside the download prefix, and that put it
 * in direct conflict with rung 9's coverage rule: `manifestCoversAll` requires every
 * object under the tag prefix to be listed in the signed manifest, and the sidecar
 * cannot be - it is written by the publisher AFTER the manifest was hashed and
 * signed. The two rules are individually right and were never run together until
 * wego-ai's 0.7.1, which published and verified cleanly and then refused its own
 * pointer move with "COMMIT is not listed in the signed SHA256SUMS.txt"
 * (run 33036257401).
 *
 * Moving it here resolves that without weakening either rule: coverage sees only
 * real deliverables, the sidecar keeps its own explicit equality check, and nothing
 * unsigned is served - which is strictly better than before, where the sidecar was
 * unsigned AND served. It is the same argument rung 9 already used to put the
 * signature record on a separate prefix.
 */
export function commitSidecarPath(tag: string): string {
  return `${sigPrefixForTag(tag)}/COMMIT`;
}

/**
 * Every object name a manifest body lists, in the `<sha256>␠␠<name>` shape
 * `sha256sum` writes. Unparseable lines are skipped rather than guessed at, so a
 * blank result reads as "this manifest lists nothing" — which `manifestCoversAll`
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
 * else the reason — one line, ready for stderr.
 *
 * This is "a pointer can never name an unsigned file", stated as code. The
 * signature covers the manifest, so an object the manifest omits is an object no
 * record vouches for: serving it from a signed-looking prefix is worse than not
 * signing at all, because it reads as covered. The manifest is excluded from the
 * requirement (it cannot list its own hash) and so is the record, which lives on
 * another prefix entirely.
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
 * The bare verdict reason names the RING, not the SIGNER, which is the wrong end of
 * the lane to start reading from: the record was written seconds earlier by the same
 * run, so "ring next refused this" sends an operator to the publisher when the fault
 * is upstream in how the bundle was produced. Run 32977203696 (wego-ai's 0.7.0, the
 * first real release) was diagnosed as a publish fault for exactly that reason, and
 * edge run 32930712877 before it.
 *
 * So when the reason says the record could not be READ - as opposed to read fine and
 * failed verification - append the one cause that produces it: `cosign sign-blob`
 * writing the legacy bundle because `--new-bundle-format` is missing. A parse failure
 * cannot come from a wrong identity or a tampered payload; those verify and then
 * fail, with a reason that says so.
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
