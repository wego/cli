/**
 * PKCE (RFC 7636) + CSRF `state` helpers for the loopback login flow.
 *
 * Portable Web Crypto only (runs under Bun/Node) — no secret, no Node-only
 * crypto. The AS enforces S256 server-side (`plain` is rejected), so we only
 * ever produce an S256 challenge.
 */

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function randomBase64url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/** A high-entropy code verifier (48 random bytes → 64 base64url chars, within
 *  RFC 7636's 43–128 range). */
export function generateCodeVerifier(): string {
  return randomBase64url(48);
}

/** S256 challenge = BASE64URL(SHA-256(verifier)). */
export async function codeChallengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64url(new Uint8Array(digest));
}

/** An opaque CSRF `state` value. */
export function generateState(): string {
  return randomBase64url(16);
}
