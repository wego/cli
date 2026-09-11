import { z } from "zod";
import type { CliConfig } from "./config";
import { formatZodError } from "./zod-error";

/**
 * OAuth2 Authorization-Code + PKCE token operations (client side). The CLI uses
 * Auth Code + PKCE only — never ROPC (OAuth 2.1). Refresh-token rotation is
 * handled by the AS; the CLI just persists whatever refresh token comes back.
 */

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when the access token expires, if `expires_in` was returned. */
  expiresAt?: number;
  /** The user's Wego market (POS), decoded from the id_token's `country_code`
   *  claim when present. Used to default `--site` (source `account`) so the CLI
   *  transacts in the user's market without the caller passing it. Undefined
   *  when the response carried no id_token, or it had no 2-letter country_code
   *  (auth-verified: `country_code` rides on the id_token, never the access
   *  token — so the API can't derive this; only the CLI can). */
  market?: string;
  /** Replayed to the API as the `x-wego-id-token` assertion. */
  idToken?: string;
}

/** Decode the `country_code` claim from an id_token JWT into a 2-letter market
 *  code, or `undefined`. Decode-only (NOT signature-verified): it's the user's
 *  own token, used solely to default `--site`, which an explicit `--site` always
 *  overrides — so a stale/expired id_token is harmless here. */
function marketFromIdToken(idToken: unknown): string | undefined {
  if (typeof idToken !== "string") return undefined;
  const payload = idToken.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    const cc = (claims as { country_code?: unknown }).country_code;
    if (typeof cc !== "string") return undefined;
    const code = cc.trim().toUpperCase();
    return /^[A-Z]{2}$/.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

/** The API tolerates an assertion this long past `exp`, since the hashes outlive
 *  the token; replaying a staler one only earns a per-request rejection. */
const ID_TOKEN_MAX_EXPIRED_AGE_MS = 24 * 60 * 60 * 1000;

export function isIdTokenUsable(idToken: unknown, now = Date.now()): boolean {
  if (typeof idToken !== "string") return false;
  const payload = idToken.split(".")[1];
  if (!payload) return false;
  try {
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    const exp = (claims as { exp?: unknown }).exp;
    if (typeof exp !== "number") return false;
    return now - exp * 1000 <= ID_TOKEN_MAX_EXPIRED_AGE_MS;
  } catch {
    return false;
  }
}

/** Build the `/authorize` URL for the loopback flow. */
export function buildAuthorizeUrl(
  config: CliConfig,
  params: { redirectUri: string; state: string; codeChallenge: string },
): string {
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", config.scopes);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/**
 * The untrusted `/token` response. Only `access_token` is required (a non-empty
 * string); `refresh_token` and `expires_in` are read leniently below — a missing
 * or odd-typed value just means "no refresh token" / "no known expiry" rather
 * than a hard failure, so an AS that omits or mistypes them still logs you in.
 */
const TokenResponseSchema = z.looseObject({
  access_token: z
    .string()
    .min(1, { message: "token response missing access_token" }),
  refresh_token: z.unknown().optional(),
  expires_in: z.unknown().optional(),
  id_token: z.unknown().optional(),
});

export function parseTokenResponse(json: unknown, now = Date.now()): TokenSet {
  const result = TokenResponseSchema.safeParse(json);
  if (!result.success) {
    throw new Error(formatZodError(result.error));
  }
  const body = result.data;
  const expiresIn = Number(body.expires_in);
  return {
    accessToken: body.access_token,
    refreshToken:
      typeof body.refresh_token === "string" ? body.refresh_token : undefined,
    expiresAt:
      Number.isFinite(expiresIn) && expiresIn > 0
        ? now + expiresIn * 1000
        : undefined,
    market: marketFromIdToken(body.id_token),
    idToken: typeof body.id_token === "string" ? body.id_token : undefined,
  };
}

/**
 * A non-2xx response from the token endpoint, carrying the auth server's own
 * OAuth2 error rather than collapsing every distinct cause to one status line.
 * Before this, a failed refresh reached the user as `token endpoint failed: 400`
 * and nothing said whether the token was revoked, expired, or rotated away, so
 * a lost session was undiagnosable after the fact (investigation #1360, H5).
 *
 * The refresh token is NEVER captured here. Only the non-secret RFC 6749 §5.2
 * error fields, and a bounded snippet of the raw body for the rare non-OAuth2
 * failure (a captive portal, a 5xx HTML page) — and the snippet stays off
 * stderr, reached only by the local failure record.
 */
export class TokenEndpointError extends Error {
  readonly status: number;
  readonly statusText: string;
  /** RFC 6749 §5.2 `error` code (e.g. `invalid_grant`), when the body had one. */
  readonly oauthError?: string;
  readonly oauthErrorDescription?: string;
  /** Up to `MAX_ERROR_BODY` chars of the raw body, only when no OAuth2 `error`
   *  was parsed. For the local record, never for stderr. */
  readonly bodySnippet?: string;

  constructor(args: {
    status: number;
    statusText: string;
    oauthError?: string;
    oauthErrorDescription?: string;
    bodySnippet?: string;
  }) {
    super(tokenErrorMessage(args));
    this.name = "TokenEndpointError";
    this.status = args.status;
    this.statusText = args.statusText;
    this.oauthError = args.oauthError;
    this.oauthErrorDescription = args.oauthErrorDescription;
    this.bodySnippet = args.bodySnippet;
  }
}

function tokenErrorMessage(args: {
  status: number;
  statusText: string;
  oauthError?: string;
  oauthErrorDescription?: string;
}): string {
  const base = `token endpoint failed: ${args.status} ${args.statusText}`;
  if (!args.oauthError) return base;
  const detail = args.oauthErrorDescription
    ? `${args.oauthError}: ${args.oauthErrorDescription}`
    : args.oauthError;
  return `${base} (${detail})`;
}

/** Cap on how many chars of an error body (or `error_description`) are retained,
 *  so a captive portal or a 5xx HTML page cannot flood the local record. */
const MAX_ERROR_BODY = 500;
/** Byte cap on the error body actually READ off the wire, so a mis-pointed or
 *  hostile `WEGO_AUTH_TOKEN_URL` cannot make the CLI buffer a huge body before
 *  the char cap above ever applies — the same hazard `version-notice.ts` bounds
 *  with `readBounded`. Generous vs `MAX_ERROR_BODY` so no real error is clipped. */
const MAX_ERROR_BODY_BYTES = 8 * 1024;

/** Truncate to `max` chars without ending on a lone high surrogate, so the
 *  snippet is always a well-formed string when read back from the record. */
function capText(text: string, max = MAX_ERROR_BODY): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
  return text.slice(0, end);
}

/** Redact the exact secret values the CLI just sent from a response body, so a
 *  token an auth server ever echoes back (a validation dump, a WAF page) cannot
 *  reach the local record or stderr (investigation #1360, lesson 6: design so
 *  the secret never moves). Exact-substring only — no guessing, no false
 *  redaction; the `>= 8` floor skips values too short to be a credential. */
export function redactSecrets(
  text: string,
  secrets: Array<string | undefined>,
): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 8) continue;
    // A secret can be reflected raw (a JSON field the AS echoes) OR
    // percent-encoded (the `x-www-form-urlencoded` request body the AS received
    // and reflects back), so redact both forms. The raw-only search misses a
    // token whose `+` / `/` / `=` chars were encoded on the wire.
    for (const form of secretForms(secret))
      out = out.split(form).join("[REDACTED]");
  }
  return out;
}

/** The distinct on-the-wire representations of a secret the CLI sent: the raw
 *  value, and its `x-www-form-urlencoded` form — the exact encoding `postToken`
 *  transmits it with. Deduped when the two coincide (a URL-safe value). */
function secretForms(secret: string): string[] {
  const encoded = new URLSearchParams({ v: secret }).toString().slice(2);
  return encoded === secret ? [secret] : [secret, encoded];
}

/**
 * Turn a token-endpoint error status + raw body into a {@link TokenEndpointError},
 * tolerantly: a JSON body with a string `error` yields the structured fields, and
 * anything else (non-JSON, or JSON without `error`) yields a bounded raw snippet.
 * Both retained texts are char-capped. Pure and never throws — a failed diagnosis
 * must not mask the auth failure it describes. The caller redacts secrets from
 * `rawBody` first (`postToken`), so nothing sensitive is captured even if the AS
 * echoes the request.
 */
export function parseTokenError(
  status: number,
  statusText: string,
  rawBody: string,
): TokenEndpointError {
  const body = rawBody.trim();
  // Cap `statusText` like the body fields: it is the AS-controlled reason
  // phrase and flows onto stderr and into the record, so a hostile/misconfigured
  // endpoint must not be able to flood either through it.
  const safeStatusText = capText(statusText);
  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    // Cap `error` too — it is attacker-controlled on a hostile endpoint and
    // reaches stderr via `tokenErrorMessage`. An empty-string `error` (some
    // proxies emit `{"error":""}`) is treated as absent, but a present
    // `error_description` still takes the structured path so the meaningful text
    // is captured as a field rather than dumped whole into `bodySnippet`.
    const oauthError =
      typeof json.error === "string" && json.error
        ? capText(json.error)
        : undefined;
    const oauthErrorDescription =
      typeof json.error_description === "string"
        ? capText(json.error_description)
        : undefined;
    if (oauthError || oauthErrorDescription) {
      return new TokenEndpointError({
        status,
        statusText: safeStatusText,
        oauthError,
        oauthErrorDescription,
      });
    }
  } catch {
    // Not JSON, or not an object — fall through to the raw-snippet path.
  }
  return new TokenEndpointError({
    status,
    statusText: safeStatusText,
    bodySnippet: body ? capText(body) : undefined,
  });
}

/** Token-endpoint request deadline. Bounds a stalled `/token` call so `login`
 *  / `whoami` surface a network failure promptly instead of hanging. */
const TOKEN_TIMEOUT_MS = 30_000;

/** Read at most `MAX_ERROR_BODY_BYTES` off an error response, then stop and drop
 *  the connection. Bounds memory the way `res.text()` cannot — it buffers the
 *  whole body first. Degrades to `""` on any read failure, never throws. */
/** Acquire a default reader, or `undefined` if the stream is locked/cancelled.
 *  Calling `getReader()` (no args) infers the default-reader type, which keeps
 *  `readCappedBody` from leaking a raw error when acquisition itself fails. */
function acquireReader(stream: ReadableStream<Uint8Array>) {
  try {
    return stream.getReader();
  } catch {
    return undefined;
  }
}

async function readCappedBody(res: Response): Promise<string> {
  const stream = res.body;
  if (!stream) return "";
  const reader = acquireReader(stream);
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // Copy only up to the remaining budget BEFORE storing, so a single
      // oversized chunk (a server that buffers the whole body) is neither
      // retained in full nor kept alive as a view over its backing buffer —
      // memory stays bounded to MAX_ERROR_BODY_BYTES.
      const remaining = MAX_ERROR_BODY_BYTES - size;
      const chunk =
        value.byteLength > remaining ? value.slice(0, remaining) : value;
      chunks.push(chunk);
      size += chunk.byteLength;
      if (size >= MAX_ERROR_BODY_BYTES) break;
    }
  } catch {
    return "";
  } finally {
    await reader.cancel().catch(() => {});
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function postToken(
  config: CliConfig,
  body: Record<string, string>,
): Promise<TokenSet> {
  const res = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  if (!res.ok) {
    // Read the body so the auth server's OAuth2 `error` survives instead of
    // being discarded at the throw site (investigation #1360, H5). Bounded, and
    // with the exact secrets we just sent redacted first, so a body that echoes
    // the request cannot leak the token into the record. Degrades to the bare
    // status line, never a crash.
    const rawBody = await readCappedBody(res);
    const redacted = redactSecrets(rawBody, [
      body.refresh_token,
      body.code,
      body.code_verifier,
    ]);
    throw parseTokenError(res.status, res.statusText, redacted);
  }
  return parseTokenResponse(await res.json());
}

export function exchangeCode(
  config: CliConfig,
  params: { code: string; codeVerifier: string; redirectUri: string },
): Promise<TokenSet> {
  return postToken(config, {
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: config.clientId,
    code_verifier: params.codeVerifier,
  });
}

export function refreshTokens(
  config: CliConfig,
  refreshToken: string,
): Promise<TokenSet> {
  return postToken(config, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.clientId,
  });
}

/** Whether the access token is at/near expiry (with a small skew). Unknown
 *  expiry → treat as valid and let a 401 drive a reactive refresh. */
export function isExpired(
  expiresAt: number | undefined,
  skewSec = 30,
  now = Date.now(),
): boolean {
  if (!expiresAt) return false;
  return now >= expiresAt - skewSec * 1000;
}
