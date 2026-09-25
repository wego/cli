/**
 * The smallest DER reader that reads an X.509 certificate (foundations#74 rung 9).
 *
 * Verifying a Sigstore bundle means reading four fields of the Fulcio leaf
 * certificate: the subject-alternative name (which workflow signed), the Fulcio
 * OIDC-issuer extension (which provider asserted that), the public key, and the
 * exact bytes its issuer signed. The structure is fixed by RFC 5280, so no general
 * ASN.1 library is needed.
 *
 * Hand-rolled rather than a dependency because this runs inside the published
 * binary on a security path: a small reader with every branch tested beats a large
 * one whose behaviour on malformed input we would take on trust. Every function is
 * total: malformed input throws `DerError`, never a partial or guessed value, and
 * the caller turns a throw into a refusal.
 *
 * Not a general decoder: definite-length encodings only (DER admits no other
 * kind), lengths that overrun the buffer are rejected, and only the tags a
 * certificate uses are known.
 */

export class DerError extends Error {
  constructor(message: string) {
    super(`malformed DER: ${message}`);
    this.name = "DerError";
  }
}

/** By DER identifier octet. */
export const TAG = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  UTF8_STRING: 0x0c,
  SEQUENCE: 0x30,
  SET: 0x31,
  UTC_TIME: 0x17,
  GENERALIZED_TIME: 0x18,
} as const;

/** Slices of the original buffer, not copies. `full` matters as much as
 *  `content`: a certificate's signature covers the tbsCertificate's complete
 *  encoding, tag and length included, so re-encoding it would change the bytes
 *  being verified. */
export interface Tlv {
  tag: number;
  content: Uint8Array<ArrayBuffer>;
  /** Tag, length and value, as they appeared. */
  full: Uint8Array<ArrayBuffer>;
  /** Offset just past `full` in the parent buffer. */
  end: number;
}

export function readTlv(buf: Uint8Array<ArrayBuffer>, offset = 0): Tlv {
  if (offset + 2 > buf.length) throw new DerError("truncated header");
  const tag = buf[offset];
  // The high-tag-number form (0x1f in the low five bits) never appears in a
  // certificate; refuse it rather than mis-read it.
  if ((tag & 0x1f) === 0x1f) throw new DerError("multi-byte tags unsupported");
  const first = buf[offset + 1];
  let lengthOfLength = 0;
  let length: number;
  if (first < 0x80) {
    length = first;
  } else {
    lengthOfLength = first & 0x7f;
    // 0x80 is the indefinite-length form: legal in BER, forbidden in DER.
    if (lengthOfLength === 0) throw new DerError("indefinite length");
    // Four octets already exceed any certificate; refusing more avoids
    // constructing a length we cannot represent exactly.
    if (lengthOfLength > 4) throw new DerError("length too large");
    if (offset + 2 + lengthOfLength > buf.length) {
      throw new DerError("truncated length");
    }
    length = 0;
    for (let i = 0; i < lengthOfLength; i++) {
      length = length * 256 + buf[offset + 2 + i];
    }
  }
  const start = offset + 2 + lengthOfLength;
  const end = start + length;
  if (end > buf.length) throw new DerError("content overruns buffer");
  return {
    tag,
    content: buf.subarray(start, end),
    full: buf.subarray(offset, end),
    end,
  };
}

export function readTagged(
  buf: Uint8Array<ArrayBuffer>,
  tag: number,
  offset = 0,
): Tlv {
  const tlv = readTlv(buf, offset);
  if (tlv.tag !== tag) {
    throw new DerError(
      `expected tag 0x${tag.toString(16)}, got 0x${tlv.tag.toString(16)}`,
    );
  }
  return tlv;
}

export function readChildren(content: Uint8Array<ArrayBuffer>): Tlv[] {
  const out: Tlv[] = [];
  let offset = 0;
  while (offset < content.length) {
    const tlv = readTlv(content, offset);
    out.push(tlv);
    // A zero-width read would spin forever on crafted input. The header alone is
    // two octets, so this is unreachable except under a bug in readTlv; assert
    // rather than trust it.
    if (tlv.end <= offset) throw new DerError("non-advancing element");
    offset = tlv.end;
  }
  return out;
}

/** OBJECT IDENTIFIER content octets to dotted-decimal. */
export function decodeOid(content: Uint8Array<ArrayBuffer>): string {
  if (content.length === 0) throw new DerError("empty OID");
  const parts: number[] = [];
  // The first octet packs the first two arcs: 40*a + b, with a capped at 2.
  const first = content[0];
  const firstArc = Math.min(Math.floor(first / 40), 2);
  parts.push(firstArc, first - firstArc * 40);
  let value = 0;
  let started = false;
  for (let i = 1; i < content.length; i++) {
    const byte = content[i];
    // Base-128, high bit set on every octet but the last.
    value = value * 128 + (byte & 0x7f);
    started = true;
    if ((byte & 0x80) === 0) {
      parts.push(value);
      value = 0;
      started = false;
    }
  }
  if (started) throw new DerError("truncated OID arc");
  return parts.join(".");
}

export function oidOf(tlv: Tlv): string {
  if (tlv.tag !== TAG.OID) throw new DerError("not an OID");
  return decodeOid(tlv.content);
}

/**
 * A BIT STRING's payload, minus its unused-bits octet. Certificates use bit
 * strings for the signature value and for the wrapped SubjectPublicKeyInfo, and
 * both are whole octets, so a non-zero unused-bit count is malformed here.
 */
export function bitStringBytes(tlv: Tlv): Uint8Array<ArrayBuffer> {
  if (tlv.tag !== TAG.BIT_STRING) throw new DerError("not a BIT STRING");
  if (tlv.content.length === 0) throw new DerError("empty BIT STRING");
  if (tlv.content[0] !== 0) throw new DerError("unused bits in BIT STRING");
  return tlv.content.subarray(1);
}

/** A context-specific constructed tag `[n]`. */
export function isContext(tlv: Tlv, n: number): boolean {
  return tlv.tag === (0xa0 | n);
}
