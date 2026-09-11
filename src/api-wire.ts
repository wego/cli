import type { components, operations } from "./api-types";

/**
 * The API's published contract, as types — the shared vocabulary for
 * `api-contract.ts` (which asserts over it) and `api.ts` / `commands.ts` (which
 * are annotated with it, so a renamed field is a compile error at the literal
 * that names it).
 *
 * Everything here derives from the generated `operations`, which derives from
 * `apps/api/contract/openapi.json`. Nothing is hand-written, and nothing is
 * imported at runtime — these are erased.
 */

export type Op = keyof operations;

export type Responses<O extends Op> = operations[O]["responses"];

/** The JSON body the contract publishes for one operation + status. */
export type Body<
  O extends Op,
  S extends keyof Responses<O>,
> = Responses<O>[S] extends {
  content: { "application/json": infer B };
}
  ? B
  : never;

/** The JSON request body the contract accepts for one operation. */
export type RequestBody<O extends Op> = operations[O] extends {
  requestBody: { content: { "application/json": infer B } };
}
  ? B
  : never;

/** The query-parameter object the contract declares for one operation. */
export type QueryParams<O extends Op> = operations[O]["parameters"] extends {
  query?: infer Q;
}
  ? NonNullable<Q>
  : never;

/**
 * The **wire names** of one operation's query parameters. Annotate every place
 * that writes a query key with this and a renamed parameter fails to compile at
 * the string literal, instead of surfacing as a `400` a user hits.
 *
 * Guarded by `HasQueryParams` in `api-contract.ts`: `keyof never` widens to
 * `string`, so an operation whose query object vanished would otherwise accept
 * every key silently.
 */
export type WireQuery<O extends Op> = keyof QueryParams<O> & string;

/**
 * The API's **closed** machine error codes, off the published `Problem`
 * envelope — the token the exit-code taxonomy branches on
 * (`src/error-report.ts`). Derived, not copied: the switch it feeds once named
 * `unauthorized` / `forbidden`, which this API has never emitted, so the
 * "prefer the machine code" arm was partly dead and correctness rode on the
 * status fallback alone. A code added or renamed in `apps/api` now fails
 * `typecheck` at the mapping instead.
 */
export type ProblemCode = components["schemas"]["Problem"]["code"];

/** The cabin classes the API accepts. The CLI validates `--cabin` client-side
 *  (exit 2 rather than the API's 400), and this is what keeps that guard a
 *  provable subset of the API's own set rather than a copy of it. */
export type FlightCabin = NonNullable<
  RequestBody<"createFlightSearch">["cabin"]
>;
