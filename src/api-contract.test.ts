import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { CONTRACT_COVERAGE } from "./api-contract";

/**
 * Check B: the api↔cli contract's third question, and the only one a type
 * cannot answer.
 *
 * **Check B answers one question: does this dotted path exist in the published
 * body?** The fields below are ones the CLI's *behaviour* depends on while its
 * schema tolerates their absence - the settle-convergence counters above all.
 * Drop `metadata.snapshotFareCount` from the API and nothing else notices: the
 * CLI's tolerant count absorbs the absence, the polling loop stops converging,
 * and `flights search` silently degrades to item-presence. No type reports
 * that, because the CLI deliberately made the field optional.
 *
 * It is a RUNTIME walk of the vendored contract, not a type-level check. The
 * type-level form was built once and did not work: `DeepKeys` /
 * `UnionToIntersection` widened silently on an array-bearing body, so an entry
 * naming a path that did not exist PASSED. The contract is a JSON file in this
 * repository - walking it is a few lines, works on arrays, and says
 * `"metadata.snapshotFareCount" not found in getHotelRates 200` instead of a
 * twelve-line conditional-type error.
 *
 * Checks A and C live in `api-contract.ts` and run under `bun run typecheck`.
 * This file touches no network: it reads the committed `contract/openapi.json`,
 * which `bun run api-contract:refresh` is what updates.
 */

const CONTRACT = new URL("../contract/openapi.json", import.meta.url);

/** A field the CLI's behaviour reads, and where the API publishes it.
 *  `everyVariant` demands the path in EVERY branch of a `?view=` union - right
 *  when the CLI reads the field regardless of which variant it asked for. */
interface PublishedField {
  operationId: string;
  status: number;
  /** Dotted path; `[]` steps into an array's items. */
  path: string;
  /** What breaks in the CLI when this field stops being published. */
  because: string;
  everyVariant?: boolean;
}

const CLI_DEPENDS_ON: PublishedField[] = [
  // --- flights settle ---
  {
    operationId: "getFlightSearchResults",
    status: 200,
    path: "metadata.snapshotFareCount",
    because:
      "the flights settle loop converges on this counter holding steady across two reads (verticals.ts `count`)",
    everyVariant: true,
  },
  {
    operationId: "getFlightSearchResults",
    status: 200,
    path: "metadata.snapshotTripCount",
    because:
      "the settle guard requires it above 0, and the empty-page note distinguishes 'nothing yet' from 'filters excluded everything'",
    everyVariant: true,
  },
  {
    operationId: "getFlightSearchResults",
    status: 200,
    path: "results[].tripId",
    because: "`flights trip` is threaded from it",
    everyVariant: true,
  },
  // --- hotels settle + completed-empty messaging ---
  {
    operationId: "getHotelSearchResults",
    status: 200,
    path: "searchComplete",
    because:
      "the hotels settle treats `true` as an authoritative terminal (verticals.ts `isComplete`)",
    everyVariant: true,
  },
  {
    operationId: "getHotelSearchResults",
    status: 200,
    path: "metadata.snapshotCandidateCount",
    because:
      "the hotels settle converges on it; it stabilizes ~3x sooner than searchComplete",
    everyVariant: true,
  },
  {
    operationId: "getHotelSearchResults",
    status: 200,
    path: "metadata.totalCandidates",
    because:
      "a completed search with 0 candidates is the only authoritative 'no results' the CLI reports",
    everyVariant: true,
  },
  {
    operationId: "getHotelSearchResults",
    status: 200,
    path: "metadata.totalBeforeFilters",
    because:
      "it is what makes that zero authoritative rather than a filter artifact",
    everyVariant: true,
  },
  {
    operationId: "getHotelSearchResults",
    status: 200,
    path: "results[].hotelId",
    because: "`hotels rooms` / `hotels details` are threaded from it",
    everyVariant: true,
  },
  // --- the value-threading chain: each id feeds the next command ---
  {
    operationId: "createFlightSearch",
    status: 201,
    path: "searchId",
    because: "every later flights read is threaded from it",
  },
  {
    operationId: "createHotelSearch",
    status: 201,
    path: "searchId",
    because: "every later hotels read is threaded from it",
  },
  {
    operationId: "createHotelSearch",
    status: 201,
    path: "occupancy.childrenAges",
    because:
      "the CLI surfaces the resolved child ages so the priced occupancy is auditable",
  },
  {
    operationId: "getHotelSearchResults",
    status: 200,
    path: "stay.occupancy.rooms",
    because:
      "the skill tells the agent to read it before describing a nightly figure, so a dropped stay silently reverts to quoting a multi-room price as per-room",
  },
  {
    operationId: "getHotelSearchResults",
    status: 200,
    path: "results[].price.scope",
    because:
      "it is the only field stating that a hotel price covers the whole booking rather than one room",
  },
  {
    operationId: "getFlightTrip",
    status: 200,
    path: "fares[].fareId",
    because: "`flights fares` / `flights booking-link` are threaded from it",
  },
  {
    operationId: "getFlightTrip",
    status: 200,
    path: "fares[].kind",
    because:
      "the CLI's guidance for a non-wego fare (use its handoffUrl) reads this",
  },
  {
    operationId: "getFareOptions",
    status: 200,
    path: "options[].fareOptionId",
    because: "`booking-link --fare-option` is threaded from it",
  },
  {
    operationId: "getHotelRates",
    status: 200,
    path: "rates[].id",
    because: "`hotels booking-link --rate` is threaded from it",
  },
  {
    operationId: "getHotelRates",
    status: 200,
    path: "searchComplete",
    because: "the rooms read reports whether the rate list has settled",
  },
  // --- the handoff URLs: the terminal value of both funnels ---
  {
    operationId: "getFareBookingLink",
    status: 200,
    path: "bookingUrl",
    because: "it is the whole output of `flights booking-link`",
  },
  {
    operationId: "getHotelRateBookingLink",
    status: 200,
    path: "bookingUrl",
    because: "it is the whole output of `hotels booking-link`",
  },
];

interface SpecNode {
  properties?: Record<string, SpecNode>;
  items?: SpecNode;
  anyOf?: SpecNode[];
  oneOf?: SpecNode[];
  allOf?: SpecNode[];
  $ref?: string;
}

interface Spec {
  paths: Record<
    string,
    Record<
      string,
      {
        operationId?: string;
        responses?: Record<
          string,
          { content?: Record<string, { schema?: SpecNode }> }
        >;
      }
    >
  >;
  components?: { schemas?: Record<string, SpecNode> };
}

const spec = JSON.parse(readFileSync(CONTRACT, "utf8")) as Spec;

/** The JSON schema node the contract publishes for one operation + status. */
function bodySchema(operationId: string, status: number): SpecNode | undefined {
  for (const operations of Object.values(spec.paths)) {
    for (const operation of Object.values(operations)) {
      if (operation.operationId !== operationId) continue;
      return operation.responses?.[String(status)]?.content?.[
        "application/json"
      ]?.schema;
    }
  }
  return undefined;
}

function deref(node: SpecNode | undefined): SpecNode | undefined {
  if (!node?.$ref) return node;
  const name = node.$ref.replace("#/components/schemas/", "");
  return spec.components?.schemas?.[name];
}

/**
 * Every alternative the response can BE: itself, or each branch of an `anyOf` /
 * `oneOf`. `allOf` is not an alternative - it is one shape assembled from parts
 * - so it stays a single entry here.
 *
 * That distinction is what `everyVariant` rests on. Expanding `allOf` here too
 * would make each part look like a competing response variant, and an
 * `everyVariant` field carried by ONE part would then be reported missing from
 * the others: a false failure on a perfectly valid contract.
 */
function alternatives(node: SpecNode | undefined): SpecNode[] {
  const resolved = deref(node);
  if (!resolved) return [];
  const branches = resolved.anyOf ?? resolved.oneOf;
  if (branches) return branches.flatMap((branch) => alternatives(branch));
  return [resolved];
}

/**
 * The shapes a property lookup may land on at one level: each alternative, plus
 * each `allOf` part, because an assembled shape carries its parts' properties.
 * This is the merge `alternatives` deliberately does not do.
 */
function lookupShapes(node: SpecNode | undefined): SpecNode[] {
  const resolved = deref(node);
  if (!resolved) return [];
  const branches = resolved.anyOf ?? resolved.oneOf;
  if (branches) return branches.flatMap((branch) => lookupShapes(branch));
  if (resolved.allOf) {
    return [resolved, ...resolved.allOf.flatMap((part) => lookupShapes(part))];
  }
  return [resolved];
}

/**
 * Walk a dotted path through ONE variant. `[]` steps into array items - the
 * case the type-level version got wrong.
 */
function resolves(node: SpecNode | undefined, path: string): boolean {
  let current = deref(node);
  for (const rawSegment of path.split(".")) {
    if (!current) return false;
    let segment = rawSegment;
    let intoItems = false;
    if (segment.endsWith("[]")) {
      segment = segment.slice(0, -2);
      intoItems = true;
    }
    // A property may sit on any branch of a composition at this level.
    const candidates = lookupShapes(current)
      .map((variant) => variant.properties?.[segment])
      .filter((child): child is SpecNode => child !== undefined);
    if (candidates.length === 0) return false;
    let next = deref(candidates[0]);
    if (intoItems) {
      const items = lookupShapes(next)
        .map((variant) => variant.items)
        .filter((item): item is SpecNode => item !== undefined)[0];
      if (!items) return false;
      next = deref(items);
    }
    current = next;
  }
  return current !== undefined;
}

/** Why this declared path does not hold in THIS body, or `undefined` when it
 *  does. Split from `unresolvedPath` so the `everyVariant` rule can be tested
 *  against a constructed body, not only against whatever the contract happens
 *  to publish today. */
function missingFrom(
  body: SpecNode | undefined,
  field: PublishedField,
): string | undefined {
  const branches = alternatives(body);
  if (branches.length === 0) {
    return `${field.operationId} ${field.status} - the published body has no resolvable schema`;
  }
  const hits = branches.filter((branch) => resolves(branch, field.path));
  if (hits.length >= (field.everyVariant ? branches.length : 1)) {
    return undefined;
  }
  const variantNote = field.everyVariant
    ? ` (present in ${hits.length}/${branches.length} response variants; the CLI reads it whichever variant it asked for)`
    : "";
  return `"${field.path}" not found in ${field.operationId} ${field.status} body${variantNote} - ${field.because}`;
}

/** Why this declared path does not hold, or `undefined` when it does. */
function unresolvedPath(field: PublishedField): string | undefined {
  const body = bodySchema(field.operationId, field.status);
  if (!body) {
    return `${field.operationId} ${field.status} - the operation or status is not in the published contract at all`;
  }
  return missingFrom(body, field);
}

describe("Check B - the fields the CLI's behaviour depends on are published", () => {
  it("names at least one dependency per funnel (not vacuous)", () => {
    // A guard on the guard: an empty or accidentally-filtered table would make
    // every assertion below pass while checking nothing.
    expect(CLI_DEPENDS_ON.length).toBeGreaterThan(10);
    const operations = new Set(CLI_DEPENDS_ON.map((f) => f.operationId));
    expect(operations.has("getFlightSearchResults")).toBe(true);
    expect(operations.has("getHotelSearchResults")).toBe(true);
  });

  it("gives every entry a reason it is depended on", () => {
    // `because` is what a future reader needs to decide whether a removed field
    // is a real break or an entry that outlived its command. An empty one makes
    // the failure message useless.
    const unexplained = CLI_DEPENDS_ON.filter(
      (field) => field.because.trim().length < 20,
    ).map((field) => `${field.operationId} ${field.path}`);
    expect(unexplained).toEqual([]);
  });

  it("resolves every declared path in the published contract", () => {
    const missing = CLI_DEPENDS_ON.map(unresolvedPath).filter(
      (failure): failure is string => failure !== undefined,
    );
    expect(missing).toEqual([]);
  });

  it("would reject a path that does not exist", () => {
    // The injection, kept as a test: this is the exact case the type-level
    // Check B passed. Two shapes - a plain miss and an array-bearing body.
    const flights = bodySchema("getFlightSearchResults", 200);
    expect(resolves(flights, "metadata.snapshotFareCount")).toBe(true);
    expect(resolves(flights, "metadata.notAField")).toBe(false);
    const rates = bodySchema("getHotelRates", 200);
    expect(resolves(rates, "rates[].id")).toBe(true);
    expect(resolves(rates, "rates[].notAField")).toBe(false);
    // The array step itself must be load-bearing: without `[]` the path must
    // not resolve, or `[]` would be decoration and every array path a false
    // pass.
    expect(resolves(rates, "rates.id")).toBe(false);
  });

  it("reads an `allOf` as one assembled shape, not as competing variants", () => {
    // The bug this kills: expanding `allOf` into "variants" made each part look
    // like an alternative response, so an `everyVariant` field carried by ONE
    // part was reported missing from the others - a failure on a contract that
    // publishes the field on every response it can return.
    const assembled: SpecNode = {
      allOf: [
        { properties: { searchComplete: {} } },
        { properties: { metadata: { properties: { totalCandidates: {} } } } },
      ],
    };
    expect(alternatives(assembled)).toHaveLength(1);
    expect(resolves(assembled, "searchComplete")).toBe(true);
    expect(resolves(assembled, "metadata.totalCandidates")).toBe(true);
    expect(resolves(assembled, "metadata.notAField")).toBe(false);

    const field: PublishedField = {
      operationId: "getHotelSearchResults",
      status: 200,
      path: "searchComplete",
      because: "a field one `allOf` part supplies is still published",
      everyVariant: true,
    };
    expect(missingFrom(assembled, field)).toBeUndefined();

    // And the rule it must not weaken: a genuine `anyOf` still has to carry the
    // field in every branch.
    const union: SpecNode = {
      anyOf: [{ properties: { searchComplete: {} } }, { properties: {} }],
    };
    expect(alternatives(union)).toHaveLength(2);
    expect(missingFrom(union, field)).toContain("present in 1/2");
  });
});

describe("the vendored contract", () => {
  it("classifies every published operation", () => {
    // `CONTRACT_COVERAGE` is typed `Record<Op, …>`, so the compiler already
    // forces an entry per operation. This asserts the other direction: the
    // generated `Op` union really is the contract's operation set, so that
    // compile-time gate is not measuring a stale or empty type.
    const published = new Set<string>();
    for (const operations of Object.values(spec.paths)) {
      for (const operation of Object.values(operations)) {
        if (operation.operationId) published.add(operation.operationId);
      }
    }
    expect(Object.keys(CONTRACT_COVERAGE).sort()).toEqual(
      [...published].sort(),
    );
  });

  it("is the production document, refreshable and readable", () => {
    // The `servers` block is why the refresh script only ever fetches
    // production: a staging or preview URL would rewrite this line on every
    // refresh, and vendor a contract nothing ships against.
    const document = JSON.parse(readFileSync(CONTRACT, "utf8")) as {
      servers?: Array<{ url?: string }>;
    };
    expect(document.servers?.map((server) => server.url)).toEqual([
      "https://api.wego.com",
    ]);
    // Two-space indent and a trailing newline, so a refresh produces a diff a
    // person can read rather than one reformatted line.
    const text = readFileSync(CONTRACT, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text.split("\n")[1]).toMatch(/^ {2}"/);
  });
});
