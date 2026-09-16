/**
 * Does `src/release-signing/sigstore-roots.ts` still match what Fulcio serves?
 *
 * THE FAILURE THIS WATCHES FOR IS SILENT, GLOBAL AND UNRECOVERABLE. Every binary
 * carries its Fulcio trust anchors PINNED AT BUILD TIME - not fetched, not taken
 * from a system trust store, because the whole point of the check is not to depend
 * on anything an attacker who can write the release store could also reach. The
 * consequence is that the day Sigstore starts issuing leaves under material a
 * binary has never seen, that binary refuses every release published from then on.
 * It does not crash. It keeps working perfectly and simply never updates again,
 * and a binary that cannot take an update cannot take the fix either.
 *
 * NOTHING ELSE WOULD NOTICE. The release lane keeps signing fine - it gets fresh
 * certificates every run - so CI stays green while every binary in the field
 * quietly stops accepting new records. `docs/release.md` says it outright: "There
 * is no automatic notice when Fulcio rotates." This is that notice.
 *
 * WHY THIS AND NOT A GATE IN THE RELEASE LANES. The obvious alternative is to make
 * each promote or rollback prove the candidate can still verify something signed
 * today - drive a real binary through a real update before moving the pointer.
 * That was considered and rejected: it costs ~30s of exposure on the one path
 * where exposure is the thing being minimised, it asks the question one tag at a
 * time, and it only ever asks it during an incident. The risk here is rare and
 * sudden and hits the entire install base at once, which is exactly the shape a
 * cheap scheduled check handles well and an expensive per-operation gate handles
 * badly.
 *
 * ROTATION IS A CODE CHANGE, deliberately (see `sigstore-roots.ts`). When this
 * fails, the fix is to review and commit the new material - and to know that every
 * binary built before that commit now has a rollback horizon: it can only be rolled
 * back onto releases it can still verify.
 *
 * Run: `bun run scripts/check-fulcio-pin.ts`
 */

import { FULCIO_ROOTS_PEM } from "../src/release-signing/sigstore-roots";

/** Where `sigstore-roots.ts` says the pinned material was fetched from. */
export const FULCIO_ROOT_CERT_URL =
  "https://fulcio.sigstore.dev/api/v1/rootCert";

/**
 * The DER bodies of every certificate in a PEM bundle, sorted.
 *
 * Sorted because the endpoint's ORDER is not a promise and neither is the pin
 * file's - the SET of certificates is the claim. Whitespace is stripped for the
 * same reason: the pin lives inside a template literal in a TypeScript file and
 * the endpoint returns a plain bundle, so line wrapping and trailing newlines
 * differ for reasons that have nothing to do with trust.
 */
export function certificateBodies(pem: string): string[] {
  const bodies: string[] = [];
  let current: string | null = null;
  for (const line of pem.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "-----BEGIN CERTIFICATE-----") {
      current = "";
    } else if (trimmed === "-----END CERTIFICATE-----") {
      if (current) bodies.push(current);
      current = null;
    } else if (current !== null) {
      current += trimmed;
    }
  }
  return bodies.sort();
}

/**
 * `null` when the pin still matches the live bundle, else the reason - one
 * paragraph, ready for stderr and for the issue this opens.
 */
export function pinDrift(pinnedPem: string, livePem: string): string | null {
  const pinned = certificateBodies(pinnedPem);
  const live = certificateBodies(livePem);

  if (live.length === 0) {
    return `${FULCIO_ROOT_CERT_URL} returned no certificates. Refusing to treat an empty answer as agreement - check the endpoint by hand before believing this.`;
  }
  if (pinned.length === live.length && pinned.every((b, i) => b === live[i])) {
    return null;
  }

  const added = live.filter((b) => !pinned.includes(b)).length;
  const removed = pinned.filter((b) => !live.includes(b)).length;
  return [
    `The pinned Fulcio trust anchors no longer match ${FULCIO_ROOT_CERT_URL}:`,
    `${added} certificate(s) served but not pinned, ${removed} pinned but no longer served`,
    `(${pinned.length} pinned, ${live.length} live).`,
    "",
    "EVERY BINARY ALREADY IN THE FIELD PINS THE OLD SET. If Sigstore has begun",
    "issuing leaves under material those binaries do not carry, they will refuse",
    "every release published from now on - silently, permanently, and without",
    "being able to take a fix, because a binary that cannot verify an update",
    "cannot be updated into one that can.",
    "",
    "What to do:",
    "  1. Confirm by hand: curl the URL above and read the subjects and dates.",
    "  2. If Sigstore has genuinely rotated, update",
    "     src/release-signing/sigstore-roots.ts and review it like any other",
    "     change to what the binary trusts.",
    "  3. Note the rollback horizon this creates: binaries built BEFORE that",
    "     commit can only be rolled back onto releases they can still verify.",
  ].join("\n");
}

if (import.meta.main) {
  const response = await fetch(FULCIO_ROOT_CERT_URL);
  if (!response.ok) {
    console.error(
      `Could not reach ${FULCIO_ROOT_CERT_URL}: HTTP ${response.status}. This is not drift - it is an unanswered question, and it fails so that a reachability problem is never mistaken for agreement.`,
    );
    process.exit(1);
  }
  const drift = pinDrift(FULCIO_ROOTS_PEM, await response.text());
  if (drift) {
    console.error(drift);
    process.exit(1);
  }
  const count = certificateBodies(FULCIO_ROOTS_PEM).length;
  console.log(
    `ok: the ${count} pinned Fulcio certificate(s) are exactly what ${FULCIO_ROOT_CERT_URL} serves.`,
  );
}
