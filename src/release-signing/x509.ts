import {
  bitStringBytes,
  DerError,
  isContext,
  oidOf,
  readChildren,
  readTagged,
  TAG,
  type Tlv,
} from "./der";

/**
 * The four things `wego update` needs out of an X.509 certificate, and nothing
 * else (foundations#74 rung 9).
 *
 * A Sigstore/Fulcio leaf certificate answers "which workflow signed this, as
 * asserted by which OIDC provider" — the SAN and the Fulcio issuer extension — and
 * carries the public key the blob signature verifies against. Verifying that the
 * leaf is really Fulcio's needs one more thing: the exact `tbsCertificate` bytes its
 * issuer signed. This module reads those and stops.
 *
 * See `der.ts` for why this is hand-rolled rather than a dependency. Everything
 * here throws `DerError` on anything unexpected; `signature.ts` turns a throw into a
 * refusal, so a certificate this module cannot read is a certificate we do not
 * accept.
 */

/** Fulcio's OIDC-issuer extension (the v2, string-valued one). */
export const OID_FULCIO_ISSUER_V2 = "1.3.6.1.4.1.57264.1.8";
/** Fulcio's original issuer extension — a bare UTF-8 value, no ASN.1 wrapper. */
export const OID_FULCIO_ISSUER_V1 = "1.3.6.1.4.1.57264.1.1";
/** subjectAltName. */
export const OID_SAN = "2.5.29.17";
/** basicConstraints — read to tell a CA certificate from a leaf. */
export const OID_BASIC_CONSTRAINTS = "2.5.29.19";

/** ecdsa-with-SHA256, the only signature algorithm Fulcio issues or uses. */
export const OID_ECDSA_SHA256 = "1.2.840.10045.4.3.2";
/** ecdsa-with-SHA384, used by some Sigstore trust-root intermediates. */
export const OID_ECDSA_SHA384 = "1.2.840.10045.4.3.3";

export interface Certificate {
  /** The complete `tbsCertificate` encoding — the bytes the issuer signed. */
  tbs: Uint8Array<ArrayBuffer>;
  /** The signature algorithm OID from the outer `signatureAlgorithm` field. */
  signatureAlgorithm: string;
  /** The issuer's signature over `tbs`, as DER-encoded ECDSA (r, s). */
  signature: Uint8Array<ArrayBuffer>;
  /** The complete SubjectPublicKeyInfo encoding, ready for WebCrypto's `spki`. */
  spki: Uint8Array<ArrayBuffer>;
  /** Raw DER of the issuer and subject Names, for chain matching by exact bytes. */
  issuerDer: Uint8Array<ArrayBuffer>;
  subjectDer: Uint8Array<ArrayBuffer>;
  notBefore: Date;
  notAfter: Date;
  /** Every `uniformResourceIdentifier` in the SAN. */
  sanUris: string[];
  /** The OIDC issuer this certificate records, or null when it carries none. */
  oidcIssuer: string | null;
  /** True when basicConstraints marks this a CA. */
  isCa: boolean;
}

/** A certificate time's four-digit year. UTCTime carries two digits, which RFC
 *  5280 pivots at 50: 50-99 is 19xx, 00-49 is 20xx. GeneralizedTime carries all
 *  four and needs no pivot. */
function fullYear(raw: string, isUtcTime: boolean): number {
  const value = Number(raw);
  if (!isUtcTime) return value;
  return value >= 50 ? 1900 + value : 2000 + value;
}

/** Parse a UTCTime / GeneralizedTime value. */
function parseTime(tlv: Tlv): Date {
  const text = new TextDecoder().decode(tlv.content);
  // UTCTime is YYMMDDHHMMSSZ with a 2-digit year the RFC pivots at 50;
  // GeneralizedTime is YYYYMMDDHHMMSSZ.
  const match =
    tlv.tag === TAG.UTC_TIME
      ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text)
      : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text);
  if (!match) throw new DerError(`unreadable time "${text}"`);
  const [, y, mo, d, h, mi, s] = match;
  const year = fullYear(y, tlv.tag === TAG.UTC_TIME);
  return new Date(
    Date.UTC(year, Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)),
  );
}

/** Collect the URI entries out of a SAN extension value. */
function sanUrisFrom(extnValue: Uint8Array<ArrayBuffer>): string[] {
  const seq = readTagged(extnValue, TAG.SEQUENCE);
  const uris: string[] = [];
  for (const entry of readChildren(seq.content)) {
    // GeneralName's uniformResourceIdentifier is [6] IMPLICIT IA5String, so the
    // tag is primitive context-specific 6 — 0x86.
    if (entry.tag === 0x86) uris.push(new TextDecoder().decode(entry.content));
  }
  return uris;
}

/** The OIDC issuer an extension records, for either Fulcio extension shape. */
function oidcIssuerFrom(
  oid: string,
  extnValue: Uint8Array<ArrayBuffer>,
): string | null {
  if (oid === OID_FULCIO_ISSUER_V1) {
    // v1 stores the raw string with no inner ASN.1 wrapper.
    return new TextDecoder().decode(extnValue);
  }
  if (oid === OID_FULCIO_ISSUER_V2) {
    return new TextDecoder().decode(
      readTagged(extnValue, TAG.UTF8_STRING).content,
    );
  }
  return null;
}

/** Whether basicConstraints says CA. */
function isCaFrom(extnValue: Uint8Array<ArrayBuffer>): boolean {
  const seq = readTagged(extnValue, TAG.SEQUENCE);
  const children = readChildren(seq.content);
  const flag = children[0];
  // `content.length` is checked FIRST: an empty BOOLEAN makes `content[0]`
  // undefined, and `undefined !== 0` is true — so the absent flag would have read
  // as `cA: TRUE`, the permissive direction.
  return (
    flag !== undefined &&
    flag.tag === TAG.BOOLEAN &&
    flag.content.length > 0 &&
    flag.content[0] !== 0
  );
}

/** Read one Extensions entry: `SEQUENCE { extnID, critical DEFAULT FALSE, extnValue }`. */
function readExtension(tlv: Tlv): {
  oid: string;
  value: Uint8Array<ArrayBuffer>;
} {
  const children = readChildren(tlv.content);
  if (children.length < 2) throw new DerError("short extension");
  const oid = oidOf(children[0]);
  // The OCTET STRING is last; `critical` may or may not be present between them.
  const last = children.at(-1);
  if (!last || last.tag !== TAG.OCTET_STRING) {
    throw new DerError("extension not wrapped");
  }
  return { oid, value: last.content };
}

/**
 * The three extension-derived fields, out of a tbsCertificate's trailing
 * `[3] EXPLICIT SEQUENCE OF Extension` (itself optional). Split out of
 * `parseCertificate` so each function states one thing.
 */
type CertExtensions = Pick<Certificate, "sanUris" | "oidcIssuer" | "isCa">;

/** Every extension in the trailing `[3]` wrappers, flattened. */
function* extensionEntries(
  trailing: Tlv[],
): Generator<{ oid: string; value: Uint8Array<ArrayBuffer> }> {
  for (const rest of trailing) {
    if (!isContext(rest, 3)) continue;
    const seq = readTagged(rest.content, TAG.SEQUENCE);
    for (const ext of readChildren(seq.content)) yield readExtension(ext);
  }
}

/** Fold one extension into the fields being collected. */
function applyExtension(
  fields: CertExtensions,
  oid: string,
  value: Uint8Array<ArrayBuffer>,
): void {
  if (oid === OID_SAN) {
    fields.sanUris = sanUrisFrom(value);
    return;
  }
  if (oid === OID_BASIC_CONSTRAINTS) {
    fields.isCa = isCaFrom(value);
    return;
  }
  const issuerValue = oidcIssuerFrom(oid, value);
  if (issuerValue === null) return;
  // Prefer v2 when a certificate carries both, which Fulcio's do.
  if (fields.oidcIssuer === null || oid === OID_FULCIO_ISSUER_V2) {
    fields.oidcIssuer = issuerValue;
  }
}

function readExtensions(trailing: Tlv[]): CertExtensions {
  const fields: CertExtensions = {
    sanUris: [],
    oidcIssuer: null,
    isCa: false,
  };
  for (const { oid, value } of extensionEntries(trailing)) {
    applyExtension(fields, oid, value);
  }
  return fields;
}

/**
 * Parse a DER certificate. Throws `DerError` on anything it cannot read exactly —
 * there is no lenient path, because every field here feeds a trust decision.
 */
export function parseCertificate(der: Uint8Array<ArrayBuffer>): Certificate {
  const outer = readTagged(der, TAG.SEQUENCE);
  const [tbsTlv, algTlv, sigTlv] = readChildren(outer.content);
  if (!tbsTlv || !algTlv || !sigTlv) throw new DerError("short certificate");

  // Bound before use: an empty AlgorithmIdentifier would otherwise reach `oidOf`
  // as undefined and throw a TypeError, and this module's contract is that every
  // malformed input comes back as a DerError the caller turns into a refusal.
  const algOid = readChildren(algTlv.content)[0];
  if (!algOid) throw new DerError("certificate has no signature algorithm");
  const signatureAlgorithm = oidOf(algOid);
  const signature = bitStringBytes(sigTlv);

  const tbsChildren = readChildren(tbsTlv.content);
  // `version` is [0] EXPLICIT and optional; everything after it shifts by one.
  let i = 0;
  if (tbsChildren[0] && isContext(tbsChildren[0], 0)) i = 1;
  const serial = tbsChildren[i++];
  const innerAlg = tbsChildren[i++];
  const issuer = tbsChildren[i++];
  const validity = tbsChildren[i++];
  const subject = tbsChildren[i++];
  const spkiTlv = tbsChildren[i++];
  if (!serial || !innerAlg || !issuer || !validity || !subject || !spkiTlv) {
    throw new DerError("short tbsCertificate");
  }

  const [notBeforeTlv, notAfterTlv] = readChildren(validity.content);
  if (!notBeforeTlv || !notAfterTlv) throw new DerError("short validity");

  return {
    tbs: tbsTlv.full,
    signatureAlgorithm,
    signature,
    spki: spkiTlv.full,
    issuerDer: issuer.full,
    subjectDer: subject.full,
    notBefore: parseTime(notBeforeTlv),
    notAfter: parseTime(notAfterTlv),
    ...readExtensions(tbsChildren.slice(i)),
  };
}

/**
 * Convert a DER-encoded ECDSA signature (`SEQUENCE { r INTEGER, s INTEGER }`) to
 * the fixed-width `r ‖ s` WebCrypto expects.
 *
 * `size` is the curve's coordinate width in bytes (32 for P-256, 48 for P-384).
 * DER INTEGERs are signed and minimally encoded, so each half may carry a leading
 * zero to clear the sign bit, or be shorter than the field — both are normalised
 * here. A half that is genuinely wider than the field is malformed.
 */
export function ecdsaDerToRaw(
  der: Uint8Array<ArrayBuffer>,
  size: number,
): Uint8Array<ArrayBuffer> {
  const seq = readTagged(der, TAG.SEQUENCE);
  const [rTlv, sTlv] = readChildren(seq.content);
  if (!rTlv || !sTlv) throw new DerError("short ECDSA signature");
  const raw = new Uint8Array(size * 2);
  for (const [index, tlv] of [rTlv, sTlv].entries()) {
    if (tlv.tag !== TAG.INTEGER)
      throw new DerError("ECDSA half not an INTEGER");
    let value = tlv.content;
    // Strip the sign-clearing leading zeros DER adds.
    let start = 0;
    while (start < value.length - 1 && value[start] === 0) start++;
    value = value.subarray(start);
    if (value.length > size) throw new DerError("ECDSA half too wide");
    raw.set(value, index * size + (size - value.length));
  }
  return raw;
}

/** Read a PEM document's base64 body into DER bytes. Every `-----BEGIN X-----`
 *  block is returned, in order, so a bundled chain file works as one input. */
export function pemToDer(pem: string): Uint8Array<ArrayBuffer>[] {
  const blocks: Uint8Array<ArrayBuffer>[] = [];
  const re = /-----BEGIN [^-]+-----([\s\S]*?)-----END [^-]+-----/g;
  for (const match of pem.matchAll(re)) {
    const body = match[1].replaceAll(/\s+/g, "");
    blocks.push(Uint8Array.from(atob(body), (ch) => ch.codePointAt(0) ?? 0));
  }
  if (blocks.length === 0) throw new DerError("no PEM block found");
  return blocks;
}

/** Exact-bytes Name comparison — the only issuer/subject match worth making, since
 *  two Names that differ in encoding are different Names to a verifier. */
export function sameName(
  a: Uint8Array<ArrayBuffer>,
  b: Uint8Array<ArrayBuffer>,
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
