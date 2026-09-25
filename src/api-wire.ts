import type { components, operations } from "./api-types";

/**
 * The API's published contract as types. `api-contract.ts` asserts over them,
 * and `api.ts` / `commands.ts` are annotated with them, so a renamed field is a
 * compile error at the literal that names it.
 *
 * Everything here derives from the generated `operations`, which derives from
 * `contract/openapi.json`. Nothing is hand-written and nothing exists at
 * runtime.
 */

export type Op = keyof operations;

export type Responses<O extends Op> = operations[O]["responses"];

export type Body<
  O extends Op,
  S extends keyof Responses<O>,
> = Responses<O>[S] extends {
  content: { "application/json": infer B };
}
  ? B
  : never;

export type RequestBody<O extends Op> = operations[O] extends {
  requestBody: { content: { "application/json": infer B } };
}
  ? B
  : never;

export type QueryParams<O extends Op> = operations[O]["parameters"] extends {
  query?: infer Q;
}
  ? NonNullable<Q>
  : never;

/**
 * The wire names of one operation's query parameters. Annotate every place that
 * writes a query key with this, so a renamed parameter fails to compile at the
 * string literal instead of surfacing as a `400` for a user.
 *
 * Guarded by `HasQueryParams` in `api-contract.ts`: `keyof never` widens to
 * `string`, so an operation whose query object vanished would otherwise accept
 * every key silently.
 */
export type WireQuery<O extends Op> = keyof QueryParams<O> & string;

/**
 * The machine error codes on the published `Problem` envelope, which the
 * exit-code mapping in `src/error-report.ts` branches on. Derived rather than
 * copied, so a code the API adds or renames fails `typecheck` at the mapping.
 */
export type ProblemCode = components["schemas"]["Problem"]["code"];

/** The CLI validates `--cabin` client-side (exit 2 rather than the API's 400).
 *  Deriving the set from the contract keeps that guard a subset of the API's
 *  own set rather than a copy of it. */
export type FlightCabin = NonNullable<
  RequestBody<"createFlightSearch">["cabin"]
>;
