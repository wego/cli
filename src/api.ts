import { release } from "node:os";
import { z } from "zod";
import type { FlightCabin, Op, WireQuery } from "./api-wire";
import { formatZodError } from "./zod-error";

/** A tolerant non-negative-integer count field. Absent OR malformed (fractional,
 *  negative, non-numeric, null) degrades to `undefined` (indeterminate) rather
 *  than being trusted as a count or throwing and failing the whole read. The
 *  `.optional()` is required, not redundant: it widens the type to
 *  `number | undefined` so `.catch(undefined)` typechecks (a catch on a bare
 *  `z.number()` must return a number). Shared by every settle-convergence /
 *  completed-empty count field on both verticals (issues #1084/#1112/#1113) so
 *  the tolerant shape can't drift between flights and hotels. */
const tolerantCount = z
  .number()
  .int()
  .nonnegative()
  .optional()
  .catch(undefined);

/**
 * Calls to the `apps/api` resource server: `GET /v1/user` (`wego whoami`) and
 * `GET /v1/places` (`wego places`). Both send the access token as a Bearer
 * credential, carry a per-request deadline, raise `UnauthorizedError` on a 401
 * (so the command can refresh + retry), and Zod-validate the response body.
 *
 * ## Response schemas are TOLERANT — in shape *and* in value (#1300 D3)
 *
 * The CLI is an installed binary. It cannot be redeployed alongside `apps/api`,
 * so a response schema here is a **reader**, never a mirror. `looseObject` and
 * `tolerantCount` make it tolerant in shape; these rules make it tolerant in
 * value, which matters more, because a `z.enum` is a CLOSED set: when the API
 * adds a member, zod rejects the value — and rejecting one value rejects the
 * WHOLE response, so the command dies rather than the field.
 *
 * - A field a command **branches on** MAY be `z.enum` / `z.literal`.
 * - A field the CLI only prints or forwards MUST NOT be a WIDENABLE closed set.
 *   For anything the API models as a string that means `z.string()`, with no
 *   exception for a value the API documents as a literal — the API can redeploy,
 *   the binary on someone's laptop cannot. A `z.boolean()` is the one type this
 *   leaves alone: its domain is both of its values already, so no redeploy can
 *   add a member for zod to reject (`expires`, on all four link routes). Narrowing a
 *   boolean to `z.literal(true)` WOULD be a closed set, and is banned like any
 *   other.
 * - A response schema MUST NOT carry a cross-field `.refine()`. No type can see
 *   a predicate, so Check A never reports one and neither does any other gate.
 *   Pairing invariants belong in `apps/api`, where a mistake is a redeploy away
 *   from fixed.
 * - Adding a closed set MUST come with the branch that justifies it, in the
 *   same change.
 *
 * Enforced by `api-contract.test.ts`, which walks these schemas and fails on a
 * closed set or a `.refine` it was not told about.
 *
 * ## The contract checks
 *
 * `api-contract.ts` holds the three compile-time checks that keep this file
 * honest against the API's published contract: Check A (everything the API can
 * return, the CLI parses), Check B (the fields the CLI's *behaviour* depends on
 * are still published) and Check C (the CLI's requests match what the API
 * accepts).
 */

/** The `GET /v1/user` body: `sub` is guaranteed; the AS may include further
 *  allowlisted claims (`looseObject` keeps them). Type inferred from the schema. */
const IdentitySchema = z.looseObject({ sub: z.string() });

export type Identity = z.infer<typeof IdentitySchema>;

/** Thrown on a 401 so the caller can attempt a reactive token refresh. */
export class UnauthorizedError extends Error {
  constructor() {
    super("unauthorized");
    this.name = "UnauthorizedError";
  }
}

/** Thrown on a 404 so a command can translate it into a friendly hint (e.g.
 *  "search expired", "unknown hotel", the `flights fares` re-search message)
 *  instead of a raw HTTP error. `label` names the call that 404'd. */
export class NotFoundError extends Error {
  constructor(
    readonly label: string,
    message?: string,
  ) {
    // A command that translates a 404 into a friendly hint can pass `message`
    // while keeping the type, so the error still maps to EXIT.NOT_FOUND (4)
    // instead of collapsing to the generic exit 1.
    super(message ?? `${label}: not found`);
    this.name = "NotFoundError";
  }
}

/** The fields carried by an {@link ApiHttpError}, parsed off the API response. */
export interface ApiHttpErrorFields {
  code?: string;
  detail?: string;
  traceId?: string;
  retryAfterSeconds?: number;
  bodyParseError?: boolean;
}

/**
 * A structured HTTP failure from the `apps/api` resource server. The API sends an
 * RFC 9457 `application/problem+json` body (machine `code`, human `detail`,
 * `trace_id`), an `x-trace-id` header, and `Retry-After` on 429/503 — this error
 * captures all of it so the CLI can print an actionable message and pick a stable
 * exit code (`error-report.ts`) instead of collapsing every failure to a bare
 * `status statusText`. Its `message` keeps the historical `"<label> failed:
 * <status>"` prefix so existing callers/tests that match on it still work.
 */
export class ApiHttpError extends Error {
  readonly status: number;
  readonly label: string;
  readonly code?: string;
  readonly detail?: string;
  readonly traceId?: string;
  readonly retryAfterSeconds?: number;
  readonly bodyParseError: boolean;

  constructor(status: number, label: string, fields: ApiHttpErrorFields = {}) {
    super(
      `${label} failed: ${status}` +
        (fields.code ? ` (${fields.code})` : "") +
        (fields.detail ? ` – ${fields.detail}` : ""),
    );
    this.name = "ApiHttpError";
    this.status = status;
    this.label = label;
    this.code = fields.code;
    this.detail = fields.detail;
    this.traceId = fields.traceId;
    this.retryAfterSeconds = fields.retryAfterSeconds;
    this.bodyParseError = fields.bodyParseError ?? false;
  }
}

/** Statuses safe to retry on a GET (idempotent read): the API's retryable
 *  problem classes — `rate_limited` (429) and `upstream_unavailable` (503). A
 *  `bad_gateway` (502) is treated as permanent, matching the exit taxonomy. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 503;
}

/** Parse a `Retry-After` header value — integer seconds only (the delta-seconds
 *  form the API uses); an HTTP-date form or garbage yields `undefined`. */
function parseRetryAfter(raw: string | null): number | undefined {
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : undefined;
}

interface ParsedProblemBody {
  code?: string;
  detail?: string;
  traceId?: string;
  bodyParseError: boolean;
}

/** Best-effort parse of the RFC 9457 `problem+json` body. A non-JSON body is
 *  simply empty; a malformed JSON body is flagged so it stays diagnosable. An
 *  empty body under a JSON content-type (common on a bare 429/503, where the
 *  proxy sets the header but sends no payload) is NOT malformed — there is simply
 *  nothing to parse, so it must not be flagged as a body-parse error. */
async function parseProblemBody(res: Response): Promise<ParsedProblemBody> {
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) return { bodyParseError: false };
  const raw = await res.text();
  if (raw.trim() === "") return { bodyParseError: false };
  try {
    const body = JSON.parse(raw) as Record<string, unknown>;
    if (!body || typeof body !== "object") return { bodyParseError: false };
    const str = (v: unknown): string | undefined =>
      typeof v === "string" ? v : undefined;
    return {
      code: str(body.code),
      detail: str(body.detail) ?? str(body.title),
      traceId: str(body.trace_id),
      bodyParseError: false,
    };
  } catch {
    return { bodyParseError: true };
  }
}

/** Read the RFC 9457 problem body + `x-trace-id`/`Retry-After` headers off an
 *  error response into a typed {@link ApiHttpError}. The `x-trace-id` header
 *  wins over a body `trace_id`; both are tolerated absent. */
async function readApiError(
  res: Response,
  label: string,
): Promise<ApiHttpError> {
  const parsed = await parseProblemBody(res);
  return new ApiHttpError(res.status, label, {
    code: parsed.code,
    detail: parsed.detail,
    traceId: res.headers.get("x-trace-id") ?? parsed.traceId,
    retryAfterSeconds: parseRetryAfter(res.headers.get("retry-after")),
    bodyParseError: parsed.bodyParseError,
  });
}

/** Delay before a GET retry: honor `Retry-After` (capped at 60s so a long server
 *  hint can't wedge the CLI), else a short fixed backoff. */
function retryDelayMs(retryAfterSeconds: number | undefined): number {
  if (retryAfterSeconds != null) return Math.min(retryAfterSeconds, 60) * 1000;
  return 500;
}

/**
 * Thrown when the request never reached `apps/api` at all — a DNS/connect/network
 * failure or the per-request deadline firing — as opposed to an HTTP status the
 * server returned. Distinct so the command layer can print an actionable hint
 * ("is the local api running?" / "check WEGO_API_URL") instead of Bun's raw
 * "Unable to connect" fetch message, which gives the user nothing to act on.
 */
export class ApiUnreachableError extends Error {
  constructor(
    readonly url: string,
    readonly cause: unknown,
  ) {
    super(`could not reach ${url}`);
    this.name = "ApiUnreachableError";
  }
}

// Baked static read like index.ts's VERSION; `Wego` keeps edge bot rules happy.
export const APP_VERSION = process.env.WEGO_BUILD_VERSION ?? "0.0.0-dev";
export const USER_AGENT = `Wego-CLI/${APP_VERSION}`;

/** Node's platform token to Genzo's vocabulary; closed, so anything else sends none. */
const OS_TYPE_BY_PLATFORM: Record<string, string | undefined> = {
  darwin: "OSX",
  linux: "LINUX",
  win32: "WINDOWS",
};

export function osTypeFor(platform: string): string | undefined {
  return OS_TYPE_BY_PLATFORM[platform];
}

export const OS_TYPE = osTypeFor(process.platform);
export const OS_VERSION = release();

/** This machine's UTC offset as `±HH:MM`; `getTimezoneOffset` counts minutes
 *  BEHIND UTC, so the sign inverts. */
export function utcOffsetOf(date: Date): string {
  const behind = date.getTimezoneOffset();
  const total = Math.abs(behind);
  const hours = String(Math.floor(total / 60)).padStart(2, "0");
  const minutes = String(total % 60).padStart(2, "0");
  return `${behind <= 0 ? "+" : "-"}${hours}:${minutes}`;
}

/** The analytics headers `apps/api` reads off each request. Both are uuids or
 *  absent — the API logs a warning for anything else. */
export interface AnalyticsHeaders {
  sessionId?: string;
  clientId?: string;
}

let analyticsHeaders: AnalyticsHeaders = {};

/** Pushed in by `index.ts` once per invocation. A value rather than a file read,
 *  so this module keeps no fs dependency and `bun test` writes nothing. */
export function setAnalyticsHeaders(headers: AnalyticsHeaders): void {
  analyticsHeaders = headers;
}

let identityAssertion: { token?: string; allowed: boolean } = {
  allowed: false,
};

export function setIdentityAssertion(
  token: string | undefined,
  allowed: boolean,
): void {
  identityAssertion = { token, allowed };
}

/** The refresh's own verdict, carry-forward already applied; `undefined` means
 *  there is none to send. Consent is never re-decided. */
export function refreshIdentityAssertion(token: string | undefined): void {
  identityAssertion = { ...identityAssertion, token };
}

/**
 * Run the request's `fetch`, mapping any thrown error (connection refused, DNS
 * failure, TLS error, or the `AbortSignal.timeout` deadline) to a typed
 * `ApiUnreachableError`. A `fetch` that *resolves* — even to a 4xx/5xx — never
 * throws here; only a genuinely-unreached host does, so HTTP-status handling
 * downstream is unaffected.
 */
export type HttpFetch = (
  url: string | URL,
  init?: RequestInit,
) => Promise<Response>;

async function fetchOrUnreachable(
  url: string | URL,
  init: RequestInit,
  http: HttpFetch = fetch,
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("user-agent", USER_AGENT);
  // Truthiness, not `!== undefined`: `Headers.set(name, undefined)` would send
  // the string "undefined", which the API rejects and warns about per request.
  const { sessionId, clientId } = analyticsHeaders;
  if (sessionId) headers.set("x-wego-session-id", sessionId);
  if (clientId) headers.set("x-wego-client-id", clientId);
  // Build, OS and offset, ungated: facts about the machine, not stored telemetry.
  headers.set("x-wego-app-version", APP_VERSION);
  if (OS_TYPE) headers.set("x-wego-os-type", OS_TYPE);
  if (OS_VERSION) headers.set("x-wego-os-version", OS_VERSION);
  // Per request, not once at import: a DST boundary moves the offset.
  headers.set("x-wego-timezone", utcOffsetOf(new Date()));
  // An assertion, never a credential: the API verifies it and binds it to `sub`.
  if (identityAssertion.allowed && identityAssertion.token) {
    headers.set("x-wego-id-token", identityAssertion.token);
  }
  try {
    return await http(url, { ...init, headers });
  } catch (err) {
    throw new ApiUnreachableError(String(url), err);
  }
}

/**
 * The shared authenticated-GET envelope both API calls use: send the access
 * token as a Bearer credential under a per-request deadline (without it a hung
 * `apps/api` would hang the CLI forever), raise `UnauthorizedError` on 401 so the
 * command can refresh + retry, and Zod-validate the body. `label` names the call
 * in error messages (e.g. "GET /v1/user"). Keeping this in one place means the
 * 401-refresh contract `withAccessToken` relies on can't drift between commands.
 */
async function authedJsonGet<T>(
  url: string | URL,
  accessToken: string,
  schema: z.ZodType<T>,
  label: string,
  timeoutMs: number,
  http?: HttpFetch,
): Promise<T> {
  // GET reads are idempotent, so a retryable failure (429/503) is retried once,
  // honoring Retry-After — max 2 attempts total. Non-retryable failures throw a
  // typed ApiHttpError carrying the API's code/detail/trace_id. A request that
  // never reaches the host surfaces as a typed ApiUnreachableError.
  const maxAttempts = 2;
  for (let attempt = 1; ; attempt++) {
    const res = await fetchOrUnreachable(
      url,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(timeoutMs),
      },
      http,
    );
    if (res.status === 401) throw new UnauthorizedError();
    if (res.status === 404) throw new NotFoundError(label);
    if (!res.ok) {
      const httpError = await readApiError(res, label);
      if (attempt < maxAttempts && isRetryableStatus(res.status)) {
        await Bun.sleep(retryDelayMs(httpError.retryAfterSeconds));
        continue;
      }
      throw httpError;
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new Error(`${label} returned a non-JSON body`);
    }
    const result = schema.safeParse(body);
    if (!result.success) {
      throw new Error(
        `${label} returned an unexpected body: ${formatZodError(result.error)}`,
      );
    }
    return result.data;
  }
}

/**
 * The POST twin of `authedJsonGet` — used by `wego hotels search` and
 * `wego flights search` to create a search (201). Same Bearer + deadline +
 * 401→refresh contract; a JSON body is sent. Create has no not-found case, so it
 * doesn't raise `NotFoundError`.
 */
async function authedJsonPost<T>(
  url: string | URL,
  accessToken: string,
  bodyValue: unknown,
  schema: z.ZodType<T>,
  label: string,
  timeoutMs: number,
  http?: HttpFetch,
): Promise<T> {
  const res = await fetchOrUnreachable(
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bodyValue),
      signal: AbortSignal.timeout(timeoutMs),
    },
    http,
  );
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    // No auto-retry on POST: a create is not idempotent, so a blind retry could
    // mint a duplicate upstream search until server-side Idempotency-Key support
    // lands (#1111). Surface the typed error so the caller can decide.
    throw await readApiError(res, label);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(`${label} returned a non-JSON body`);
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new Error(
      `${label} returned an unexpected body: ${formatZodError(result.error)}`,
    );
  }
  return result.data;
}

export function fetchWhoami(
  apiBaseUrl: string,
  accessToken: string,
  timeoutMs = 10_000,
  http?: HttpFetch,
): Promise<Identity> {
  const url = `${apiBaseUrl.replace(/\/$/, "")}/v1/user`;
  return authedJsonGet(
    url,
    accessToken,
    IdentitySchema,
    "GET /v1/user",
    timeoutMs,
    http,
  );
}

/** A resolved place. `looseObject` keeps any extra fields the API returns so the
 *  CLI prints whatever the gateway sends without dropping columns. */
const PlaceSchema = z.looseObject({
  name: z.string(),
  type: z.string(),
});

/** The `GET /v1/places` body: `{ results, metadata }` (the plain JSON the API
 *  returns — no MCP wrapper). Types inferred from the schema. */
const PlacesResponseSchema = z.object({
  results: z.array(PlaceSchema),
  metadata: z.object({
    resultCount: z.number(),
    totalCandidates: z.number(),
    hasMore: z.boolean(),
    hasAmbiguity: z.boolean(),
    disambiguationHint: z.string().optional(),
  }),
});

export type PlacesResponse = z.infer<typeof PlacesResponseSchema>;

/** Query for `GET /v1/places`, the same contract the API validates. */
export interface PlacesQuery {
  query: string;
  types?: string[];
  locale?: string;
  page?: number;
  pageSize?: number;
}

export function fetchPlaces(
  apiBaseUrl: string,
  accessToken: string,
  params: PlacesQuery,
  timeoutMs = 10_000,
  http?: HttpFetch,
): Promise<PlacesResponse> {
  const url = new URL(`${apiBaseUrl.replace(/\/$/, "")}/v1/places`);
  // Every key below is typed `WireQuery<"getPlaces">` — the parameter names the
  // published contract declares (Check C, #1300). Rename one on the API side and
  // this file stops compiling, at the literal, instead of 400ing for a user.
  const set = wireSetter<"getPlaces">(url);
  set("query", params.query);
  // Repeated `types` params (matches the API + Hono's array query parsing), so
  // this one needs `append`, which `set` cannot express. Binding the key through
  // `WireQuery<"getPlaces">` first keeps the claim above true of EVERY key: a
  // bare `append("types", …)` would be the one literal the contract never
  // checked, and renaming it upstream would still compile and then 400.
  const typesKey: WireQuery<"getPlaces"> = "types";
  for (const type of params.types ?? [])
    url.searchParams.append(typesKey, type);
  if (params.locale) set("locale", params.locale);
  if (params.page !== undefined) set("page", String(params.page));
  if (params.pageSize !== undefined) set("pageSize", String(params.pageSize));

  return authedJsonGet(
    url,
    accessToken,
    PlacesResponseSchema,
    "GET /v1/places",
    timeoutMs,
    http,
  );
}

// ---------------------------------------------------------------------------
// `wego info` — the four stateless reference reads (issue #1326)
// ---------------------------------------------------------------------------

/**
 * These four need no prior search, carry no expiring id, and are safe to call in
 * any order — which is exactly why they are one CLI group. Every schema below is
 * a tolerant READER per this module's header: `looseObject` so a field the API
 * adds still prints, and `z.string()` for anything the CLI only forwards or
 * displays — which is every field here. `window` and `coverage` are documented by
 * the API as closed sets and are deliberately NOT typed as such: the CLI prints
 * them for the agent to branch on, and an installed binary that rejected a value
 * a later API added would fail the whole response over one field.
 */

const HolidaySchema = z.looseObject({
  name: z.string(),
  key: z.string(),
  startDate: z.string(),
  endDate: z.string(),
});

const HolidaysResponseSchema = z.object({
  results: z.array(HolidaySchema),
  metadata: z.looseObject({
    resultCount: z.number(),
    countryCode: z.string(),
    // `z.string()`, not the two-value enum the API documents: the CLI only PRINTS
    // this, and a closed set fails the whole response on a value a future API
    // adds — in a binary already on someone's laptop. The agent reading the JSON
    // branches on it; this schema does not.
    window: z.string(),
    from: z.string(),
    to: z.string(),
  }),
});

export type HolidaysResponse = z.infer<typeof HolidaysResponseSchema>;

/** The CLI *flags* stay `--from`/`--to` (short, and unambiguous on a command
 *  whose only arguments are dates); the WIRE params are `fromDate`/`toDate`,
 *  because `from`/`to` already mean place codes on the flights operations. */
export interface HolidaysQuery {
  countryCode: string;
  from?: string;
  to?: string;
  locale?: string;
}

export function fetchHolidays(
  apiBaseUrl: string,
  accessToken: string,
  params: HolidaysQuery,
  timeoutMs = 10_000,
  http?: HttpFetch,
): Promise<HolidaysResponse> {
  const url = new URL(
    `${apiRoot(apiBaseUrl)}/v1/countries/${encodeURIComponent(params.countryCode)}/holidays`,
  );
  const set = wireSetter<"getCountryHolidays">(url);
  if (params.from) set("fromDate", params.from);
  if (params.to) set("toDate", params.to);
  if (params.locale) set("locale", params.locale);
  return authedJsonGet(
    url,
    accessToken,
    HolidaysResponseSchema,
    "GET /v1/countries/{countryCode}/holidays",
    timeoutMs,
    http,
  );
}

const VisaFreeDestinationSchema = z.looseObject({
  countryCode: z.string(),
  name: z.string(),
});

const VisaFreeResponseSchema = z.object({
  results: z.array(VisaFreeDestinationSchema),
  metadata: z.looseObject({
    resultCount: z.number(),
    totalCandidates: z.number(),
    hasMore: z.boolean(),
    passportCountryCode: z.string(),
    // Same reason as `window` above: printed, never branched on here.
    coverage: z.string(),
  }),
});

export type VisaFreeResponse = z.infer<typeof VisaFreeResponseSchema>;

export interface VisaFreeQuery {
  countryCode: string;
  locale?: string;
  page?: number;
  pageSize?: number;
}

export function fetchVisaFree(
  apiBaseUrl: string,
  accessToken: string,
  params: VisaFreeQuery,
  timeoutMs = 35_000,
  http?: HttpFetch,
): Promise<VisaFreeResponse> {
  // A longer deadline than the other three: the API walks the upstream's 20-row
  // pages to assemble one complete list, up to ten sequential reads.
  //
  // It must sit ABOVE the API's own walk budget (`WALK_BUDGET_MS`, 25s in
  // `apps/api/src/countries/visa-free.ts`), or the client gives up first and the
  // user is told "is the local api running? / check WEGO_API_URL" — pointing them
  // at their own config for a slow upstream, and throwing away the partial list
  // marked `coverage: "truncated"` that the API was about to return. 35s leaves
  // the server room to finish and answer.
  const url = new URL(
    `${apiRoot(apiBaseUrl)}/v1/countries/${encodeURIComponent(params.countryCode)}/visa-free-destinations`,
  );
  const set = wireSetter<"getVisaFreeDestinations">(url);
  if (params.locale) set("locale", params.locale);
  if (params.page !== undefined) set("page", String(params.page));
  if (params.pageSize !== undefined) set("pageSize", String(params.pageSize));
  return authedJsonGet(
    url,
    accessToken,
    VisaFreeResponseSchema,
    "GET /v1/countries/{countryCode}/visa-free-destinations",
    timeoutMs,
    http,
  );
}

const ScheduleSegmentSchema = z.looseObject({
  departureAirportCode: z.string(),
  arrivalAirportCode: z.string(),
  departureTime: z.string(),
  arrivalTime: z.string(),
  airlineCode: z.string(),
});

const FlightScheduleSchema = z.looseObject({
  airlineCode: z.string(),
  departureAirportCode: z.string(),
  arrivalAirportCode: z.string(),
  departureTime: z.string(),
  arrivalTime: z.string(),
  durationMinutes: z.number(),
  stopsCount: z.number(),
  segments: z.array(ScheduleSegmentSchema),
});

const ResolvedRouteEndpointSchema = z.looseObject({
  requested: z.string(),
  resolvedCityCode: z.string(),
});

const SchedulesResponseSchema = z.object({
  results: z.array(FlightScheduleSchema),
  metadata: z.looseObject({
    resultCount: z.number(),
    from: ResolvedRouteEndpointSchema,
    to: ResolvedRouteEndpointSchema,
    // Printed and forwarded only, so `z.string()` per the tolerance rules — even
    // though the API documents a two-value enum.
    siteCode: z.string(),
    siteCodeSource: z.string(),
  }),
});

export type SchedulesResponse = z.infer<typeof SchedulesResponseSchema>;

export interface SchedulesQuery {
  from: string;
  to: string;
  airline?: string;
  siteCode?: string;
  locale?: string;
  page?: number;
  pageSize?: number;
}

export function fetchSchedules(
  apiBaseUrl: string,
  accessToken: string,
  params: SchedulesQuery,
  timeoutMs = 15_000,
  http?: HttpFetch,
): Promise<SchedulesResponse> {
  const url = new URL(`${apiRoot(apiBaseUrl)}/v1/flights/schedules`);
  const set = wireSetter<"getFlightSchedules">(url);
  set("from", params.from);
  set("to", params.to);
  if (params.airline) set("airline", params.airline);
  if (params.siteCode) set("siteCode", params.siteCode);
  if (params.locale) set("locale", params.locale);
  if (params.page !== undefined) set("page", String(params.page));
  if (params.pageSize !== undefined) set("pageSize", String(params.pageSize));
  return authedJsonGet(
    url,
    accessToken,
    SchedulesResponseSchema,
    "GET /v1/flights/schedules",
    timeoutMs,
    http,
  );
}

const NearbyPlacesResponseSchema = z.object({
  // The rows are `placeSchema` verbatim, so the same reader the plain places
  // read uses — a caller can move a row between the two without reshaping it.
  results: z.array(PlaceSchema),
  metadata: z.looseObject({
    resultCount: z.number(),
    totalCandidates: z.number(),
    hasMore: z.boolean(),
    origin: z.looseObject({
      latitude: z.number(),
      longitude: z.number(),
      resolvedFrom: z.string(),
    }),
  }),
});

export type NearbyPlacesResponse = z.infer<typeof NearbyPlacesResponseSchema>;

export interface NearbyPlacesQuery {
  /** A place code; mutually exclusive with `latitude`/`longitude`. */
  place?: string;
  latitude?: number;
  longitude?: number;
  types?: string[];
  locale?: string;
  pageSize?: number;
}

export function fetchNearbyPlaces(
  apiBaseUrl: string,
  accessToken: string,
  params: NearbyPlacesQuery,
  timeoutMs = 15_000,
  http?: HttpFetch,
): Promise<NearbyPlacesResponse> {
  const url = new URL(`${apiRoot(apiBaseUrl)}/v1/places/nearby`);
  const set = wireSetter<"getNearbyPlaces">(url);
  if (params.place) set("place", params.place);
  if (params.latitude !== undefined) set("latitude", String(params.latitude));
  if (params.longitude !== undefined)
    set("longitude", String(params.longitude));
  // Repeated `types` params, matching the API's array query parsing — bound
  // through `WireQuery` first so every key here is contract-checked.
  const typesKey: WireQuery<"getNearbyPlaces"> = "types";
  for (const type of params.types ?? [])
    url.searchParams.append(typesKey, type);
  if (params.locale) set("locale", params.locale);
  if (params.pageSize !== undefined) set("pageSize", String(params.pageSize));
  return authedJsonGet(
    url,
    accessToken,
    NearbyPlacesResponseSchema,
    "GET /v1/places/nearby",
    timeoutMs,
    http,
  );
}

// ---------------------------------------------------------------------------
// Hotels (issues #1041 + #1042)
// ---------------------------------------------------------------------------

/** The occupancy the API priced upstream, echoed on create so the resolved
 *  child ages (the supplied list, or the age-8 fallback the API applies when
 *  none were given) are auditable client-side (issue #1114). Mirrors the API's
 *  `pricedOccupancySchema`. */
const pricedOccupancySchema = z.object({
  adults: z.number().int(),
  childrenAges: z.array(z.number().int()),
  rooms: z.number().int(),
});

export type PricedOccupancy = z.infer<typeof pricedOccupancySchema>;

/** Lenient response schemas — the CLI prints whatever the API returns, so extra
 *  fields are kept; only the fields commands branch on are asserted. */
const HotelsCreatedSchema = z.object({
  searchId: z.string(),
  // The occupancy priced upstream (resolved child ages incl. the age-8
  // fallback). Optional so the CLI still parses an older API's response; when
  // present the CLI surfaces it so the audited ages don't get silently
  // stripped (issue #1114).
  occupancy: pricedOccupancySchema.optional(),
  // The market the API resolved for this search + how the API got there
  // (explicit or default US). The CLI reports its OWN source (which can be
  // `account` when it derived the site from the id_token). Optional so the CLI
  // still parses an older API's response.
  siteCode: z.string().optional(),
  // `z.string()`, NOT `z.enum([...])` — see the closed-set rule in the module
  // header. Nothing branches on this value; the CLI only prints it.
  siteCodeSource: z.string().optional(),
});
const HotelsResultsSchema = z.looseObject({
  searchComplete: z.boolean().optional(),
  // `totalCandidates` distinguishes a genuinely-empty completed search (0) from
  // an empty page paged past the last (> 0) — see the completed-empty messaging
  // in `hotelsSearch` (issue #1113). A non-negative integer; a fractional/
  // negative/malformed value degrades to `undefined` (indeterminate) via
  // `.catch` rather than being trusted as a count or failing the whole read.
  metadata: z
    .looseObject({
      // Absent key AND malformed value both absorb to `undefined`
      // (indeterminate) via the shared `tolerantCount`.
      totalCandidates: tolerantCount,
      // `snapshotCandidateCount` is the upstream aggregation counter (issue
      // #1113): it stabilizes ~3× sooner than `searchComplete`/`done` flips, so
      // the CLI settle keys off it as the convergence signal (issue #1084),
      // exactly as flights use `snapshotFareCount`. Same tolerant shape as
      // `totalCandidates` (→ the settle falls back to item-presence on an
      // indeterminate count), never trusted as a count.
      snapshotCandidateCount: tolerantCount,
      // Candidates before this read's filters — what makes a zero authoritative.
      totalBeforeFilters: tolerantCount,
    })
    .optional(),
  results: z.array(z.unknown()).optional(),
});
const HotelDetailResponseSchema = z.looseObject({});
const HotelRatesResponseSchema = z.looseObject({
  searchComplete: z.boolean().optional(),
  rates: z.array(z.unknown()).optional(),
});
// `expires` gets the identical treatment as the flights booking-link below:
// `z.boolean()` because the CLI only prints it and never branches on it (a closed
// set would reject the whole response over one value, D3 `docs/wire-contract.md`),
// and `.optional()` because this field is added to an already-live route, so an
// `apps/api` rollback (it deploys independently of a CLI release) must drop the
// URL alongside `expires`, not take the whole command down over the missing field.
const HotelBookingLinkSchema = z.object({
  bookingUrl: z.string(),
  expires: z.boolean().optional(),
});
// `expires` is optional because the CLI prints it and never branches on it.
const HotelSearchLinkSchema = z.object({
  searchUrl: z.string(),
  expires: z.boolean().optional(),
});
// The reviews page is forwarded verbatim; only `metadata.totalCandidates` is
// read locally (the denominator the skill tells an agent to quote against), so
// it takes the same tolerant-count treatment as the results envelope.
const HotelReviewsResponseSchema = z.looseObject({
  metadata: z.looseObject({ totalCandidates: tolerantCount }).optional(),
  results: z.array(z.unknown()).optional(),
});

export type HotelsResultsResponse = z.infer<typeof HotelsResultsSchema>;
export type HotelRatesResponse = z.infer<typeof HotelRatesResponseSchema>;
/** The hotel-create body the CLI parses. Exported (with the three below) so
 *  `api-contract.ts` can compare it against the published contract — Check A
 *  reads the CLI side straight from `z.infer`, never from a hand-written list. */
export type HotelsCreatedResponse = z.infer<typeof HotelsCreatedSchema>;
export type HotelDetailResponse = z.infer<typeof HotelDetailResponseSchema>;
export type HotelBookingLinkResponse = z.infer<typeof HotelBookingLinkSchema>;
export type HotelSearchLinkResponse = z.infer<typeof HotelSearchLinkSchema>;
export type HotelReviewsResponse = z.infer<typeof HotelReviewsResponseSchema>;

/** The create-search body (matches the API's `createHotelsBodySchema`). Exactly
 *  one location field is set by the caller. */
export interface HotelsSearchBody {
  cityCode?: string;
  hotelId?: number;
  lat?: number;
  lng?: number;
  radius?: number;
  checkIn: string;
  checkOut: string;
  adults?: number;
  children?: number;
  /** Per-child ages (ints 0–17); length must equal `children` when present. */
  childrenAges?: number[];
  rooms?: number;
  currency?: string;
  locale?: string;
  siteCode?: string;
}

function apiRoot(apiBaseUrl: string): string {
  return apiBaseUrl.replace(/\/$/, "");
}

/**
 * A `searchParams.set` whose KEY is constrained to the query parameters one
 * operation publishes (Check C, #1300 link 7). The CLI is sending, so exactness
 * is correct here: the API validates and rejects, and a parameter renamed
 * upstream should break the build rather than a user's command.
 */
function wireSetter<O extends Op>(
  url: URL,
): (key: WireQuery<O>, value: string) => void {
  return (key, value) => {
    url.searchParams.set(key, value);
  };
}

/**
 * A query object the caller assembles for a forwarded-verbatim read. Keyed by
 * the operation's published parameter names, so `commands.ts` (which owns the
 * flag→param tables) is bound to the contract too.
 */
export type WireQueryValues<O extends Op> = Partial<
  Record<WireQuery<O>, string>
>;

/** Copy a `WireQueryValues` object onto a URL. `undefined` values are skipped —
 *  an optional key that was never set must not become `?key=undefined`. */
function setWireQuery<O extends Op>(url: URL, query: WireQueryValues<O>): void {
  // `Object.entries` over a generic mapped type loses the value type, so it is
  // re-stated here; the KEY is what this whole indirection exists to constrain,
  // and that is enforced where the object is built.
  const entries = Object.entries(query) as Array<[string, string | undefined]>;
  for (const [key, value] of entries) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
}

export function createHotelSearch(
  apiBaseUrl: string,
  accessToken: string,
  body: HotelsSearchBody,
  timeoutMs = 10_000,
  http?: HttpFetch,
): Promise<z.infer<typeof HotelsCreatedSchema>> {
  const url = `${apiRoot(apiBaseUrl)}/v1/hotels/searches`;
  return authedJsonPost(
    url,
    accessToken,
    body,
    HotelsCreatedSchema,
    "POST /v1/hotels/searches",
    timeoutMs,
    http,
  );
}

/** Query knobs for a results read (kebab-case params, forwarded verbatim) —
 *  keyed by the parameter names the contract publishes, so `commands.ts`'s
 *  flag→param table is bound to the API (Check C). */
export type HotelResultsQuery = WireQueryValues<"getHotelSearchResults">;

export function fetchHotelResults(
  apiBaseUrl: string,
  accessToken: string,
  searchId: string,
  query: HotelResultsQuery,
  timeoutMs = 10_000,
  http?: HttpFetch,
): Promise<HotelsResultsResponse> {
  const url = new URL(
    `${apiRoot(apiBaseUrl)}/v1/hotels/searches/${encodeURIComponent(searchId)}/results`,
  );
  setWireQuery(url, query);
  return authedJsonGet(
    url,
    accessToken,
    HotelsResultsSchema,
    "GET /v1/hotels/searches/:id/results",
    timeoutMs,
    http,
  );
}

export function fetchHotelDetails(
  apiBaseUrl: string,
  accessToken: string,
  hotelId: number,
  query: WireQueryValues<"getHotel">,
  timeoutMs = 10_000,
  http?: HttpFetch,
): Promise<z.infer<typeof HotelDetailResponseSchema>> {
  const url = new URL(`${apiRoot(apiBaseUrl)}/v1/hotels/${hotelId}`);
  setWireQuery(url, query);
  return authedJsonGet(
    url,
    accessToken,
    HotelDetailResponseSchema,
    "GET /v1/hotels/:id",
    timeoutMs,
    http,
  );
}

export function fetchHotelRates(
  apiBaseUrl: string,
  accessToken: string,
  hotelId: number,
  query: WireQueryValues<"getHotelRates">,
  timeoutMs = 10_000,
  http?: HttpFetch,
): Promise<HotelRatesResponse> {
  const url = new URL(`${apiRoot(apiBaseUrl)}/v1/hotels/${hotelId}/rates`);
  setWireQuery(url, query);
  return authedJsonGet(
    url,
    accessToken,
    HotelRatesResponseSchema,
    "GET /v1/hotels/:id/rates",
    timeoutMs,
    http,
  );
}

/** 25s, not the usual 10s: on an EMPTY page the API runs a second serial
 *  upstream call to prove the hotel exists, and each upstream leg has its own
 *  10s budget. A 10s deadline here would abort a valid empty result or 404 and
 *  report the API unreachable instead. */
export function fetchHotelReviews(
  apiBaseUrl: string,
  accessToken: string,
  hotelId: number,
  query: WireQueryValues<"getHotelReviews">,
  timeoutMs = 25_000,
  http?: HttpFetch,
): Promise<HotelReviewsResponse> {
  const url = new URL(`${apiRoot(apiBaseUrl)}/v1/hotels/${hotelId}/reviews`);
  setWireQuery(url, query);
  return authedJsonGet(
    url,
    accessToken,
    HotelReviewsResponseSchema,
    "GET /v1/hotels/:id/reviews",
    timeoutMs,
    http,
  );
}

export function fetchHotelBookingLink(
  apiBaseUrl: string,
  accessToken: string,
  hotelId: number,
  rateId: string,
  query: WireQueryValues<"getHotelRateBookingLink">,
  timeoutMs = 10_000,
  http?: HttpFetch,
): Promise<HotelBookingLinkResponse> {
  const url = new URL(
    `${apiRoot(apiBaseUrl)}/v1/hotels/${hotelId}/rates/${encodeURIComponent(rateId)}/booking-link`,
  );
  setWireQuery(url, query);
  return authedJsonGet(
    url,
    accessToken,
    HotelBookingLinkSchema,
    "GET /v1/hotels/:id/rates/:rateId/booking-link",
    timeoutMs,
    http,
  );
}

export function fetchHotelSearchLink(
  apiBaseUrl: string,
  accessToken: string,
  query: WireQueryValues<"getHotelSearchLink">,
  timeoutMs = 10_000,
  http?: HttpFetch,
): Promise<HotelSearchLinkResponse> {
  const url = new URL(`${apiRoot(apiBaseUrl)}/v1/hotels/search-link`);
  setWireQuery(url, query);
  return authedJsonGet(
    url,
    accessToken,
    HotelSearchLinkSchema,
    "GET /v1/hotels/search-link",
    timeoutMs,
    http,
  );
}
// --- Flights (issue #988) ---------------------------------------------------

/** The `POST /v1/flights/searches` body. `looseObject` on the response keeps any
 *  extra fields the API adds without dropping them. */
export interface CreateFlightSearchBody {
  from: string;
  to: string;
  fromDate: string;
  toDate?: string;
  /** Bound to the contract's own cabin set (Check C): the API rejects anything
   *  else, so there is no compatibility reason for the CLI to be loose here. A
   *  cabin added upstream shows up as a compile error, not a user's 400. */
  cabin?: FlightCabin;
  adults?: number;
  children?: number;
  infants?: number;
  currency?: string;
  locale?: string;
  siteCode?: string;
}

const CreateFlightSearchResponseSchema = z.object({
  searchId: z.string(),
  // The market the API resolved for this search + how the API got there
  // (explicit or default US). The CLI reports its OWN source (which can be
  // `account` when it derived the site from the id_token). Optional so the CLI
  // still parses an older API's response.
  siteCode: z.string().optional(),
  // `z.string()`, not a closed `z.enum` — see the module header's rule.
  siteCodeSource: z.string().optional(),
});

export type CreateFlightSearchResponse = z.infer<
  typeof CreateFlightSearchResponseSchema
>;

/** A clean fare, kept loose so the CLI prints whatever the API sends. */
const CleanFareSchema = z.looseObject({
  kind: z.string(),
  providerCode: z.string(),
  price: z.looseObject({ total: z.number(), currency: z.string() }),
  handoffUrl: z.string(),
});

const CleanTripSchema = z.looseObject({
  tripId: z.string(),
  fares: z.array(CleanFareSchema),
});

export type CleanTrip = z.infer<typeof CleanTripSchema>;

/**
 * The `?view=detail` trip variant, which is a DIFFERENT shape from the default
 * trip rather than a richer one (`apps/api` `flights/schema.ts`
 * `flightDetailSchema`): it carries `legs[]` where the default carries
 * `outbound`/`return`, and its fares carry a `provider` OBJECT where the default's
 * carry a flat `providerCode`. So one schema cannot cover both — and the
 * discriminant is the top-level `fares` array vs `legs` array, NOT `providerCode`
 * (which is nested inside each fare, never top-level): `CleanTripSchema` requires
 * `fares`, so a detail body carrying only `legs[]` fails that required key and
 * falls through. This is an IMPLICIT discriminator — disjoint and correct today,
 * but were `fares` ever made optional, or a detail body to grow a top-level
 * `fares`, the routing would flip with no type error and no red test.
 *
 * Tolerant past the two fields that identify it, per the value-tolerance rule
 * (`apps/api/docs/wire-contract.md` D3): `flights trip` prints the body and reads
 * no field from it, so anything narrower would reject a body the CLI is perfectly
 * able to hand over.
 */
const CleanTripDetailSchema = z.looseObject({
  tripId: z.string(),
  legs: z.array(z.unknown()),
});

/**
 * Both variants `getFlightTrip` publishes, in the order they are tried.
 *
 * The default is first because it is the narrower parse: a detail body fails it on
 * the missing required `fares` array and falls through, while a default body has no
 * `legs[]` for the second member to claim. `?view=` unions are published by the API precisely so a
 * client can bind both (#1300 link 2) — binding one made the spec a lie for the
 * other, and it would make the CLI throw a parse fault on a body the API declares.
 */
const FlightTripSchema = z.union([CleanTripSchema, CleanTripDetailSchema]);

export type FlightTrip = z.infer<typeof FlightTripSchema>;

/** The results read returns lean list cards with NO `fares[]` — a price *summary*
 *  plus per-leg summaries instead of the full trip envelope. Since #1308 this is
 *  the only projection the API serves there, so it is the only schema the CLI
 *  parses a results page with. Kept loose (like the trip schemas) so the CLI
 *  prints whatever extra fields the API sends. Mirrors the API's
 *  `flightCardsResultSchema` (apps/api flights/schema.ts), whose `metadata`
 *  carries the `snapshotFareCount` settle signal — so `results --wait` settles on
 *  the count, not just item-presence. */
const CardAirlineRefSchema = z.looseObject({
  code: z.string(),
  name: z.string(),
  logoUrl: z.string(),
});

const CardLegSchema = z.looseObject({
  from: z.string(),
  to: z.string(),
  departsAt: z.string(),
  arrivesAt: z.string(),
  durationMinutes: z.number(),
  stops: z.number(),
  airlines: z.array(CardAirlineRefSchema),
});

const FlightCardSchema = z.looseObject({
  tripId: z.string(),
  // Trip-level stops/duration, stated by the API since #1308 rather than folded
  // over `legs[]` by each caller. Optional so an older API without them parses.
  stops: z.number().optional(),
  durationMinutes: z.number().optional(),
  price: z.looseObject({
    total: z.number(),
    currency: z.string(),
    // `z.string()`, not `z.literal("party")`: the CLI prints this label and
    // branches on nothing, so a new scope value must widen the label, never fail
    // the whole card read. See the module header's closed-set rule.
    scope: z.string(),
    websiteCount: z.number(),
    hasWegoFare: z.boolean(),
  }),
  legs: z.array(CardLegSchema),
});

const FlightCardsResultSchema = z.object({
  searchId: z.string(),
  currencyCode: z.string(),
  metadata: z.looseObject({
    page: z.number(),
    pageSize: z.number(),
    resultCount: z.number(),
    totalCandidates: z.number(),
    hasMore: z.boolean(),
    // The convergence signal `results --wait` settles on. Declared explicitly
    // (not left to the loose passthrough) so it gets the tolerant-degrade:
    // optional, so a legacy API that omits it falls back to item-presence.
    snapshotFareCount: tolerantCount,
    // Pre-filter trip count; the settle guard reads this, not the page.
    snapshotTripCount: tolerantCount,
  }),
  results: z.array(FlightCardSchema),
});

export type FlightCardsResult = z.infer<typeof FlightCardsResultSchema>;
export type FlightCard = z.infer<typeof FlightCardSchema>;

/** The full filter/sort/pagination surface for the results read (kebab-cased on
 *  the wire, matching the API's query contract). */
export interface FlightResultsQuery {
  page?: number;
  pageSize?: number;
  sort?: string;
  airlines?: string[];
  stops?: string[];
  minPrice?: number;
  maxPrice?: number;
  maxDuration?: number;
  /** Layover-time bounds in minutes, judged on the largest leg total.
   *  Wire: `min-stopover-duration` / `max-stopover-duration`. */
  minStopoverDuration?: number;
  maxStopoverDuration?: number;
  bookingSites?: string[];
  /** Coarse outbound-departure time blocks (`midnight|morning|afternoon|night`),
   *  local time at the departure airport. Wire: `outbound-departure-blocks`. */
  departureBlocks?: string[];
  /** Exact outbound-departure `min-max` minute-of-day range (0-1439), local time;
   *  `min > max` wraps midnight. Wire: `outbound-departure-range`. */
  departureRange?: string;
  /** Coarse blocks for when the OUTBOUND leg lands, local to the ARRIVAL
   *  airport. Wire: `outbound-arrival-blocks`. */
  arrivalBlocks?: string[];
  /** Exact `min-max` minute-of-day window for when the OUTBOUND leg lands, local
   *  to the arrival airport. Wire: `outbound-arrival-range`. */
  arrivalRange?: string;
  /** As `departureBlocks`, for the RETURN leg. Wire: `return-departure-blocks`. */
  returnDepartureBlocks?: string[];
  /** As `departureRange`, for the RETURN leg. Wire: `return-departure-range`. */
  returnDepartureRange?: string;
  /** As `arrivalBlocks`, for the RETURN leg — when the traveller gets home.
   *  Wire: `return-arrival-blocks`. */
  returnArrivalBlocks?: string[];
  /** As `arrivalRange`, for the RETURN leg. Wire: `return-arrival-range`. */
  returnArrivalRange?: string;
  /** Inclusive elapsed-duration bounds on ONE leg, in minutes — distinct from
   *  `maxDuration`, which bounds the whole trip. Wire: `outbound-min-duration` /
   *  `outbound-max-duration` / `return-min-duration` / `return-max-duration`. */
  outboundMinDuration?: number;
  outboundMaxDuration?: number;
  returnMinDuration?: number;
  returnMaxDuration?: number;
  /** `any` (default) or `all`, i.e. every leg must carry a listed airline. Wire: `airlines-match`. */
  airlinesMatch?: string;
  /** `true` keeps only one-carrier-end-to-end trips. Wire: `same-airline`. */
  sameAirline?: string;
  /** Alliance codes; open set, see `metadata.filterOptions`. Wire: `alliances`. */
  alliances?: string[];
  /** Fare booking types (`wego|airline`). Wire: `booking-types`. */
  bookingTypes?: string[];
  /** IATA airport codes a connection must stop over in. Wire: `stopover-airports`. */
  stopoverAirports?: string[];
  /** Aircraft type codes (`388`), not the card labels (`A380`). Wire: `aircraft`. */
  aircraft?: string[];
  /** ISO-4217 currency the upstream reprices the snapshot into (default USD). */
  currency?: string;
  /** Locale the upstream returns the snapshot in (default en). */
  locale?: string;
}

export function createFlightSearch(
  apiBaseUrl: string,
  accessToken: string,
  body: CreateFlightSearchBody,
  timeoutMs = 15_000,
  http?: HttpFetch,
): Promise<CreateFlightSearchResponse> {
  const url = `${apiBaseUrl.replace(/\/$/, "")}/v1/flights/searches`;
  return authedJsonPost(
    url,
    accessToken,
    body,
    CreateFlightSearchResponseSchema,
    "POST /v1/flights/searches",
    timeoutMs,
    http,
  );
}

export function fetchFlightResults(
  apiBaseUrl: string,
  accessToken: string,
  searchId: string,
  query: FlightResultsQuery = {},
  timeoutMs = 15_000,
  http?: HttpFetch,
): Promise<FlightCardsResult> {
  const url = new URL(
    `${apiBaseUrl.replace(/\/$/, "")}/v1/flights/searches/${encodeURIComponent(
      searchId,
    )}/results`,
  );
  // Scalar params (kebab-cased on the wire where the API expects it). `page`/
  // `pageSize` may be 0-legal numbers, so guard on `!== undefined`, not truthy.
  const scalars: Array<
    [WireQuery<"getFlightSearchResults">, string | number | undefined]
  > = [
    ["page", query.page],
    ["pageSize", query.pageSize],
    ["sort", query.sort],
    ["min-price", query.minPrice],
    ["max-price", query.maxPrice],
    ["max-duration", query.maxDuration],
    ["min-stopover-duration", query.minStopoverDuration],
    ["max-stopover-duration", query.maxStopoverDuration],
    ["outbound-departure-range", query.departureRange],
    ["outbound-arrival-range", query.arrivalRange],
    ["return-departure-range", query.returnDepartureRange],
    ["return-arrival-range", query.returnArrivalRange],
    ["outbound-min-duration", query.outboundMinDuration],
    ["outbound-max-duration", query.outboundMaxDuration],
    ["return-min-duration", query.returnMinDuration],
    ["return-max-duration", query.returnMaxDuration],
    ["airlines-match", query.airlinesMatch],
    ["same-airline", query.sameAirline],
    ["currency", query.currency],
    ["locale", query.locale],
  ];
  for (const [key, value] of scalars) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  // CSV list params — joined on `,`; empty lists are dropped.
  const lists: Array<
    [WireQuery<"getFlightSearchResults">, string[] | undefined]
  > = [
    ["airlines", query.airlines],
    ["stops", query.stops],
    ["booking-sites", query.bookingSites],
    ["outbound-departure-blocks", query.departureBlocks],
    ["outbound-arrival-blocks", query.arrivalBlocks],
    ["return-departure-blocks", query.returnDepartureBlocks],
    ["return-arrival-blocks", query.returnArrivalBlocks],
    ["alliances", query.alliances],
    ["booking-types", query.bookingTypes],
    ["stopover-airports", query.stopoverAirports],
    ["aircraft", query.aircraft],
  ];
  for (const [key, value] of lists) {
    if (value?.length) url.searchParams.set(key, value.join(","));
  }
  // One shape since #1308: cards, never trips. A trip's fares come from
  // `fetchFlightTrip`, which is the only read that publishes them.
  return authedJsonGet(
    url,
    accessToken,
    FlightCardsResultSchema,
    "GET /v1/flights/searches/:searchId/results",
    timeoutMs,
    http,
  );
}

export function fetchFlightTrip(
  apiBaseUrl: string,
  accessToken: string,
  tripId: string,
  searchId: string,
  currency?: string,
  locale?: string,
  /** `default` | `detail`. Sent only when given, so the default read's query
   *  string is byte-identical to what it was before the flag existed. */
  view?: string,
  timeoutMs = 15_000,
  http?: HttpFetch,
): Promise<FlightTrip> {
  const url = new URL(
    `${apiBaseUrl.replace(/\/$/, "")}/v1/flights/trips/${encodeURIComponent(
      tripId,
    )}`,
  );
  const set = wireSetter<"getFlightTrip">(url);
  set("searchId", searchId);
  if (currency) set("currency", currency);
  if (locale) set("locale", locale);
  if (view) set("view", view);
  return authedJsonGet(
    url,
    accessToken,
    FlightTripSchema,
    "GET /v1/flights/trips/:tripId",
    timeoutMs,
    http,
  );
}

/** The experience body is forwarded verbatim — `flightsExperience` prints it and
 *  reads no field, so every member here is tolerant and none is consumed. It is
 *  declared rather than left bare so Check A still binds the CLI to the published
 *  200 shape. */
const TripExperienceResponseSchema = z.looseObject({
  tripId: z.string().optional(),
  legs: z.array(z.unknown()).optional(),
  metadata: z.looseObject({ legCount: tolerantCount }).optional(),
});

export type TripExperienceResponse = z.infer<
  typeof TripExperienceResponseSchema
>;

/** `GET /v1/flights/trips/:tripId/experience` — the trip's per-leg signals.
 *  `searchId` is an optional cross-check, not a required context param: the
 *  tripId already carries its search segment.
 *
 *  15s, not 10s, and for the same reason `fetchFlightTrip` uses 15s: the API's own
 *  `UPSTREAM_TIMEOUT_MS` is 10s and starts AFTER this deadline does, so a matching
 *  10s here expires first. That turns a healthy near-limit response into a
 *  client-side network failure, and it discards the documented `503` +
 *  `Retry-After` the API would otherwise return. The client budget must sit
 *  outside the server's, never on top of it. */
export function fetchTripExperience(
  apiBaseUrl: string,
  accessToken: string,
  tripId: string,
  query: WireQueryValues<"getTripExperience"> = {},
  timeoutMs = 15_000,
  http?: HttpFetch,
): Promise<TripExperienceResponse> {
  const url = new URL(
    `${apiBaseUrl.replace(/\/$/, "")}/v1/flights/trips/${encodeURIComponent(
      tripId,
    )}/experience`,
  );
  setWireQuery(url, query);
  return authedJsonGet(
    url,
    accessToken,
    TripExperienceResponseSchema,
    "GET /v1/flights/trips/:tripId/experience",
    timeoutMs,
    http,
  );
}

// --- flights: fare families + booking handoff (issue #1014) ------------------

/** One fare option (mirrors the API's clean envelope; `looseObject`
 *  keeps any extra fields so the CLI prints whatever the API sends). */
const FareOptionSchema = z.looseObject({
  fareOptionId: z.string(),
  name: z.string(),
  price: z.looseObject({
    total: z.number(),
    totalUsd: z.number(),
    currency: z.string(),
    // Printed, never branched on, so `z.string()` per the tolerance rules.
    covers: z.string().optional(),
  }),
  refundable: z.boolean(),
  exchangeable: z.boolean(),
  // The trip leg this option prices (#1254). Optional: the API omits it when the
  // upstream does not attribute the option.
  legId: z.number().optional(),
});

/** `looseObject`, unlike its siblings: a strict envelope strips new top-level keys from an installed binary. */
const FareOptionsResponseSchema = z.looseObject({
  fareId: z.string(),
  currencyCode: z.string(),
  // The whole-trip price, so a caller never reads min(options) as the trip cost.
  price: z.looseObject({ total: z.number(), currency: z.string() }).optional(),
  legs: z.array(z.looseObject({ legId: z.number() })).optional(),
  options: z.array(FareOptionSchema),
});

export type FareOptionsResponse = z.infer<typeof FareOptionsResponseSchema>;

// `expires` is `z.boolean()`, not `z.literal(true)`: the CLI prints it and never
// branches on it, so a closed set here would reject the whole response over one
// value (D3, `docs/wire-contract.md`). `.optional()` for the same reason one step
// further out — a REQUIRED field dies on absence, and an `apps/api` rollback (it
// deploys independently of a CLI release) would take `booking-link` down whole
// rather than printing the URL it still has.
const BookingLinkResponseSchema = z.object({
  bookingUrl: z.string(),
  expires: z.boolean().optional(),
});

export type BookingLinkResponse = z.infer<typeof BookingLinkResponseSchema>;

// `expires` is `.optional()` here for only the FIRST of the two reasons above:
// the CLI prints it and never branches on it, so absence must not fail the whole
// command. The rollback argument does NOT apply — `search-link` ships in this PR,
// so there is no older API to roll back to; an API that predates it 404s the
// route rather than dropping the field.
const SearchLinkResponseSchema = z.object({
  searchUrl: z.string(),
  expires: z.boolean().optional(),
});

export type SearchLinkResponse = z.infer<typeof SearchLinkResponseSchema>;

/** `GET /v1/flights/fares/:fareId/options` — the fare options for one
 *  Book-on-Wego fare. `currency`/`locale` ride through to the upstream compare.
 *
 *  25s, not the usual 10s, for the same reason `fetchHotelReviews` uses it: the
 *  API runs TWO serial upstream calls here — the compare, then the terms read
 *  that fills `termsUrls` (#1326 Q3), keyed on the ids the compare just minted —
 *  and each leg has its own 10s server-side budget. A 10s deadline here expires
 *  inside the second leg and reports the API unreachable, discarding a response
 *  that was about to arrive with every field a caller actually needs. The client
 *  budget must sit outside the server's, never on top of it. */
export function fetchFareOptions(
  apiBaseUrl: string,
  accessToken: string,
  fareId: string,
  params: { currency?: string; locale?: string } = {},
  timeoutMs = 25_000,
  http?: HttpFetch,
): Promise<FareOptionsResponse> {
  const base = apiBaseUrl.replace(/\/$/, "");
  const url = new URL(
    `${base}/v1/flights/fares/${encodeURIComponent(fareId)}/options`,
  );
  const set = wireSetter<"getFareOptions">(url);
  if (params.currency) set("currency", params.currency);
  if (params.locale) set("locale", params.locale);
  return authedJsonGet(
    url,
    accessToken,
    FareOptionsResponseSchema,
    "GET /v1/flights/fares/:fareId/options",
    timeoutMs,
    http,
  );
}

/** The booking-link context the caller passes back (the agent already holds
 *  every value from `wego flights search`/`trip`). */
export interface BookingLinkParams {
  tripId: string;
  searchId?: string;
  // Optional at the API layer, but the `booking-link` command requires it: a
  // Book-on-Wego link without a fare option dead-ends at "Fare is no longer
  // available" (wego.com has no default-fare fallback). See parseBookingLinkArgs.
  fareOptionId: string;
  from: string;
  to: string;
  fromCity?: boolean;
  toCity?: boolean;
  fromDate: string;
  toDate?: string;
  cabin?: string;
  adults?: number;
  children?: number;
  infants?: number;
  siteCode?: string;
  currency?: string;
  locale?: string;
}

/** The `search-link` context — `BookingLinkParams` minus every search-scoped id.
 *  Nothing here comes from a funnel response; it is all the caller's own search
 *  inputs, which is why the URL it builds does not expire (#1326 Q5). Derived
 *  rather than restated so a field added to one link route cannot be forgotten on
 *  the other. */
export type SearchLinkParams = Omit<
  BookingLinkParams,
  "tripId" | "searchId" | "fareOptionId"
>;

/** Write the link context both routes publish under identical names onto the URL.
 *  One writer, so a pax/currency/flag change lands on both routes or neither.
 *  Typed against `search-link`'s query — exactly the shared key set — which
 *  `booking-link`'s wider setter satisfies. Callers that also carry ids set those
 *  FIRST, keeping each route's published parameter order unchanged. */
function applyFlightLinkQuery(
  q: (key: WireQuery<"getFlightSearchLink">, value: string) => void,
  params: SearchLinkParams,
): void {
  q("from", params.from);
  q("to", params.to);
  if (params.fromCity) q("fromCity", "true");
  if (params.toCity) q("toCity", "true");
  q("fromDate", params.fromDate);
  if (params.toDate) q("toDate", params.toDate);
  if (params.cabin) q("cabin", params.cabin);
  if (params.adults !== undefined) q("adults", String(params.adults));
  if (params.children !== undefined) q("children", String(params.children));
  if (params.infants !== undefined) q("infants", String(params.infants));
  if (params.siteCode) q("siteCode", params.siteCode);
  if (params.currency) q("currency", params.currency);
  if (params.locale) q("locale", params.locale);
}

/** `GET /v1/flights/fares/:fareId/booking-link` — the wego.com booking deep-link
 *  with the chosen fare pre-selected. The API builds it statelessly (no upstream
 *  call); the CLI just forwards the caller-held context as query params. */
export function fetchBookingLink(
  apiBaseUrl: string,
  accessToken: string,
  fareId: string,
  params: BookingLinkParams,
  timeoutMs = 10_000,
  http?: HttpFetch,
): Promise<BookingLinkResponse> {
  const base = apiBaseUrl.replace(/\/$/, "");
  const url = new URL(
    `${base}/v1/flights/fares/${encodeURIComponent(fareId)}/booking-link`,
  );
  const q = wireSetter<"getFareBookingLink">(url);
  q("tripId", params.tripId);
  if (params.searchId) q("searchId", params.searchId);
  q("fareOptionId", params.fareOptionId);
  applyFlightLinkQuery(q, params);
  return authedJsonGet(
    url,
    accessToken,
    BookingLinkResponseSchema,
    "GET /v1/flights/fares/:fareId/booking-link",
    timeoutMs,
    http,
  );
}

/** `GET /v1/flights/search-link` — a durable wego.com search URL to hand to
 *  someone else. Built statelessly (no upstream call, no search created). */
export function fetchSearchLink(
  apiBaseUrl: string,
  accessToken: string,
  params: SearchLinkParams,
  timeoutMs = 10_000,
  http?: HttpFetch,
): Promise<SearchLinkResponse> {
  const base = apiBaseUrl.replace(/\/$/, "");
  const url = new URL(`${base}/v1/flights/search-link`);
  const q = wireSetter<"getFlightSearchLink">(url);
  applyFlightLinkQuery(q, params);
  return authedJsonGet(
    url,
    accessToken,
    SearchLinkResponseSchema,
    "GET /v1/flights/search-link",
    timeoutMs,
    http,
  );
}

// --- Feedback ---------------------------------------------------------------

/** The `POST /v1/feedback` body (mirrors the API's `feedbackBodySchema`). At
 *  least one of `rating`/`message` is required — enforced client-side by
 *  `parseFeedbackArgs` and server-side by the route. */
export interface FeedbackBody {
  rating?: number;
  category?: "flights" | "hotels" | "other";
  message?: string;
  /** CLI version, stamped by the command so feedback can be sliced by release. */
  version?: string;
}

/** The `202` envelope — a fire-and-forget acknowledgement. `status` is a plain
 *  string, not the documented literal: the CLI prints the envelope and branches
 *  on nothing in it, and a fire-and-forget acknowledgement is the last place a
 *  new status value should make the command fail. `looseObject` keeps any extra
 *  fields the API adds. */
const FeedbackAcceptedSchema = z.looseObject({ status: z.string() });

export type FeedbackAccepted = z.infer<typeof FeedbackAcceptedSchema>;

/** `POST /v1/feedback` — send feedback about the CLI/API experience. Returns the
 *  `202` acknowledgement; the API records it into a PostHog survey server-side. */
export function sendFeedback(
  apiBaseUrl: string,
  accessToken: string,
  body: FeedbackBody,
  timeoutMs = 10_000,
  http?: HttpFetch,
): Promise<FeedbackAccepted> {
  const url = `${apiRoot(apiBaseUrl)}/v1/feedback`;
  return authedJsonPost(
    url,
    accessToken,
    body,
    FeedbackAcceptedSchema,
    "POST /v1/feedback",
    timeoutMs,
    http,
  );
}
