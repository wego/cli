import type {
  BookingLinkResponse,
  CreateFlightSearchBody,
  CreateFlightSearchResponse,
  FareOptionsResponse,
  FeedbackAccepted,
  FeedbackBody,
  FlightCardsResult,
  FlightTrip,
  HolidaysResponse,
  HotelBookingLinkResponse,
  HotelDetailResponse,
  HotelRatesResponse,
  HotelReviewsResponse,
  HotelSearchLinkResponse,
  HotelsCreatedResponse,
  HotelsResultsResponse,
  HotelsSearchBody,
  Identity,
  NearbyPlacesResponse,
  PlacesResponse,
  SchedulesResponse,
  SearchLinkResponse,
  TripExperienceResponse,
  VisaFreeResponse,
} from "./api";
import type {
  Body,
  Op,
  QueryParams,
  RequestBody,
  Responses,
  WireQuery,
} from "./api-wire";

/**
 * The compile-time half of the api↔cli contract chain (#1300 links 5 and 7).
 *
 * `api-types.d.ts` is generated from `apps/api/contract/openapi.json`, so this
 * file compares the API's **published** shapes against the CLI's **own** Zod
 * output types. Both sides are derived: the API side from the committed
 * contract, the CLI side from `z.infer`. Nothing here is a hand-written list of
 * fields, which is the whole point — a hand-written list drifts, and the drift
 * is invisible.
 *
 * Two directions, deliberately asymmetric:
 *
 * - **Inbound (Check A) is a subtype question.** The CLI is a tolerant reader:
 *   it must PARSE everything the API can return, and it is free to parse more.
 *   Only the compiler can answer that, so Check A stays type-level.
 * - **Outbound (Check C) is exactness.** The CLI is *sending*, so it has no
 *   compatibility reason to be loose, and the API validates and rejects. A
 *   request field the API does not declare is a `400` waiting to happen.
 *
 * Check B — "is the dotted path the CLI's *behaviour* depends on still
 * published?" — is deliberately NOT here. It lives in `api-contract.test.ts` as
 * a runtime walk of the artifact. A type-level version of it was built once, on
 * an earlier attempt at this chain, and it silently PASSED for a path that did
 * not exist (it widened on an array-bearing body). A check that can pass
 * vacuously is worse than no check, so that form is not repeated.
 *
 * ## Two TypeScript traps this file is built around
 *
 * 1. **A bare `A extends B` distributes over a union**, resolving to
 *    `true | "<error message>"`, which `= true` satisfies — so the assertion
 *    passes while the constraint is violated. Reproduced directly: with
 *    `type ApiBody = {searchId: string} | {tripId: string}` and
 *    `CliParsed = {searchId: string}`, `A extends B ? true : "MISMATCH"` accepts
 *    `= true` and `[A] extends [B] ? …` correctly rejects it.
 *
 *    Every conditional here wraps both sides in tuples. Note *why* that is belt
 *    and braces rather than the only defense: distribution needs a naked type
 *    PARAMETER on the left, and the left side here is always `Body<O, S>` — a
 *    deferred conditional, which does not distribute. The wrap is what keeps that
 *    true if someone later hoists the body into a type parameter, which is
 *    exactly the refactor that would silently re-open the hole.
 * 2. **`never` swallows everything.** `[A] extends [B]` is true whenever `A` is
 *    `never`, so a renamed operation, a dropped status or a vanished
 *    discriminator makes every downstream assertion pass VACUOUSLY. Every check
 *    below therefore asks `[X] extends [never]` FIRST and fails loudly.
 *
 *    Note the direction. `[never] extends [X]` is the TAUTOLOGY, not the test:
 *    `never` is assignable to everything, so written that way the guard fires on
 *    every healthy operation and reports a vacuity that is not there. It is an
 *    easy line to write backwards — this file was, once, and only running the
 *    check caught it.
 */

// ---------------------------------------------------------------------------
// Check A — everything the API can return, the CLI parses.
// ---------------------------------------------------------------------------

/**
 * `true` when the published body is a subtype of what the CLI's schema yields.
 * Anything else resolves to an English sentence, which is what `tsc` prints:
 * `Type 'true' is not assignable to type 'Check A: getHotelRates — …'`.
 */
type ApiParses<O extends Op, S extends keyof Responses<O>, Cli> = [
  Body<O, S>,
] extends [never]
  ? `Check A: ${O} ${S & (string | number)} – the published body resolved to never, so this assertion proves nothing. The operation or status no longer exists in apps/api/contract/openapi.json.`
  : [Body<O, S>] extends [Cli]
    ? true
    : `Check A: ${O} ${S & (string | number)} – the API can return a body the CLI's zod schema does not parse. The CLI is a tolerant reader, so the fix is normally to widen the schema in api.ts; if instead the API dropped a field the CLI needs, that is the bug.`;

/**
 * The same, for one variant of a `?view=`-discriminated response. The CLI SENDS
 * the view, so it can only receive the variant it asked for — asserting it
 * parses a variant it never requests would force it to carry a mirror schema
 * for a shape it cannot see.
 *
 * `Witness` selects the variant structurally, by a property only that variant
 * has. That is what keeps this honest: rename the witness field upstream and
 * `Extract` yields `never`, which the first arm reports — it does not quietly
 * select the wrong variant or pass.
 */
type ApiParsesVariant<
  O extends Op,
  S extends keyof Responses<O>,
  Witness,
  Cli,
> = [Extract<Body<O, S>, Witness>] extends [never]
  ? `Check A: ${O} ${S & (string | number)} – no published response variant matches the witness property this entry selects on. The variant was renamed or removed; every field assertion for it would pass vacuously.`
  : [Extract<Body<O, S>, Witness>] extends [Cli]
    ? true
    : `Check A: ${O} ${S & (string | number)} – the variant the CLI requests carries a shape its zod schema does not parse. Widen the schema in api.ts.`;

const _parsesWhoami: ApiParses<"getCurrentUser", 200, Identity> = true;
const _parsesPlaces: ApiParses<"getPlaces", 200, PlacesResponse> = true;
const _parsesFeedback: ApiParses<"submitFeedback", 202, FeedbackAccepted> =
  true;
const _parsesFlightCreate: ApiParses<
  "createFlightSearch",
  201,
  CreateFlightSearchResponse
> = true;
// The results read publishes ONE shape since #1308 (the card projection), so the
// whole published body is asserted — no witness needed.
const _parsesFlightCards: ApiParses<
  "getFlightSearchResults",
  200,
  FlightCardsResult
> = true;
// `flights trip` reaches BOTH published variants since it gained `--view`, so both
// are asserted — the entry the previous comment here promised. The witnesses are
// what separates them: the default carries `outbound`, the `?view=detail` variant
// carries `legs` instead. One `ApiParses` over the whole published 200 would not
// do: the two are alternative shapes, not one shape with optional fields, so a
// single entry would demand a CLI schema that parses their union AS A WHOLE and
// pass vacuously the moment either variant was renamed.
const _parsesFlightTrip: ApiParsesVariant<
  "getFlightTrip",
  200,
  { outbound: unknown },
  FlightTrip
> = true;
const _parsesFlightTripDetail: ApiParsesVariant<
  "getFlightTrip",
  200,
  { legs: unknown },
  FlightTrip
> = true;
const _parsesFareOptions: ApiParses<
  "getFareOptions",
  200,
  FareOptionsResponse
> = true;
const _parsesFareBookingLink: ApiParses<
  "getFareBookingLink",
  200,
  BookingLinkResponse
> = true;
const _parsesFlightSearchLink: ApiParses<
  "getFlightSearchLink",
  200,
  SearchLinkResponse
> = true;
const _parsesHotelCreate: ApiParses<
  "createHotelSearch",
  201,
  HotelsCreatedResponse
> = true;
// Hotels' results read publishes one shape too (#1308), and the CLI's schema is
// shape-agnostic anyway, so the whole published body is asserted.
const _parsesHotelResults: ApiParses<
  "getHotelSearchResults",
  200,
  HotelsResultsResponse
> = true;
const _parsesHotelRates: ApiParses<"getHotelRates", 200, HotelRatesResponse> =
  true;
const _parsesHotel: ApiParses<"getHotel", 200, HotelDetailResponse> = true;
const _parsesHotelReviews: ApiParses<
  "getHotelReviews",
  200,
  HotelReviewsResponse
> = true;
const _parsesHotelBookingLink: ApiParses<
  "getHotelRateBookingLink",
  200,
  HotelBookingLinkResponse
> = true;
const _parsesHotelSearchLink: ApiParses<
  "getHotelSearchLink",
  200,
  HotelSearchLinkResponse
> = true;
// The `wego info` group (issue #1326). None is `?view=`-discriminated, so each
// asserts the whole published body.
const _parsesHolidays: ApiParses<"getCountryHolidays", 200, HolidaysResponse> =
  true;
const _parsesVisaFree: ApiParses<
  "getVisaFreeDestinations",
  200,
  VisaFreeResponse
> = true;
const _parsesSchedules: ApiParses<
  "getFlightSchedules",
  200,
  SchedulesResponse
> = true;
const _parsesNearbyPlaces: ApiParses<
  "getNearbyPlaces",
  200,
  NearbyPlacesResponse
> = true;

// ---------------------------------------------------------------------------
// Check C — the CLI's requests match what the API accepts (#1300 D1).
// ---------------------------------------------------------------------------

/**
 * `true` when the CLI's request-body type sends only fields the API declares,
 * with compatible types, and declares every field the API requires.
 *
 * The `keyof` arm is the one that earns its place: plain assignability lets an
 * extra property through when the API's own field is optional, so a param
 * renamed from `fromDate` to `departDate` (both optional) would slip past
 * `[Cli] extends [Api]` alone.
 */
type Sends<O extends Op, Cli> = [RequestBody<O>] extends [never]
  ? `Check C: ${O} – the contract declares no application/json request body, so this assertion proves nothing.`
  : [keyof Cli] extends [keyof RequestBody<O>]
    ? [Cli] extends [RequestBody<O>]
      ? true
      : `Check C: ${O} – the CLI's request body type is not assignable to the body the API accepts: a field's type differs, or the CLI omits a field the API requires.`
    : `Check C: ${O} – the CLI sends a body field the API does not declare. The field was renamed or removed on the API side; sending it now is a 400 the CLI cannot see coming.`;

const _sendsFlightCreate: Sends<"createFlightSearch", CreateFlightSearchBody> =
  true;
const _sendsHotelCreate: Sends<"createHotelSearch", HotelsSearchBody> = true;
const _sendsFeedback: Sends<"submitFeedback", FeedbackBody> = true;

/**
 * Guard for `WireQuery` (defined in `api-wire.ts`). `keyof never` widens to
 * `string`, so an operation whose query object vanished would accept EVERY key
 * silently — the exact vacuity this chain exists to prevent. One entry per
 * operation whose keys are bound in `api.ts` / `commands.ts`.
 */
type HasQueryParams<O extends Op> = [QueryParams<O>] extends [never]
  ? `Check C: ${O} – the contract declares no query parameters, so WireQuery<"${O}"> accepts any string and binds nothing.`
  : [string] extends [WireQuery<O>]
    ? `Check C: ${O} – WireQuery degenerated to \`string\`, so every key literal would pass. The operation's query object is missing from the contract.`
    : true;

const _hasQueryPlaces: HasQueryParams<"getPlaces"> = true;
const _hasQueryFlightResults: HasQueryParams<"getFlightSearchResults"> = true;
const _hasQueryFlightTrip: HasQueryParams<"getFlightTrip"> = true;
const _hasQueryFareOptions: HasQueryParams<"getFareOptions"> = true;
const _hasQueryFareBookingLink: HasQueryParams<"getFareBookingLink"> = true;
const _hasQueryFlightSearchLink: HasQueryParams<"getFlightSearchLink"> = true;
const _hasQueryHotelResults: HasQueryParams<"getHotelSearchResults"> = true;
const _hasQueryHotelRates: HasQueryParams<"getHotelRates"> = true;
const _hasQueryHotel: HasQueryParams<"getHotel"> = true;
const _hasQueryHotelReviews: HasQueryParams<"getHotelReviews"> = true;
const _hasQueryHotelBookingLink: HasQueryParams<"getHotelRateBookingLink"> = true;
const _hasQueryHotelSearchLink: HasQueryParams<"getHotelSearchLink"> = true;
const _hasQueryHolidays: HasQueryParams<"getCountryHolidays"> = true;
const _hasQueryVisaFree: HasQueryParams<"getVisaFreeDestinations"> = true;
const _hasQuerySchedules: HasQueryParams<"getFlightSchedules"> = true;
const _hasQueryNearbyPlaces: HasQueryParams<"getNearbyPlaces"> = true;

// ---------------------------------------------------------------------------
// Coverage — every published operation is classified.
// ---------------------------------------------------------------------------

/** Assert a check at the TYPE level, with no runtime statement to discard: the
 *  `const … = true` + `void` pair used above fails `tsc` on the same drift, but
 *  its discard trips `typescript:S3735` on new code. `Expect<false>` and
 *  `Expect<"Check A: …">` both fail the constraint, so the error still names the
 *  violated check. */
type Expect<T extends true> = T;
type _ParsesTripExperience = Expect<
  ApiParses<"getTripExperience", 200, TripExperienceResponse>
>;
type _HasQueryTripExperience = Expect<HasQueryParams<"getTripExperience">>;

/**
 * `Record<Op, …>` is the coverage gate: the key set comes from the generated
 * types, so a NEW API operation fails to compile here until someone decides
 * whether the CLI calls it. Without this, a new operation would simply have no
 * Check A entry and nobody would notice.
 */
export const CONTRACT_COVERAGE: Record<
  Op,
  "checked" | "not-called-by-the-cli"
> = {
  // The uptime probe. Nothing in the CLI reads `/health`; the post-deploy
  // verifier in apps/api does.
  getHealth: "not-called-by-the-cli",
  getCurrentUser: "checked",
  getPlaces: "checked",
  // The `wego info` group.
  getNearbyPlaces: "checked",
  getCountryHolidays: "checked",
  getVisaFreeDestinations: "checked",
  getFlightSchedules: "checked",
  submitFeedback: "checked",
  createFlightSearch: "checked",
  getFlightSearchResults: "checked",
  getFlightTrip: "checked",
  getTripExperience: "checked",
  getFareOptions: "checked",
  getFareBookingLink: "checked",
  getFlightSearchLink: "checked",
  createHotelSearch: "checked",
  getHotelSearchResults: "checked",
  getHotelRates: "checked",
  getHotel: "checked",
  getHotelReviews: "checked",
  getHotelRateBookingLink: "checked",
  getHotelSearchLink: "checked",
};

// Assertions are declarations, not statements: `void` them so `noUnusedLocals`
// stays happy without weakening anything.
void _parsesWhoami;
void _parsesPlaces;
void _parsesFeedback;
void _parsesFlightCreate;
void _parsesFlightCards;
void _parsesFlightTrip;
void _parsesFlightTripDetail;
void _parsesFareOptions;
void _parsesFareBookingLink;
void _parsesFlightSearchLink;
void _parsesHotelCreate;
void _parsesHotelResults;
void _parsesHotelRates;
void _parsesHotel;
void _parsesHotelReviews;
void _parsesHotelBookingLink;
void _parsesHotelSearchLink;
void _parsesHolidays;
void _parsesVisaFree;
void _parsesSchedules;
void _parsesNearbyPlaces;
void _sendsFlightCreate;
void _sendsHotelCreate;
void _sendsFeedback;
void _hasQueryPlaces;
void _hasQueryFlightResults;
void _hasQueryFlightTrip;
void _hasQueryFareOptions;
void _hasQueryFareBookingLink;
void _hasQueryFlightSearchLink;
void _hasQueryHotelResults;
void _hasQueryHotelRates;
void _hasQueryHotel;
void _hasQueryHotelReviews;
void _hasQueryHotelBookingLink;
void _hasQueryHotelSearchLink;
void _hasQueryHolidays;
void _hasQueryVisaFree;
void _hasQuerySchedules;
void _hasQueryNearbyPlaces;
