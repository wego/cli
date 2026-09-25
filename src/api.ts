import { release } from "node:os";
import { z } from "zod";
import type { FlightCabin, Op, WireQuery } from "./api-wire";
import { formatZodError } from "./zod-error";

/** A tolerant non-negative-integer count field. Absent or malformed (fractional,
 *  negative, non-numeric, null) degrades to `undefined` (indeterminate) rather
 *  than being trusted as a count or failing the whole read. The `.optional()` is
 *  required: it widens the type to `number | undefined` so `.catch(undefined)`
 *  typechecks. Shared by every settle and completed-empty count field on both
 *  verticals so the tolerant shape cannot drift between flights and hotels. */
const tolerantCount = z
  .number()
  .int()
  .nonnegative()
  .optional()
  .catch(undefined);

/**
 * Calls to the `apps/api` resource server. Each sends the access token as a
 * Bearer credential, carries a per-request deadline, raises `UnauthorizedError`
 * on a 401 (so the command can refresh and retry), and Zod-validates the
 * response body.
 *
 * ## Response schemas are tolerant, in shape and in value
 *
 * The CLI is an installed binary that cannot be redeployed alongside
 * `apps/api`, so a response schema here is a reader, never a mirror.
 * `looseObject` and `tolerantCount` make it tolerant in shape; these rules make
 * it tolerant in value, which matters more: a `z.enum` is a closed set, so when
 * the API adds a member zod rejects the value, which rejects the whole
 * response, not just the field.
 *
 * - A field a command branches on MAY be `z.enum` / `z.literal`.
 * - A field the CLI only prints or forwards MUST NOT be a widenable closed set.
 *   For anything the API models as a string that means `z.string()`, even for a
 *   value the API documents as a literal: the API can redeploy, an installed
 *   binary cannot. `z.boolean()` is fine, since both of its values are already
 *   in the domain (`expires`, on all four link routes). Narrowing a boolean to
 *   `z.literal(true)` would be a closed set and is banned like any other.
 * - A response schema MUST NOT carry a cross-field `.refine()`. No type can see
 *   a predicate, so Check A never reports one and neither does any other gate.
 *   Pairing invariants belong in `apps/api`, where a mistake is fixed by a
 *   redeploy.
 * - Adding a closed set MUST come with the branch that justifies it, in the
 *   same change.
 *
 * Enforced by `api-tolerance.test.ts`, which walks these schemas and fails on a
 * closed set or a `.refine` it was not told about.
 *
 * ## The contract checks
 *
 * `api-contract.ts` holds the compile-time checks against the API's published
 * contract: Check A (everything the API can return, the CLI parses) and Check C
 * (the CLI's requests match what the API accepts). Check B (the fields the
 * CLI's behaviour depends on are still published) is in
 * `api-contract.test.ts`.
 */

/** `sub` is guaranteed; the AS may include further allowlisted claims, which
 *  `looseObject` keeps. */
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
 *  "search expired", "unknown hotel") instead of a raw HTTP error. */
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

export interface ApiHttpErrorFields {
  code?: string;
  detail?: string;
  traceId?: string;
  retryAfterSeconds?: number;
  bodyParseError?: boolean;
}

/**
 * A structured HTTP failure from `apps/api`. The API sends an RFC 9457
 * `application/problem+json` body (machine `code`, human `detail`, `trace_id`),
 * an `x-trace-id` header, and `Retry-After` on 429/503. This error captures all
 * of it so the CLI can print an actionable message and pick a stable exit code
 * (`error-report.ts`). Its `message` keeps the `"<label> failed: <status>"`
 * prefix that callers and tests match on.
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

/** The API's retryable problem classes: `rate_limited` (429) and
 *  `upstream_unavailable` (503). A `bad_gateway` (502) is treated as permanent,
 *  matching the exit-code mapping. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 503;
}

/** Integer seconds only (the delta-seconds form the API uses); an HTTP-date or
 *  anything else yields `undefined`. */
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

/** Best-effort parse of the RFC 9457 `problem+json` body. A malformed JSON body
 *  is flagged so it stays diagnosable. An empty body under a JSON content-type
 *  (common on a bare 429/503, where the proxy sets the header but sends no
 *  payload) is not flagged: there is nothing to parse. */
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

/** The `x-trace-id` header wins over a body `trace_id`; either may be absent. */
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

/** Honors `Retry-After`, capped at 60 s so a long server hint cannot stall the
 *  CLI, else a short fixed backoff. */
function retryDelayMs(retryAfterSeconds: number | undefined): number {
  if (retryAfterSeconds != null) return Math.min(retryAfterSeconds, 60) * 1000;
  return 500;
}

/**
 * Thrown when the request never reached `apps/api` (a DNS, connect or network
 * failure, or the per-request deadline firing), as opposed to an HTTP status.
 * Distinct so the command layer can print an actionable hint instead of Bun's
 * raw "Unable to connect" fetch message.
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

/** Read by `apps/api` off each request. Both are uuids or absent; the API logs
 *  a warning for anything else. */
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

export type HttpFetch = (
  url: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Maps any thrown error (connection refused, DNS failure, TLS error, or the
 * `AbortSignal.timeout` deadline) to `ApiUnreachableError`. A `fetch` that
 * resolves, even to a 4xx/5xx, is returned as is.
 */
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
 * The shared authenticated GET. The per-request deadline keeps a hung `apps/api`
 * from hanging the CLI forever. Keeping this in one place means the 401-refresh
 * contract `withAccessToken` relies on cannot drift between commands.
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
  // honoring Retry-After.
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
 * The POST counterpart of `authedJsonGet`, with the same Bearer, deadline and
 * 401-refresh contract. It raises no `NotFoundError` because a create has no
 * not-found case.
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
    // No auto-retry on POST: a create is not idempotent and the API has no
    // Idempotency-Key support, so a blind retry could create a duplicate
    // upstream search.
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

/** `looseObject` keeps any extra fields the API returns so the CLI prints them
 *  without dropping columns. */
const PlaceSchema = z.looseObject({
  name: z.string(),
  type: z.string(),
});

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
  // Every key below is typed `WireQuery<"getPlaces">`, so a parameter renamed on
  // the API side fails to compile at the literal instead of returning a 400.
  const set = wireSetter<"getPlaces">(url);
  set("query", params.query);
  // Repeated `types` params (the API's array query parsing) need `append`, which
  // `set` cannot express. Binding the key through `WireQuery` first keeps this
  // literal contract-checked too.
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
// `wego info`: the four stateless reference reads
// ---------------------------------------------------------------------------

/**
 * These four need no prior search, carry no expiring id, and are safe to call in
 * any order, which is why they are one CLI group. Every schema below follows the
 * tolerance rules in this module's header: `looseObject` so a field the API adds
 * still prints, and `z.string()` for every field, since the CLI only forwards or
 * displays them. `window` and `coverage` are closed sets in the API docs but not
 * here: the agent branches on them, the CLI does not.
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
    // `z.string()`, not the two-value enum the API documents: the CLI only
    // prints this (see the closed-set rule in the module header).
    window: z.string(),
    from: z.string(),
    to: z.string(),
  }),
});

export type HolidaysResponse = z.infer<typeof HolidaysResponseSchema>;

/** The CLI flags are `--from`/`--to` (unambiguous on a command whose only
 *  arguments are dates); the wire params are `fromDate`/`toDate`, because
 *  `from`/`to` already mean place codes on the flights operations. */
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
  // It must sit above the API's own walk budget (`WALK_BUDGET_MS`, 25 s in
  // `apps/api/src/countries/visa-free.ts`). Otherwise the client gives up first,
  // shows the unreachable-API hint for what is a slow upstream, and discards the
  // partial list (`coverage: "truncated"`) the API was about to return.
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
    // Printed and forwarded only, so `z.string()` per the tolerance rules, even
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
  // The API publishes the same row shape as the plain places read, so the same
  // reader is used and a caller can move a row between the two unchanged.
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
  // Repeated `types` params, bound through `WireQuery` first so this key is
  // contract-checked too.
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
// Hotels
// ---------------------------------------------------------------------------

/** The occupancy the API priced upstream, echoed on create so the resolved
 *  child ages (the supplied list, or the age-8 fallback the API applies when
 *  none were given) are auditable client-side. */
const pricedOccupancySchema = z.object({
  adults: z.number().int(),
  childrenAges: z.array(z.number().int()),
  rooms: z.number().int(),
});

export type PricedOccupancy = z.infer<typeof pricedOccupancySchema>;

const HotelsCreatedSchema = z.object({
  searchId: z.string(),
  // Optional so the CLI still parses an older API's response.
  occupancy: pricedOccupancySchema.optional(),
  // The market the API resolved for this search. The CLI reports its own
  // source instead of the API's (it can be `account` when the CLI derived the
  // site from the id_token). Optional so the CLI still parses an older API's
  // response.
  siteCode: z.string().optional(),
  // `z.string()`, not `z.enum([...])`: see the closed-set rule in the module
  // header. The CLI only prints it.
  siteCodeSource: z.string().optional(),
});
const HotelsResultsSchema = z.looseObject({
  searchComplete: z.boolean().optional(),
  metadata: z
    .looseObject({
      // Distinguishes a genuinely empty completed search (0) from an empty page
      // paged past the last (> 0); see `hotelEmptyNote` in `verticals.ts`.
      totalCandidates: tolerantCount,
      // The upstream aggregation counter. It stabilizes about 3x sooner than
      // `searchComplete` flips, so the settle converges on it, as flights does
      // on `snapshotFareCount`. An indeterminate count makes the settle fall
      // back to item-presence.
      snapshotCandidateCount: tolerantCount,
      // Candidates before this read's filters, which make a zero authoritative.
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
// `expires` is treated as on the flights booking-link below: `z.boolean()`, not
// a literal, because the CLI only prints it (see the closed-set rule in the
// module header), and `.optional()` because it was added to an already-live
// route, so an `apps/api` rollback (it deploys independently of the CLI) must
// not take the whole command down over the missing field.
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
/** Exported (with the three below) so `api-contract.ts` can compare it against
 *  the published contract. */
export type HotelsCreatedResponse = z.infer<typeof HotelsCreatedSchema>;
export type HotelDetailResponse = z.infer<typeof HotelDetailResponseSchema>;
export type HotelBookingLinkResponse = z.infer<typeof HotelBookingLinkSchema>;
export type HotelSearchLinkResponse = z.infer<typeof HotelSearchLinkSchema>;
export type HotelReviewsResponse = z.infer<typeof HotelReviewsResponseSchema>;

/** Exactly one location field is set by the caller. */
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
 * A `searchParams.set` whose key is constrained to the query parameters one
 * operation publishes (Check C). The API validates and rejects, so a parameter
 * renamed upstream should break the build rather than a user's command.
 */
function wireSetter<O extends Op>(
  url: URL,
): (key: WireQuery<O>, value: string) => void {
  return (key, value) => {
    url.searchParams.set(key, value);
  };
}

/**
 * A query object for a forwarded-verbatim read, keyed by the operation's
 * published parameter names so `commands.ts` (which owns the flag-to-param
 * tables) is bound to the contract too.
 */
export type WireQueryValues<O extends Op> = Partial<
  Record<WireQuery<O>, string>
>;

/** `undefined` values are skipped so an unset optional key does not become
 *  `?key=undefined`. */
function setWireQuery<O extends Op>(url: URL, query: WireQueryValues<O>): void {
  // `Object.entries` over a generic mapped type loses the value type, so it is
  // re-stated here. The key constraint is enforced where the object is built.
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

/** 25 s, not the usual 10 s: on an empty page the API makes a second serial
 *  upstream call to prove the hotel exists, and each upstream leg has its own
 *  10 s budget. A 10 s deadline would abort a valid empty result or 404 and
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
// --- Flights ----------------------------------------------------------------

export interface CreateFlightSearchBody {
  from: string;
  to: string;
  fromDate: string;
  toDate?: string;
  /** Bound to the contract's own cabin set (Check C): the API rejects anything
   *  else, so there is no reason for the CLI to be loose here. */
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
  // The market the API resolved for this search. The CLI reports its own
  // source instead of the API's (it can be `account` when the CLI derived the
  // site from the id_token). Optional so the CLI still parses an older API's
  // response.
  siteCode: z.string().optional(),
  // `z.string()`, not a closed `z.enum`: see the module header's rule.
  siteCodeSource: z.string().optional(),
});

export type CreateFlightSearchResponse = z.infer<
  typeof CreateFlightSearchResponseSchema
>;

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
 * The `?view=detail` trip variant, a different shape from the default trip
 * rather than a richer one (`apps/api` `flights/schema.ts` `flightDetailSchema`):
 * it carries `legs[]` where the default carries `outbound`/`return`, and its
 * fares carry a `provider` object where the default's carry a flat
 * `providerCode`, so one schema cannot cover both. The discriminant is the
 * top-level `fares` array vs `legs` array (`providerCode` is nested inside each
 * fare): `CleanTripSchema` requires `fares`, so a detail body carrying only
 * `legs[]` fails it and falls through. This implicit discriminator is disjoint
 * today, but if `fares` were made optional, or a detail body gained a top-level
 * `fares`, the routing would flip with no type error and no failing test.
 *
 * Tolerant past the two fields that identify it: `flights trip` prints the body
 * and reads no field from it, so anything narrower would only reject bodies.
 */
const CleanTripDetailSchema = z.looseObject({
  tripId: z.string(),
  legs: z.array(z.unknown()),
});

/**
 * Both variants `getFlightTrip` publishes, in the order they are tried.
 *
 * The default is first because it is the narrower parse: a detail body fails it
 * on the missing required `fares` array and falls through, while a default body
 * has no `legs[]` for the second member to claim. Binding only one variant would
 * make the CLI fail to parse a body the API declares.
 */
const FlightTripSchema = z.union([CleanTripSchema, CleanTripDetailSchema]);

export type FlightTrip = z.infer<typeof FlightTripSchema>;

/** The results read returns lean list cards with no `fares[]`: a price summary
 *  plus per-leg summaries instead of the full trip envelope. Its `metadata`
 *  carries the `snapshotFareCount` settle signal, so `results --wait` settles on
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
  // Optional so an older API without them parses.
  stops: z.number().optional(),
  durationMinutes: z.number().optional(),
  price: z.looseObject({
    total: z.number(),
    currency: z.string(),
    // `z.string()`, not `z.literal("party")`: the CLI only prints this label, so
    // a new scope value must not fail the whole card read. See the module
    // header's closed-set rule.
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
    // (not left to the loose passthrough) so a missing or malformed value
    // degrades to `undefined` and the settle falls back to item-presence.
    snapshotFareCount: tolerantCount,
    // Pre-filter trip count; the settle guard reads this, not the page.
    snapshotTripCount: tolerantCount,
  }),
  results: z.array(FlightCardSchema),
});

export type FlightCardsResult = z.infer<typeof FlightCardsResultSchema>;
export type FlightCard = z.infer<typeof FlightCardSchema>;

/** Most keys are kebab-cased on the wire; see `fetchFlightResults`. */
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
  /** Coarse blocks for when the outbound leg lands, local to the arrival
   *  airport. Wire: `outbound-arrival-blocks`. */
  arrivalBlocks?: string[];
  /** Exact `min-max` minute-of-day window for when the outbound leg lands, local
   *  to the arrival airport. Wire: `outbound-arrival-range`. */
  arrivalRange?: string;
  /** As `departureBlocks`, for the return leg. Wire: `return-departure-blocks`. */
  returnDepartureBlocks?: string[];
  /** As `departureRange`, for the return leg. Wire: `return-departure-range`. */
  returnDepartureRange?: string;
  /** As `arrivalBlocks`, for the return leg. Wire: `return-arrival-blocks`. */
  returnArrivalBlocks?: string[];
  /** As `arrivalRange`, for the return leg. Wire: `return-arrival-range`. */
  returnArrivalRange?: string;
  /** Inclusive elapsed-duration bounds on one leg, in minutes (`maxDuration`
   *  bounds the whole trip). Wire: `outbound-min-duration` /
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
  // `page`/`pageSize` may legally be 0, so guard on `!== undefined`, not truthy.
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
  // Cards, never trips: a trip's fares come only from `fetchFlightTrip`.
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
  /** `default` | `detail`. Sent only when given, so the default read carries no
   *  `view` param. */
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

/** Forwarded verbatim: `flightsExperience` prints it and reads no field, so
 *  every member is tolerant. It is declared rather than left bare so Check A
 *  still binds the CLI to the published 200 shape. */
const TripExperienceResponseSchema = z.looseObject({
  tripId: z.string().optional(),
  legs: z.array(z.unknown()).optional(),
  metadata: z.looseObject({ legCount: tolerantCount }).optional(),
});

export type TripExperienceResponse = z.infer<
  typeof TripExperienceResponseSchema
>;

/** `searchId` is an optional cross-check, not a required context param: the
 *  tripId already carries its search segment.
 *
 *  15 s, not 10 s, as in `fetchFlightTrip`: the API's own `UPSTREAM_TIMEOUT_MS`
 *  is 10 s and starts after this deadline does, so a matching 10 s here would
 *  expire first, turning a healthy near-limit response into a client-side
 *  network failure and discarding the `503` + `Retry-After` the API would
 *  otherwise return. The client budget must sit outside the server's. */
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

// --- flights: fare families + booking handoff --------------------------------

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
  // The trip leg this option prices. Optional: the API omits it when the
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

// `expires` is `z.boolean()`, not `z.literal(true)`: the CLI only prints it, so
// a closed set would reject the whole response over one value. `.optional()`
// because a required field fails on absence, and an `apps/api` rollback (it
// deploys independently of the CLI) would take `booking-link` down entirely
// rather than printing the URL it still has.
const BookingLinkResponseSchema = z.object({
  bookingUrl: z.string(),
  expires: z.boolean().optional(),
});

export type BookingLinkResponse = z.infer<typeof BookingLinkResponseSchema>;

// `expires` is `.optional()` because the CLI only prints it, so absence must not
// fail the whole command. The rollback argument above does not apply: an API
// that predates `search-link` 404s the route rather than dropping the field.
const SearchLinkResponseSchema = z.object({
  searchUrl: z.string(),
  expires: z.boolean().optional(),
});

export type SearchLinkResponse = z.infer<typeof SearchLinkResponseSchema>;

/** The fare options for one Book-on-Wego fare.
 *
 *  25 s, not the usual 10 s, as in `fetchHotelReviews`: the API makes two serial
 *  upstream calls here (the compare, then the terms read that fills
 *  `termsUrls`, keyed on ids the compare returns), and each has its own 10 s
 *  server-side budget. A 10 s deadline would expire inside the second call and
 *  report the API unreachable, discarding a response about to arrive. */
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

/** The caller already holds every value from `wego flights search`/`trip`. */
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

/** Nothing here comes from a funnel response, only the caller's own search
 *  inputs, which is why the URL it builds does not expire. Derived rather than
 *  restated so a field added to one link route cannot be forgotten on the
 *  other. */
export type SearchLinkParams = Omit<
  BookingLinkParams,
  "tripId" | "searchId" | "fareOptionId"
>;

/** Writes the link context both routes publish under identical names. One
 *  writer, so a pax/currency/flag change lands on both routes or neither. Typed
 *  against `search-link`'s query (exactly the shared key set), which
 *  `booking-link`'s wider setter satisfies. Callers that also carry ids set
 *  those first, keeping each route's published parameter order. */
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

/** The wego.com booking deep-link with the chosen fare pre-selected. The API
 *  builds it statelessly (no upstream call). */
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

/** A durable wego.com search URL to hand to someone else. Built statelessly (no
 *  upstream call, no search created). */
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

/** At least one of `rating`/`message` is required, enforced client-side by
 *  `parseFeedbackArgs` and server-side by the route. */
export interface FeedbackBody {
  rating?: number;
  category?: "flights" | "hotels" | "other";
  message?: string;
  /** CLI version, stamped by the command so feedback can be sliced by release. */
  version?: string;
}

/** The `202` acknowledgement. `status` is a plain string, not the documented
 *  literal: the CLI only prints it, so a new status value must not make the
 *  command fail. */
const FeedbackAcceptedSchema = z.looseObject({ status: z.string() });

export type FeedbackAccepted = z.infer<typeof FeedbackAcceptedSchema>;

/** The API records feedback into a PostHog survey server-side. */
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
