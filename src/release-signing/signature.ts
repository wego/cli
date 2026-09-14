import { DerError } from "./der";
import type { IdentityRule } from "./identity";
import {
  type Certificate,
  ecdsaDerToRaw,
  OID_ECDSA_SHA256,
  OID_ECDSA_SHA384,
  parseCertificate,
  pemToDer,
  sameName,
} from "./x509";

/**
 * Verify a **Sigstore** bundle over a release manifest (foundations#74 rung 9).
 *
 * `wego update` replaces the running binary whenever the ring's `SHA256SUMS.txt`
 * disagrees with the installed hash, so that manifest is the whole policy. Fetching
 * it over TLS proves only that the store served it — and the threat this rung
 * answers is precisely someone who can WRITE that store, who would replace the
 * binary and the manifest together and pass every check beneath them.
 *
 * So the manifest carries a signed build record, and this module decides whether to
 * believe it. What "believe" means here, exactly:
 *
 * 1. the record's leaf certificate was issued by a **pinned** Fulcio root (not just
 *    by some CA a system trust store happens to hold);
 * 2. that certificate names, in its SAN, the **one workflow** allowed to publish
 *    this ring, and records **GitHub Actions** as the OIDC provider that asserted
 *    it;
 * 3. the signature verifies over the manifest's exact bytes with that
 *    certificate's key, and the digest the record claims matches the bytes we hold;
 * 4. the signing happened while that certificate was valid.
 *
 * Together those say: these bytes were signed by a run of our release workflow on
 * main. Store write access buys nothing, because Fulcio will not issue a
 * certificate for that identity to anyone else.
 *
 * **What this does NOT check, and why that is stated rather than hidden.** The
 * bundle's transparency-log entry is read for its `integratedTime` only; the
 * Signed Entry Timestamp is not verified against Rekor's public key. Doing so adds
 * public detectability — a record that never reached the log, or was back-dated,
 * would be caught — which is worth having, and is tracked as follow-on work rather
 * than claimed here. It does not weaken the four properties above, which are what
 * the rung's rule rests on: an attacker who cannot obtain a Fulcio certificate for
 * our workflow identity cannot produce a bundle this function accepts, log entry or
 * no log entry.
 *
 * **Fail-closed everywhere.** Every failure — a malformed bundle, an unreadable
 * certificate, an unexpected algorithm, a mismatched digest — returns a refusal with
 * a reason. There is no path that returns `ok` on a doubt, and no caller-supplied
 * switch that turns verification off.
 */

/**
 * WHY a record was refused, in the three classes a CONSUMER has to act on
 * differently. The `reason` string carries the detail; this says what to do
 * about it.
 *
 *  - `identity` — the record is genuine and well-formed, and signed by someone
 *    this consumer does not accept. Permanent: waiting never helps, and only a
 *    build carrying a different trust set can take it. This is the class that
 *    stranded every 1.2.0 and 1.2.1 install (wego/cli#29).
 *  - `inconsistent` — the record and the manifest do not agree, or the record
 *    could not be read at all. **A ring mid-promote produces exactly this**: the
 *    publisher copies the record and the manifest as two adjacent writes, so a
 *    reader between them sees one new and one old, and a cache can straddle the
 *    pair for up to its TTL. Self-resolving.
 *  - `invalid` — the record is not a Fulcio record at all: no pinned root, a
 *    chain that does not reach one, or a log time outside the leaf's validity.
 *    Permanent, and reinstalling changes nothing.
 *
 * WHEN IN DOUBT, `inconsistent`. The install is refused in every class, so the
 * only cost of over-classifying as self-resolving is a wasted retry, while the
 * cost of over-classifying as permanent is a wrapper that stops retrying
 * something that would have cleared on its own.
 */
export type VerifyFailure = "identity" | "inconsistent" | "invalid";

/** A refusal carries the reason, ready for stderr, and the class of failure it
 *  belongs to; success carries the identity it verified, so the caller can log
 *  WHICH workflow's record it accepted. */
export type VerifyResult =
  | { ok: true; identity: string; issuer: string }
  | { ok: false; kind: VerifyFailure; reason: string };

export interface VerifyInput {
  /** The bundle, already `JSON.parse`d. Any shape is tolerated as INPUT; only the
   *  expected shape is accepted as valid. */
  bundle: unknown;
  /** The manifest's exact bytes, as fetched. */
  payload: Uint8Array<ArrayBuffer>;
  /** The identities the leaf's SAN may carry — `identitiesForRing`. Any one of
   *  them is enough; an empty list accepts nothing. */
  identity: readonly IdentityRule[];
  /** The OIDC issuer the leaf must record. */
  issuer: string;
  /** The trusted roots, PEM. Injected rather than imported so tests pin their own
   *  root and a future trust-root rotation is a data change. */
  rootsPem: string;
  /** Now, injectable so a test is not a clock race. */
  now?: Date;
}

/** The curve width for a signature algorithm OID, or null when unsupported. */
function curveFor(
  oid: string,
): { size: number; hash: string; curve: string } | null {
  if (oid === OID_ECDSA_SHA256) {
    return { size: 32, hash: "SHA-256", curve: "P-256" };
  }
  if (oid === OID_ECDSA_SHA384) {
    return { size: 48, hash: "SHA-384", curve: "P-384" };
  }
  return null;
}

/** Base64 → bytes, throwing on anything that is not base64. */
function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  // `atob` is lenient about some malformed input; reject upfront so a bundle field
  // that is not base64 is a refusal rather than silently truncated bytes.
  // Protobuf's JSON mapping accepts BOTH alphabets for a `bytes` field, so a
  // conformant bundle may use `-_`. cosign writes the standard alphabet today;
  // refusing the other one would be this verifier inventing a rule the format
  // does not have, and the failure would look like a forged record.
  const normalized = value
    .replaceAll(/\s+/g, "")
    .replaceAll("-", "+")
    .replaceAll("_", "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new DerError("field is not base64");
  }
  return Uint8Array.from(atob(normalized), (ch) => ch.codePointAt(0) ?? 0);
}

/** The pieces this verifier needs out of a bundle, or a throw. */
interface BundleParts {
  certDer: Uint8Array<ArrayBuffer>;
  /** Any intermediates the bundle shipped, leaf-first order not assumed. */
  intermediates: Uint8Array<ArrayBuffer>[];
  signature: Uint8Array<ArrayBuffer>;
  /** The sha256 the record claims for the payload, when it carries one. */
  claimedDigest: Uint8Array<ArrayBuffer> | null;
  integratedTime: Date | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new DerError("bundle is not an object");
  }
  return value as Record<string, unknown>;
}

/** The leaf certificate and any intermediates a bundle carries, accepting the
 *  `certificate` (v0.3) and `x509CertificateChain` (v0.1/0.2) materials cosign has
 *  emitted. Anything else throws. */
function parseCertificates(material: Record<string, unknown>): {
  certDer: Uint8Array<ArrayBuffer>;
  intermediates: Uint8Array<ArrayBuffer>[];
} {
  if (material.certificate !== undefined) {
    const raw = asRecord(material.certificate).rawBytes;
    if (typeof raw !== "string") {
      throw new DerError("certificate.rawBytes missing");
    }
    return { certDer: fromBase64(raw), intermediates: [] };
  }
  if (material.x509CertificateChain === undefined) {
    throw new DerError("bundle carries no certificate");
  }
  const certs = asRecord(material.x509CertificateChain).certificates;
  if (!Array.isArray(certs) || certs.length === 0) {
    throw new DerError("empty certificate chain");
  }
  const ders = certs.map((entry) => {
    const raw = asRecord(entry).rawBytes;
    if (typeof raw !== "string") {
      throw new DerError("chain entry has no rawBytes");
    }
    return fromBase64(raw);
  });
  // cosign writes the chain leaf-first.
  return { certDer: ders[0], intermediates: ders.slice(1) };
}

/** The signature and the digest a bundle claims for what it signed. */
function parseMessage(root: Record<string, unknown>): {
  signature: Uint8Array<ArrayBuffer>;
  claimedDigest: Uint8Array<ArrayBuffer> | null;
} {
  const message = asRecord(root.messageSignature);
  if (typeof message.signature !== "string") {
    throw new DerError("messageSignature.signature missing");
  }
  const signature = fromBase64(message.signature);
  if (message.messageDigest === undefined) {
    return { signature, claimedDigest: null };
  }
  const digest = asRecord(message.messageDigest);
  if (digest.algorithm !== undefined && digest.algorithm !== "SHA2_256") {
    // JSON.stringify, not String(): a non-string `algorithm` would otherwise read
    // as "[object Object]" and hide what the bundle actually claimed.
    throw new DerError(
      `unexpected digest algorithm ${JSON.stringify(digest.algorithm)}`,
    );
  }
  if (typeof digest.digest !== "string") {
    throw new DerError("messageDigest.digest missing");
  }
  return { signature, claimedDigest: fromBase64(digest.digest) };
}

/** When the transparency log recorded this entry, or null when it says nothing.
 *  Read for its time only — see the module header on what is and is not checked. */
function parseIntegratedTime(material: Record<string, unknown>): Date | null {
  const entries = material.tlogEntries;
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const raw = asRecord(entries[0]).integratedTime;
  // Protobuf-JSON writes an int64 as a string.
  const seconds = typeof raw === "string" ? Number(raw) : raw;
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000);
}

/** Pull everything this verifier needs out of a bundle, or throw. */
function parseBundle(bundle: unknown): BundleParts {
  const root = asRecord(bundle);
  const material = asRecord(root.verificationMaterial);
  const { certDer, intermediates } = parseCertificates(material);
  const { signature, claimedDigest } = parseMessage(root);
  return {
    certDer,
    intermediates,
    signature,
    claimedDigest,
    integratedTime: parseIntegratedTime(material),
  };
}

/** One attempt: verify `cert`'s signature with `issuer`'s key read on `curve`.
 *  False on any failure, including a key that will not import on that curve — the
 *  caller simply tries the next one. */
async function verifiedOnCurve(
  cert: Certificate,
  issuer: Certificate,
  curve: string,
  hash: string,
): Promise<boolean> {
  const size = curve === "P-384" ? 48 : 32;
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      issuer.spki,
      { name: "ECDSA", namedCurve: curve },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "ECDSA", hash },
      key,
      ecdsaDerToRaw(cert.signature, size),
      cert.tbs,
    );
  } catch {
    return false;
  }
}

/**
 * Verify `cert`'s own signature with `issuer`'s public key.
 *
 * The curve is tried rather than declared: a certificate names the algorithm it
 * was SIGNED with, not the curve of the key that signed it, and Sigstore's chain
 * mixes P-256 and P-384. Trying both is sound because a wrong curve cannot make a
 * bad signature verify — it can only fail.
 */
async function signedBy(
  cert: Certificate,
  issuer: Certificate,
): Promise<boolean> {
  const alg = curveFor(cert.signatureAlgorithm);
  if (!alg) return false;
  for (const curve of new Set(["P-256", "P-384"])) {
    if (await verifiedOnCurve(cert, issuer, curve, alg.hash)) return true;
  }
  return false;
}

/**
 * Walk from `leaf` to one of `roots`, through at most one supplied intermediate.
 * Returns the reason it could not, or null on success.
 *
 * A short, explicit walk rather than a general path builder: Fulcio issues
 * leaf → intermediate → root, and accepting arbitrary depth on a security path buys
 * nothing but ways to be surprised. Matching is by exact issuer/subject bytes and
 * then by signature — the name match only narrows the candidates, it never
 * substitutes for the cryptography.
 */
async function issuedByAny(
  cert: Certificate,
  issuers: Certificate[],
): Promise<boolean> {
  // The name match only narrows the candidates; the signature is what decides.
  for (const issuer of issuers) {
    if (!sameName(issuer.subjectDer, cert.issuerDer)) continue;
    if (await signedBy(cert, issuer)) return true;
  }
  return false;
}

async function chainToRoot(
  leaf: Certificate,
  intermediates: Certificate[],
  roots: Certificate[],
): Promise<string | null> {
  // A Fulcio signing leaf is never a CA. Accepting one would mean accepting a
  // certificate profile this verifier does not model.
  if (leaf.isCa) {
    return "the record's certificate is a CA certificate, not a signing leaf";
  }
  // Directly under a pinned certificate (which includes the pinned intermediate).
  if (await issuedByAny(leaf, roots)) return null;
  // Or under an intermediate the bundle shipped, which must itself chain to one.
  const cas = intermediates.filter((mid) => mid.isCa);
  for (const mid of cas) {
    if (!(await issuedByAny(leaf, [mid]))) continue;
    if (await issuedByAny(mid, roots)) return null;
  }
  return "the record's certificate does not chain to a pinned Sigstore root";
}

/** Constant-time-ish byte comparison. Digest equality is not a secret, but a
 *  length-then-loop compare is the habit worth keeping on this path. */
function sameBytes(
  a: Uint8Array<ArrayBuffer>,
  b: Uint8Array<ArrayBuffer>,
): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** WHO signed it. Checked before any cryptography: a record for the wrong identity
 *  is refused whatever it verifies against, and saying so names the mismatch. */
/** The SAN this record carries, when one of `rules` accepts it exactly. */
function matchedIdentity(
  leaf: Certificate,
  rules: readonly IdentityRule[],
): string | null {
  for (const uri of leaf.sanUris) {
    for (const rule of rules) {
      const hit = typeof rule === "string" ? uri === rule : rule.test(uri);
      if (hit) return uri;
    }
  }
  return null;
}

/** How the allowed identities read in a refusal, so it names what was expected. */
function describeRules(rules: readonly IdentityRule[]): string {
  if (rules.length === 0) return "no accepted identity";
  return rules
    .map((rule) => (typeof rule === "string" ? rule : rule.source))
    .join(" or ");
}

function identityRefusal(
  leaf: Certificate,
  identity: readonly IdentityRule[],
  issuer: string,
): string | null {
  if (matchedIdentity(leaf, identity) === null) {
    const named =
      leaf.sanUris.length > 0 ? leaf.sanUris.join(", ") : "no identity";
    return `the signed build record names ${named}, not ${describeRules(identity)} - refusing it`;
  }
  if (leaf.oidcIssuer !== issuer) {
    return (
      `the signed build record's OIDC issuer is ${leaf.oidcIssuer ?? "absent"}, ` +
      `not ${issuer} - refusing it`
    );
  }
  return null;
}

/**
 * WHEN it was signed. A Fulcio certificate lives about ten minutes, so it has long
 * expired by the time anyone installs — which is why the check is against the
 * transparency log's integrated time rather than against `now`. With no logged time
 * there is nothing to place the signature inside the certificate's lifetime, so the
 * record is refused rather than accepted on an unverifiable date.
 */
function timeRefusal(
  leaf: Certificate,
  integratedTime: Date | null,
  now: Date,
): string | null {
  if (!integratedTime) {
    return "the signed build record carries no transparency-log time";
  }
  if (integratedTime < leaf.notBefore || integratedTime > leaf.notAfter) {
    return "the signed build record was logged outside its certificate's validity";
  }
  // A record logged in the future is a clock lie somewhere; refuse it rather than
  // reason about which side is wrong. Generous skew, because the runner's clock and
  // this machine's need not agree closely.
  if (integratedTime.getTime() > now.getTime() + 24 * 60 * 60 * 1000) {
    return "the signed build record is dated in the future";
  }
  return null;
}

/** Verify the blob signature over `payload` with the leaf's key. */
async function payloadSigned(
  leaf: Certificate,
  signature: Uint8Array<ArrayBuffer>,
  payload: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  for (const curve of new Set(["P-256", "P-384"])) {
    const size = curve === "P-384" ? 48 : 32;
    try {
      const key = await crypto.subtle.importKey(
        "spki",
        leaf.spki,
        { name: "ECDSA", namedCurve: curve },
        false,
        ["verify"],
      );
      if (
        await crypto.subtle.verify(
          { name: "ECDSA", hash: "SHA-256" },
          key,
          ecdsaDerToRaw(signature, size),
          payload,
        )
      ) {
        return true;
      }
    } catch {
      // Try the next curve; a failed import is not a verdict.
    }
  }
  return false;
}

/** Everything a bundle contributes, once it has been read without throwing. */
interface ParsedRecord {
  parts: BundleParts;
  leaf: Certificate;
  intermediates: Certificate[];
  roots: Certificate[];
}

/** Read the bundle and the pinned roots, or the refusal for why we could not. */
function readRecord(
  input: VerifyInput,
):
  | { ok: true; record: ParsedRecord }
  | { ok: false; kind: VerifyFailure; reason: string } {
  try {
    const parts = parseBundle(input.bundle);
    return {
      ok: true,
      record: {
        parts,
        leaf: parseCertificate(parts.certDer),
        intermediates: parts.intermediates.map(parseCertificate),
        roots: pemToDer(input.rootsPem).map(parseCertificate),
      },
    };
  } catch (err) {
    return {
      ok: false,
      // Not `invalid`: a bundle we cannot parse is usually a truncated or
      // straddled read rather than a forged record, and the asymmetry above says
      // to prefer the self-resolving class when the two are indistinguishable.
      kind: "inconsistent",
      reason: `unreadable signed build record: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

/**
 * Verify a signed build record over a manifest. Never throws: every failure,
 * including a malformed bundle, comes back as `{ ok: false, reason }`.
 */
export async function verifySignedManifest(
  input: VerifyInput,
): Promise<VerifyResult> {
  const now = input.now ?? new Date();
  const read = readRecord(input);
  if (!read.ok) return read;
  const { parts, leaf, intermediates, roots } = read.record;
  if (roots.length === 0) {
    return {
      ok: false,
      kind: "invalid",
      reason: "no pinned Sigstore root to verify against",
    };
  }

  const identityFailure = identityRefusal(leaf, input.identity, input.issuer);
  if (identityFailure)
    return { ok: false, kind: "identity", reason: identityFailure };

  // WHETHER FULCIO ISSUED IT. Without this the identity above is just a string the
  // signer chose for itself.
  const chainFailure = await chainToRoot(leaf, intermediates, roots);
  if (chainFailure) return { ok: false, kind: "invalid", reason: chainFailure };

  const timeFailure = timeRefusal(leaf, parts.integratedTime, now);
  if (timeFailure) return { ok: false, kind: "invalid", reason: timeFailure };

  // WHAT it covers. The digest claim and the signature are both checked against the
  // bytes we actually hold, so a record for a DIFFERENT manifest cannot be replayed
  // over this one.
  const actual = new Uint8Array(
    await crypto.subtle.digest("SHA-256", input.payload),
  );
  if (parts.claimedDigest && !sameBytes(parts.claimedDigest, actual)) {
    return {
      ok: false,
      kind: "inconsistent",
      reason: "the signed build record is for a different manifest",
    };
  }
  if (!(await payloadSigned(leaf, parts.signature, input.payload))) {
    return {
      ok: false,
      kind: "inconsistent",
      reason: "the signed build record's signature does not verify",
    };
  }

  // The SAN that actually matched, not the rule that accepted it: on the tag path
  // the rule is a pattern, and a caller logging the rule would record no version.
  return {
    ok: true,
    identity: matchedIdentity(leaf, input.identity) ?? "",
    issuer: input.issuer,
  };
}
