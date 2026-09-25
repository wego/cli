/**
 * Does `src/release-signing/sigstore-roots.ts` still match what Fulcio serves?
 *
 * Every binary pins its Fulcio trust anchors at build time (not fetched, not
 * from a system trust store), so the check does not depend on anything an
 * attacker who can write the release store could also reach. The consequence:
 * once Sigstore issues leaves under material a binary has never seen, that
 * binary refuses every later release. It keeps working but never updates
 * again, so it cannot take the fix either.
 *
 * Nothing else would notice. The release lane gets fresh certificates every run
 * and keeps signing fine, so CI stays green while binaries in the field stop
 * accepting new records.
 *
 * Why a scheduled check rather than a gate in the release lanes (making each
 * promote or rollback drive a real binary through a real update): that costs
 * ~30s of exposure on the path where exposure is being minimised, checks one tag
 * at a time, and only runs during an incident. The risk is rare, sudden and hits
 * every install at once, which suits a cheap scheduled check.
 *
 * Rotation is deliberately a code change (see `sigstore-roots.ts`). When this
 * fails, review and commit the new material. Every binary built before that
 * commit can then only be rolled back onto releases it can still verify.
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
 * Sorted because neither the endpoint nor the pin file promises an order; the
 * set of certificates is what matters. Whitespace is stripped because the pin
 * lives in a TypeScript template literal and the endpoint returns a plain
 * bundle, so line wrapping and trailing newlines differ harmlessly.
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
 * `null` when the pin still matches the live bundle, else the reason, ready for
 * stderr and for the issue this opens.
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
