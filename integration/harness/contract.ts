/**
 * The contract every exchange in the fake is checked against: `contract/openapi.json`,
 * the vendored copy of the API's published document.
 *
 * A hand-written fake can only fail when it disagrees with itself. Checking every
 * request and answer against the API's published schema makes it fail when the CLI
 * and the API disagree, which is what this tier exists to catch.
 *
 * A validator for the slice of JSON Schema the document uses, not a general one:
 * `type`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`,
 * `anyOf`, `oneOf`, `pattern`, the length/size/range bounds and local `$ref`. A
 * keyword outside that slice fails loudly (`unsupported`), so a contract refresh that
 * starts using one cannot be validated vacuously.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Schema = Record<string, unknown>;

interface Parameter {
  in: "path" | "query" | "header" | "cookie";
  name: string;
  required?: boolean;
  schema: Schema;
}

export interface Operation {
  method: string;
  /** The template, e.g. `/v1/flights/trips/{tripId}`. */
  path: string;
  operationId: string;
  parameters: Parameter[];
  requestBody?: Schema;
  /** Status → media type → schema. */
  responses: Record<string, Record<string, Schema | undefined>>;
}

const CONTRACT_PATH = fileURLToPath(
  new URL("../../contract/openapi.json", import.meta.url),
);

const document = JSON.parse(readFileSync(CONTRACT_PATH, "utf8")) as {
  paths: Record<string, Record<string, Record<string, unknown>>>;
  components: { schemas: Record<string, Schema> };
};

const KNOWN_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "anyOf",
  "oneOf",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "$ref",
  // Annotations: no bearing on validity.
  "description",
  "default",
  "example",
  "examples",
  "format",
  "title",
  "deprecated",
  "readOnly",
  "writeOnly",
]);

function operations(): Operation[] {
  const out: Operation[] = [];
  for (const [path, item] of Object.entries(document.paths)) {
    for (const [method, raw] of Object.entries(item)) {
      const responses: Operation["responses"] = {};
      const rawResponses = (raw.responses ?? {}) as Record<
        string,
        { content?: Record<string, { schema?: Schema }> }
      >;
      for (const [status, response] of Object.entries(rawResponses)) {
        responses[status] = Object.fromEntries(
          Object.entries(response.content ?? {}).map(([type, media]) => [
            type,
            media.schema,
          ]),
        );
      }
      const body = raw.requestBody as
        | { content?: Record<string, { schema?: Schema }> }
        | undefined;
      out.push({
        method: method.toUpperCase(),
        path,
        operationId: String(raw.operationId),
        parameters: (raw.parameters ?? []) as Parameter[],
        requestBody: body?.content?.["application/json"]?.schema,
        responses,
      });
    }
  }
  return out;
}

const OPERATIONS = operations();

export function operationById(id: string): Operation {
  const op = OPERATIONS.find((o) => o.operationId === id);
  if (!op) throw new Error(`contract: no operation "${id}"`);
  return op;
}

/** The operation a request addresses, and its path parameters. Literal segments
 *  win over templated ones, so `/v1/places/nearby` is never read as a place id. */
export function matchOperation(
  method: string,
  pathname: string,
): { op: Operation; pathParams: Record<string, string> } | undefined {
  const segments = pathname.split("/");
  let best:
    | { op: Operation; pathParams: Record<string, string>; literals: number }
    | undefined;
  for (const op of OPERATIONS) {
    if (op.method !== method) continue;
    const template = op.path.split("/");
    if (template.length !== segments.length) continue;
    const pathParams: Record<string, string> = {};
    let literals = 0;
    let ok = true;
    template.forEach((part, i) => {
      const actual = segments[i] ?? "";
      const name = /^\{(.+)\}$/.exec(part)?.[1];
      if (name) pathParams[name] = decodeURIComponent(actual);
      else if (part === actual) literals += 1;
      else ok = false;
    });
    if (ok && (!best || literals > best.literals)) {
      best = { op, pathParams, literals };
    }
  }
  return best && { op: best.op, pathParams: best.pathParams };
}

function resolve(schema: Schema): Schema {
  const ref = schema.$ref;
  if (typeof ref !== "string") return schema;
  const name = /^#\/components\/schemas\/(.+)$/.exec(ref)?.[1];
  const target = name ? document.components.schemas[name] : undefined;
  if (!target) throw new Error(`contract: unresolvable $ref ${ref}`);
  return resolve(target);
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "number";
  }
  return typeof value;
}

function typeMatches(declared: string, actual: string): boolean {
  return declared === actual || (declared === "number" && actual === "integer");
}

/** Every violation of `schema` by `value`, as `<path>: <why>`. Empty = valid. */
export function validate(value: unknown, schema: Schema, at = "$"): string[] {
  const s = resolve(schema);
  for (const key of Object.keys(s)) {
    if (!KNOWN_KEYWORDS.has(key) && !key.startsWith("x-")) {
      return [`${at}: unsupported schema keyword "${key}"`];
    }
  }
  const errors: string[] = [];
  const actual = typeOf(value);

  if (s.anyOf || s.oneOf) {
    const branches = (s.anyOf ?? s.oneOf) as Schema[];
    const results = branches.map((b) => validate(value, b, at));
    // A branch the validator cannot read fails the whole schema: counting it as a
    // mere mismatch would let a sibling branch pass the value unread.
    const unsupported = results
      .flat()
      .filter((e) => e.includes("unsupported schema keyword"));
    if (unsupported.length > 0) return unsupported;
    const passing = results.filter((r) => r.length === 0);
    if (s.anyOf && passing.length === 0) {
      errors.push(`${at}: matches none of anyOf`);
    }
    if (s.oneOf && passing.length !== 1) {
      errors.push(`${at}: matches ${passing.length} of oneOf, expected 1`);
    }
  }
  if (s.type !== undefined) {
    const declared = Array.isArray(s.type) ? s.type : [s.type];
    if (!declared.some((t) => typeMatches(String(t), actual))) {
      return [
        ...errors,
        `${at}: expected ${declared.join("|")}, got ${actual}`,
      ];
    }
  }
  if ("const" in s && value !== s.const) {
    errors.push(`${at}: expected ${JSON.stringify(s.const)}`);
  }
  if (Array.isArray(s.enum) && !s.enum.includes(value)) {
    errors.push(`${at}: ${JSON.stringify(value)} not in enum`);
  }
  if (typeof value === "string") {
    if (typeof s.pattern === "string" && !new RegExp(s.pattern).test(value)) {
      errors.push(`${at}: does not match ${s.pattern}`);
    }
    if (typeof s.minLength === "number" && value.length < s.minLength) {
      errors.push(`${at}: shorter than ${s.minLength}`);
    }
    if (typeof s.maxLength === "number" && value.length > s.maxLength) {
      errors.push(`${at}: longer than ${s.maxLength}`);
    }
  }
  if (typeof value === "number") {
    if (typeof s.minimum === "number" && value < s.minimum) {
      errors.push(`${at}: below ${s.minimum}`);
    }
    if (typeof s.maximum === "number" && value > s.maximum) {
      errors.push(`${at}: above ${s.maximum}`);
    }
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === "number" && value.length < s.minItems) {
      errors.push(`${at}: fewer than ${s.minItems} items`);
    }
    if (typeof s.maxItems === "number" && value.length > s.maxItems) {
      errors.push(`${at}: more than ${s.maxItems} items`);
    }
    if (s.items) {
      value.forEach((item, i) => {
        errors.push(...validate(item, s.items as Schema, `${at}[${i}]`));
      });
    }
  }
  if (actual === "object") {
    const obj = value as Record<string, unknown>;
    const props = (s.properties ?? {}) as Record<string, Schema>;
    for (const name of (s.required ?? []) as string[]) {
      if (!(name in obj)) errors.push(`${at}.${name}: required`);
    }
    for (const [name, v] of Object.entries(obj)) {
      const prop = props[name];
      if (prop) errors.push(...validate(v, prop, `${at}.${name}`));
      else if (s.additionalProperties === false) {
        errors.push(`${at}.${name}: not declared`);
      } else if (typeof s.additionalProperties === "object") {
        errors.push(
          ...validate(v, s.additionalProperties as Schema, `${at}.${name}`),
        );
      }
    }
  }
  return errors;
}

/** A query or path value arrives as text; coerce it to what its schema declares
 *  before validating, the way the API's own parser does. */
function coerce(raw: string, schema: Schema): unknown {
  const s = resolve(schema);
  const types = Array.isArray(s.type) ? s.type : [s.type];
  if (types.includes("integer") || types.includes("number")) {
    const n = Number(raw);
    return raw.trim() !== "" && Number.isFinite(n) ? n : raw;
  }
  if (types.includes("boolean")) {
    return raw === "true" ? true : raw === "false" ? false : raw;
  }
  return raw;
}

/** Every way a request breaks the contract: unknown or invalid query parameters,
 *  invalid path parameters, a missing required parameter, an invalid JSON body. */
export function validateRequest(
  op: Operation,
  url: URL,
  pathParams: Record<string, string>,
  body: unknown,
): string[] {
  const errors: string[] = [];
  const declared = new Map(
    op.parameters.filter((p) => p.in === "query").map((p) => [p.name, p]),
  );
  for (const name of new Set(url.searchParams.keys())) {
    const param = declared.get(name);
    if (!param) {
      errors.push(`query ${name}: not declared by ${op.operationId}`);
      continue;
    }
    const values = url.searchParams.getAll(name);
    const schema = resolve(param.schema);
    const value =
      schema.type === "array"
        ? values
            .flatMap((v) => v.split(","))
            .map((v) => coerce(v, (schema.items ?? {}) as Schema))
        : coerce(values[values.length - 1] ?? "", schema);
    errors.push(...validate(value, schema, `query ${name}`));
  }
  for (const param of op.parameters) {
    if (param.in === "path") {
      errors.push(
        ...validate(
          coerce(pathParams[param.name] ?? "", param.schema),
          param.schema,
          `path ${param.name}`,
        ),
      );
    } else if (
      param.in === "query" &&
      param.required &&
      !url.searchParams.has(param.name)
    ) {
      errors.push(`query ${param.name}: required`);
    }
  }
  if (op.requestBody) errors.push(...validate(body, op.requestBody, "body"));
  return errors;
}

/** Every way an answer breaks the contract: an undeclared status, an undeclared
 *  media type, or a body its schema rejects. */
export function validateResponse(
  op: Operation,
  status: number,
  contentType: string,
  body: unknown,
): string[] {
  const response = op.responses[String(status)];
  if (!response) return [`status ${status}: not declared by ${op.operationId}`];
  const media = contentType.split(";")[0]?.trim() ?? "";
  if (!(media in response)) {
    return [`status ${status}: media type ${media} not declared`];
  }
  const schema = response[media];
  return schema ? validate(body, schema, `${status} body`) : [];
}
