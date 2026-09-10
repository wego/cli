import { writeOwnerJson } from "./config-dir";
import { TokenEndpointError } from "./oauth";

/**
 * A best-effort, local, single-record trace of the most recent failed token
 * exchange. It exists because a failed refresh otherwise writes NOTHING to disk
 * (investigation #1360, H5 / #1365): the reporter had to hand-decode a JWT to
 * reason about his own silent logout, and the next occurrence would have left
 * nothing at all. This is the on-disk trace that was missing.
 *
 * The refresh token is NEVER written here — only the non-secret RFC 6749 §5.2
 * error fields, the HTTP status, and the message the CLI printed. Written 0600
 * in the 0700 config dir, the same protection as the credential file beside it.
 */
export interface AuthFailureRecord {
  /** ISO-8601 UTC instant the CLI observed the failure. */
  at: string;
  /** The grant that failed; refresh is the unattended one this exists for. */
  grantType: "refresh_token";
  /** HTTP status from the token endpoint, absent when the call never reached it
   *  (a network failure or a timeout, which have no status). */
  status?: number;
  statusText?: string;
  /** RFC 6749 §5.2 `error` code (e.g. `invalid_grant`), when the body had one. */
  error?: string;
  errorDescription?: string;
  /** A bounded snippet of a non-OAuth2 error body (captive portal, 5xx HTML). */
  bodySnippet?: string;
  /** The human-facing message the CLI printed, for cross-referencing. */
  message: string;
}

/**
 * Build the record from the thrown refresh error. A {@link TokenEndpointError}
 * contributes the auth server's status and OAuth2 fields; any other error (a
 * network failure, a timeout) contributes only its message and leaves the wire
 * fields absent — the message still beats the nothing that was written before.
 * The refresh token is not an input here, so it cannot leak into the record.
 */
export function buildAuthFailureRecord(
  err: unknown,
  message: string,
  now: Date,
): AuthFailureRecord {
  const record: AuthFailureRecord = {
    at: now.toISOString(),
    grantType: "refresh_token",
    message,
  };
  if (err instanceof TokenEndpointError) {
    record.status = err.status;
    record.statusText = err.statusText;
    record.error = err.oauthError;
    record.errorDescription = err.oauthErrorDescription;
    record.bodySnippet = err.bodySnippet;
  }
  return record;
}

/** Overwrite the single last-auth-failure record, atomically. Uses the shared
 *  `writeOwnerJson` (tmp + `rename`, 0600) rather than a truncate-in-place
 *  `writeFile`, so two concurrent failing invocations cannot leave a torn,
 *  unparseable file — the same last-writer-wins/torn-write hazard investigation
 *  #1360 flagged (H6, lesson 3) for the credential writer next door. Best-effort
 *  by contract: the caller ignores a rejection so a diagnostics write can never
 *  mask the auth error it describes. */
export async function recordAuthFailure(
  path: string,
  record: AuthFailureRecord,
): Promise<void> {
  await writeOwnerJson(path, record);
}
