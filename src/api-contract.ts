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
 * The compile-time half of the API/CLI contract checks.
 *
 * `api-types.d.ts` is generated from `contract/openapi.json`, the vendored copy
 * of the API's published document, so this file compares the API's published
 * shapes against the CLI's own Zod output types. Both sides are derived (the API
 * side from the committed contract, the CLI side from `z.infer`); a
 * hand-written list of fields would drift without anyone seeing it.
 *
 * The two directions are deliberately asymmetric:
 *
 * - Inbound (Check A) is a subtype question. The CLI is a tolerant reader: it
 *   must parse everything the API can return and may parse more. Only the
 *   compiler can answer that, so Check A stays type-level.
 * - Outbound (Check C) is exactness. The CLI has no compatibility reason to be
 *   loose in what it sends, and the API validates and rejects: a request field
 *   the API does not declare is a `400`.
 *
 * Check B (is the dotted path the CLI's behaviour depends on still published?)
 * lives in `api-contract.test.ts` as a runtime walk of the contract. A
 * type-level version passed for a path that did not exist (it widened on an
 * array-bearing body), and a check that can pass vacuously is worse than none.
 *
 * ## Two TypeScript traps this file is built around
 *
 * 1. A bare `A extends B` distributes over a union, resolving to
 *    `true | "<error message>"`, which `= true` satisfies, so the assertion
 *    passes while the constraint is violated. For example, with
 *    `type ApiBody = {searchId: string} | {tripId: string}` and
 *    `CliParsed = {searchId: string}`, `A extends B ? true : "MISMATCH"` accepts
 *    `= true` and `[A] extends [B] ? …` rejects it.
 *
 *    Every conditional here wraps both sides in tuples. Today that is extra
 *    safety rather than the only defense: distribution needs a naked type
 *    parameter on the left, and the left side here is always `Body<O, S>`, a
 *    deferred conditional that does not distribute. The wrap keeps the check
 *    correct if the body is later hoisted into a type parameter.
 * 2. `never` swallows everything. `[A] extends [B]` is true whenever `A` is
 *    `never`, so a renamed operation, a dropped status or a vanished
 *    discriminator makes every downstream assertion pass vacuously. Every check
 *    below therefore asks `[X] extends [never]` first and fails loudly.
 *
 *    Mind the direction: `[never] extends [X]` is a tautology, since `never` is
 *    assignable to everything, so written that way the guard fires on every
 *    healthy operation. It is easy to write backwards.
 */

// ---------------------------------------------------------------------------
// Check A: everything the API can return, the CLI parses.
// ---------------------------------------------------------------------------

/**
 * `true` when the published body is a subtype of what the CLI's schema yields.
 * Anything else resolves to an English sentence, which is what `tsc` prints:
 * `Type 'true' is not assignable to type 'Check A: getHotelRates 200 – …'`.
 */
type ApiParses<O extends Op, S extends keyof Responses<O>, Cli> = [
  Body<O, S>,
] extends [never]
  ? `Check A: ${O} ${S & (string | number)} – the published body resolved to never, so this assertion proves nothing. The operation or status no longer exists in contract/openapi.json.`
  : [Body<O, S>] extends [Cli]
    ? true
    : `Check A: ${O} ${S & (string | number)} – the API can return a body the CLI's zod schema does not parse. The CLI is a tolerant reader, so the fix is normally to widen the schema in api.ts; if instead the API dropped a field the CLI needs, that is the bug.`;

/**
 * The same, for one variant of a `?view=`-discriminated response. The CLI sends
 * the view, so it only receives the variant it asked for; asserting it parses a
 * variant it never requests would force a schema for a shape it never sees.
 *
 * `Witness` selects the variant by a property only that variant has. If the
 * witness field is renamed upstream, `Extract` yields `never`, which the first
 * arm reports, rather than selecting the wrong variant or passing.
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
// The results read publishes one shape (the card projection), so the whole
// published body is asserted.
const _parsesFlightCards: ApiParses<
  "getFlightSearchResults",
  200,
  FlightCardsResult
> = true;
// `flights trip --view` reaches both published variants, so both are asserted.
// The default carries `outbound`, the `?view=detail` variant carries `legs`. A
// single `ApiParses` over the whole 200 would not do: the two are alternative
// shapes, so it would demand a schema that parses their union as a whole and
// would pass vacuously if either variant were renamed.
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
// Hotels' results read publishes one shape too, and the CLI's schema is
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
// The `wego info` group. None is `?view=`-discriminated, so each asserts the
// whole published body.
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
// Check C: the CLI's requests match what the API accepts.
// ---------------------------------------------------------------------------

/**
 * `true` when the CLI's request-body type sends only fields the API declares,
 * with compatible types, and declares every field the API requires.
 *
 * The `keyof` arm is needed because plain assignability lets an extra property
 * through when the API's own field is optional: a param renamed from `fromDate`
 * to `departDate` (both optional) would slip past `[Cli] extends [Api]` alone.
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
 * Guard for `WireQuery` (in `api-wire.ts`). `keyof never` widens to `string`,
 * so an operation whose query object vanished would accept every key silently.
 * One entry per operation whose keys are bound in `api.ts` / `commands.ts`.
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
// Coverage: every published operation is classified.
// ---------------------------------------------------------------------------

/** Asserts a check purely at the type level. The `const … = true` + `void` pair
 *  used above catches the same drift, but its `void` discard trips
 *  `typescript:S3735` on new code. `Expect<"Check A: …">` fails the constraint,
 *  so the error still names the violated check. */
type Expect<T extends true> = T;
type _ParsesTripExperience = Expect<
  ApiParses<"getTripExperience", 200, TripExperienceResponse>
>;
type _HasQueryTripExperience = Expect<HasQueryParams<"getTripExperience">>;

/**
 * The key set comes from the generated types, so a new API operation fails to
 * compile here until someone decides whether the CLI calls it. Otherwise it
 * would have no Check A entry and nobody would notice.
 */
export const CONTRACT_COVERAGE: Record<
  Op,
  "checked" | "not-called-by-the-cli"
> = {
  // The uptime probe. Nothing in the CLI reads `/health`; the post-deploy
  // verifier on the API side does.
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

// `void` the assertions so `noUnusedLocals` accepts them.
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
