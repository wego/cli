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
 * Verify a Sigstore bundle over a release manifest (foundations#74 rung 9).
 *
 * `wego update` replaces the running binary whenever the ring's `SHA256SUMS.txt`
 * disagrees with the installed hash, so that manifest is the whole policy. TLS
 * proves only that the store served it, and the threat here is someone who can
 * write that store, who would replace the binary and the manifest together.
 *
 * So the manifest carries a signed build record, accepted only when:
 *
 * 1. its leaf certificate was issued by a pinned Fulcio root (not just any CA a
 *    system trust store holds);
 * 2. that certificate's SAN names a workflow allowed to publish this ring, and it
 *    records GitHub Actions as the OIDC provider that asserted it;
 * 3. the signature verifies over the manifest's exact bytes with that
 *    certificate's key, and any digest the record claims matches those bytes;
 * 4. the signing happened while that certificate was valid.
 *
 * Together: these bytes were signed by a run of our release workflow. Store write
 * access buys nothing, because Fulcio will not issue a certificate for that
 * identity to anyone else.
 *
 * Not checked: the transparency-log entry is read for its `integratedTime` only;
 * the Signed Entry Timestamp is not verified against Rekor's public key. That
 * would add public detectability (a record that never reached the log, or was
 * back-dated, would be caught) and is tracked as follow-on work. It does not
 * weaken the four properties above: without a Fulcio certificate for our workflow
 * identity, an attacker cannot produce a bundle this accepts.
 *
 * Fail-closed: every failure returns a refusal with a reason. No path returns
 * `ok` on a doubt, and no caller-supplied switch turns verification off.
 */

/**
 * Why a record was refused, in the three classes a consumer acts on differently.
 * `reason` carries the detail.
 *
 *  - `identity`: genuine and well-formed, but signed by an identity this consumer
 *    does not accept. Permanent; only a build with a different trust set can take
 *    it. Every 1.2.0 and 1.2.1 install was stranded here (wego/cli#29).
 *  - `inconsistent`: the record and manifest disagree, or the record could not be
 *    read. A ring mid-promote produces this: the publisher writes the record and
 *    the manifest separately, so a reader between them, or a cache straddling
 *    them for up to its TTL, sees one new and one old. Self-resolving.
 *  - `invalid`: not a Fulcio record at all (no pinned root, a chain that does not
 *    reach one, or a log time outside the leaf's validity). Permanent, and
 *    reinstalling does not help.
 *
 * When in doubt, `inconsistent`. Every class refuses the install, so wrongly
 * calling something self-resolving costs a wasted retry, while wrongly calling it
 * permanent makes a wrapper stop retrying something that would have cleared.
 */
export type VerifyFailure = "identity" | "inconsistent" | "invalid";

/** `reason` is ready for stderr. Success carries the matched identity so the
 *  caller can log which workflow's record it accepted. */
export type VerifyResult =
  | { ok: true; identity: string; issuer: string }
  | { ok: false; kind: VerifyFailure; reason: string };

export interface VerifyInput {
  /** Already `JSON.parse`d. Any shape is tolerated as input; only the expected
   *  shape is accepted. */
  bundle: unknown;
  /** The manifest's exact bytes, as fetched. */
  payload: Uint8Array<ArrayBuffer>;
  /** From `identitiesForRing`. Any one is enough; an empty list accepts nothing. */
  identity: readonly IdentityRule[];
  /** The OIDC issuer the leaf must record. */
  issuer: string;
  /** PEM. Injected rather than imported so tests pin their own root and a
   *  trust-root rotation is a data change. */
  rootsPem: string;
  /** Injectable so a test is not a clock race. */
  now?: Date;
}

/** Null when the algorithm is unsupported. */
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

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  // `atob` is lenient about some malformed input; reject upfront so a field that
  // is not base64 is a refusal rather than silently truncated bytes.
  // Protobuf's JSON mapping accepts both alphabets for a `bytes` field, so a
  // conformant bundle may use `-_` even though cosign writes the standard one.
  // Refusing it would invent a rule the format does not have, and the failure
  // would look like a forged record.
  const normalized = value
    .replaceAll(/\s+/g, "")
    .replaceAll("-", "+")
    .replaceAll("_", "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new DerError("field is not base64");
  }
  return Uint8Array.from(atob(normalized), (ch) => ch.codePointAt(0) ?? 0);
}

interface BundleParts {
  certDer: Uint8Array<ArrayBuffer>;
  /** Order among them is not assumed. */
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

/** Accepts the `certificate` (v0.3) and `x509CertificateChain` (v0.1/0.2)
 *  materials cosign has emitted. Anything else throws. */
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

/** Read for its time only; see the module header on what is not checked. */
function parseIntegratedTime(material: Record<string, unknown>): Date | null {
  const entries = material.tlogEntries;
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const raw = asRecord(entries[0]).integratedTime;
  // Protobuf-JSON writes an int64 as a string.
  const seconds = typeof raw === "string" ? Number(raw) : raw;
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000);
}

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

/** False on any failure, including a key that will not import on that curve, so
 *  the caller can try the next one. */
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
 * The curve is tried rather than declared: a certificate names the algorithm it
 * was signed with, not the curve of the signing key, and Sigstore's chain mixes
 * P-256 and P-384. Trying both is sound because a wrong curve can only fail, never
 * make a bad signature verify.
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

/**
 * Walks from `leaf` to one of `roots` through at most one supplied intermediate.
 * Returns the reason it could not, or null on success.
 *
 * Not a general path builder: Fulcio issues leaf, intermediate, root, and
 * accepting arbitrary depth on a security path only adds ways to be surprised.
 */
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

/** Constant-time-ish. Digest equality is not a secret, but the habit is worth
 *  keeping on this path. */
function sameBytes(
  a: Uint8Array<ArrayBuffer>,
  b: Uint8Array<ArrayBuffer>,
): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

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

/** So a refusal names what was expected. */
function describeRules(rules: readonly IdentityRule[]): string {
  if (rules.length === 0) return "no accepted identity";
  return rules
    .map((rule) => (typeof rule === "string" ? rule : rule.source))
    .join(" or ");
}

/** Who signed it. Checked before any cryptography: a record for the wrong
 *  identity is refused whatever it verifies against, and the refusal names the
 *  mismatch. */
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
 * When it was signed. A Fulcio certificate lives about ten minutes and has long
 * expired by the time anyone installs, so the check uses the transparency log's
 * integrated time rather than `now`. With no logged time nothing places the
 * signature inside the certificate's lifetime, so the record is refused.
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
  // A record logged in the future means a wrong clock somewhere; refuse rather
  // than guess which. Generous skew, because the runner's clock and this
  // machine's need not agree closely.
  if (integratedTime.getTime() > now.getTime() + 24 * 60 * 60 * 1000) {
    return "the signed build record is dated in the future";
  }
  return null;
}

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

interface ParsedRecord {
  parts: BundleParts;
  leaf: Certificate;
  intermediates: Certificate[];
  roots: Certificate[];
}

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
      // Not `invalid`: an unparseable bundle is usually a truncated or straddled
      // read rather than a forgery, and `VerifyFailure` prefers the
      // self-resolving class when the two are indistinguishable.
      kind: "inconsistent",
      reason: `unreadable signed build record: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

/**
 * Never throws: every failure, including a malformed bundle, comes back as
 * `{ ok: false, reason }`.
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

  // Whether Fulcio issued it. Without this the identity above is just a string
  // the signer chose for itself.
  const chainFailure = await chainToRoot(leaf, intermediates, roots);
  if (chainFailure) return { ok: false, kind: "invalid", reason: chainFailure };

  const timeFailure = timeRefusal(leaf, parts.integratedTime, now);
  if (timeFailure) return { ok: false, kind: "invalid", reason: timeFailure };

  // What it covers. The digest claim and the signature are both checked against
  // the bytes we hold, so a record for a different manifest cannot be replayed
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

  // The SAN that matched, not the rule: on the tag path the rule is a pattern, and
  // logging it would record no version.
  return {
    ok: true,
    identity: matchedIdentity(leaf, input.identity) ?? "",
    issuer: input.issuer,
  };
}
