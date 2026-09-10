import {
  ApiHttpError,
  ApiUnreachableError,
  NotFoundError,
  UnauthorizedError,
} from "./api";
import type { ProblemCode } from "./api-wire";
import { SettingsFileError } from "./settings";

/**
 * The `wego` CLI's stable exit-code taxonomy (QA-002 / issue #1110). Every
 * failure maps to one of these classes so callers/scripts can branch on the
 * exit code instead of scraping stderr:
 *
 *   0   ok
 *   1   generic/unknown error
 *   2   usage — bad args, parsed before any network call
 *   3   auth — not logged in / invalid_token (401) / insufficient_scope (403)
 *   4   not found / expired — not_found (404)
 *   5   retryable: rate_limited (429) / upstream_unavailable + upstream_rate_limited (503)
 *   6   permanent — validation_failed / bad_gateway / internal_error / other 4xx-5xx
 *   7   timeout / network
 *   130 interrupted (SIGINT)
 */
export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  AUTH: 3,
  NOT_FOUND: 4,
  RETRYABLE: 5,
  PERMANENT: 6,
  TIMEOUT: 7,
  SIGINT: 130,
} as const;

/** True for the abort raised by `AbortSignal.timeout` (per-request deadline). */
export function isTimeoutError(err: unknown): boolean {
  return (
    err instanceof DOMException &&
    (err.name === "TimeoutError" || err.name === "AbortError")
  );
}

/** True for a `fetch` network failure (DNS/connection refused/reset), which
 *  surfaces as a `TypeError` — distinct from a well-formed HTTP error response. */
function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError;
}

/**
 * Every member of the API's closed `code` enum, mapped onto its exit class. The
 * object literal is checked **both** ways against the generated `ProblemCode`:
 * a code the API added is a missing key, a code it renamed or dropped is an
 * excess one — so the enum and this table cannot drift apart silently the way
 * the hand-written switch here did. A `Map` (not a `Record` lookup) because the
 * wire `code` is an untrusted string: an unrecognised or future token misses and
 * falls through to the status fallback below.
 */
const EXIT_BY_PROBLEM_CODE = new Map<string, number>(
  Object.entries({
    invalid_token: EXIT.AUTH,
    insufficient_scope: EXIT.AUTH,
    not_found: EXIT.NOT_FOUND,
    // Permanent for this searchId: no wait repairs the scope, only a new search.
    rates_require_hotel_search: EXIT.PERMANENT,
    rate_limited: EXIT.RETRYABLE,
    upstream_unavailable: EXIT.RETRYABLE,
    upstream_rate_limited: EXIT.RETRYABLE,
    validation_failed: EXIT.PERMANENT,
    bad_gateway: EXIT.PERMANENT,
    internal_error: EXIT.PERMANENT,
  } satisfies Record<ProblemCode, number>),
);

/** Exit class for a typed `ApiHttpError`: prefer the API's machine `code` (a
 *  closed enum), else fall back to the HTTP status — which still covers an
 *  unparseable body, an absent `code`, and any code a newer API emits that this
 *  binary was compiled before. Split out of `exitCodeForError` to keep that
 *  dispatcher within the cognitive-complexity gate. */
function exitCodeForHttpError(err: ApiHttpError): number {
  const byCode =
    err.code === undefined ? undefined : EXIT_BY_PROBLEM_CODE.get(err.code);
  if (byCode !== undefined) return byCode;
  if (err.status === 401 || err.status === 403) return EXIT.AUTH;
  if (err.status === 404) return EXIT.NOT_FOUND;
  if (err.status === 429 || err.status === 503) return EXIT.RETRYABLE;
  return EXIT.PERMANENT;
}

/** Map any thrown value to the stable exit class above. */
export function exitCodeForError(err: unknown): number {
  // Bad local input, caught before any network call — the same class as a bad
  // flag, because a settings file IS the user's input (issue #1386).
  if (err instanceof SettingsFileError) return EXIT.USAGE;
  if (err instanceof UnauthorizedError) return EXIT.AUTH;
  if (err instanceof NotFoundError) return EXIT.NOT_FOUND;
  if (err instanceof ApiHttpError) return exitCodeForHttpError(err);
  // `fetchOrUnreachable` wraps a genuinely-unreached host (DNS/connect/reset or
  // the per-request deadline firing) into ApiUnreachableError; its `cause` is the
  // underlying TypeError/DOMException. Either way it's a network/timeout class.
  if (err instanceof ApiUnreachableError) return EXIT.TIMEOUT;
  if (isTimeoutError(err) || isNetworkError(err)) return EXIT.TIMEOUT;
  return EXIT.ERROR;
}

/**
 * Render a thrown value into a single, actionable stderr line: the API's `code`
 * and `detail`, the `trace_id` (which equals the API's request-log id — quote it
 * to support), a Retry-After hint, and the next action. stdout stays JSON-only,
 * so this only ever goes to stderr. `prog` is the invoked binary name.
 */
function formatHttpError(err: ApiHttpError, prog: string): string {
  const parts = [err.message];
  if (err.bodyParseError) parts.push("(unparseable error body)");
  if (err.traceId) parts.push(`trace_id=${err.traceId}`);
  if (err.retryAfterSeconds != null) {
    parts.push(`retry after ${err.retryAfterSeconds}s`);
  }
  parts.push(
    ...authRemedy(err, prog),
    ...rateLimitRemedy(err, prog),
    ...ratesScopeRemedy(err, prog),
  );
  return parts.join(" | ");
}

/** A re-read cannot fix a non-hotel-scoped searchId; the remedy names the re-mint command. */
function ratesScopeRemedy(err: ApiHttpError, prog: string): string[] {
  if (err.code !== "rates_require_hotel_search") return [];
  return [
    `this search is not hotel-scoped – re-run \`${prog} hotels rooms <hotelId> <checkIn> <checkOut>\` to price from a hotel-scoped search`,
  ];
}

/** Keyed on the code, not the 429 status: an allowance increase cannot repair `upstream_rate_limited`. */
function rateLimitRemedy(err: ApiHttpError, prog: string): string[] {
  if (err.code !== "rate_limited") return [];
  return [
    `usage limits on this research preview are deliberate – ask for a higher limit with \`${prog} feedback --message "..."\``,
  ];
}

/**
 * The next action for an auth-class failure, and there are two of them. A
 * missing or expired token is fixed by logging in again; a **scope shortfall**
 * is not — the session is valid, it just isn't permitted for this operation, and
 * re-running `login` re-requests the same scope set and lands on the same 403.
 * Saying "run `wego login`" there sends the caller round a loop that cannot
 * terminate, so the scope case gets its own line.
 *
 * Inert until `apps/api` enables per-route scope enforcement (`requireScope` is
 * wired and no-op), which is exactly why it is written now: the day it lands,
 * the remedy is already right.
 */
function authRemedy(err: ApiHttpError, prog: string): string[] {
  if (err.code === "insufficient_scope") {
    return [
      `not authorized for this operation – \`${prog} login\` would re-request the same scopes, so ask for this access to be granted to your Wego account`,
    ];
  }
  return exitCodeForError(err) === EXIT.AUTH ? [`run \`${prog} login\``] : [];
}

export function formatCliError(err: unknown, prog: string): string {
  if (err instanceof SettingsFileError) {
    // Name the file, because the whole point of the settings layer is that a
    // preference is inspectable — an unfixable "invalid settings" line would
    // reintroduce exactly the invisibility it replaced. ONE line, ` | `-joined
    // like `formatHttpError`: a non-zero exit owes the caller a single
    // actionable line, and three physical lines let a line-reader drop the path.
    return `${err.message} | ${err.path} | fix that file, or delete it to start over (\`${prog} config list\` re-reads it)`;
  }
  if (err instanceof ApiHttpError) return formatHttpError(err, prog);
  if (err instanceof UnauthorizedError) {
    return `Not authenticated – run \`${prog} login\`.`;
  }
  if (err instanceof ApiUnreachableError) {
    return `Could not reach the Wego API at ${err.url} – is the local \`apps/api\` running (\`bun dev\`), or check WEGO_API_URL and your network connection.`;
  }
  if (isTimeoutError(err)) {
    return "Request timed out. The API did not respond within the deadline – retry the command (re-poll with the same searchId).";
  }
  if (isNetworkError(err)) {
    return `Network error reaching the API – check connectivity and retry. (${
      err instanceof Error ? err.message : String(err)
    })`;
  }
  return err instanceof Error ? err.message : String(err);
}
