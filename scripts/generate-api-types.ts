#!/usr/bin/env bun
import openapiTS, { astToString } from "openapi-typescript";

/**
 * Generate `src/api-types.d.ts` from the vendored API contract
 * (`contract/openapi.json`).
 *
 * The CLI ships separately from the API, so the two meet the only way that
 * keeps them independently deployable: a **build-time** read of a checked-in
 * file. No import crosses the boundary, nothing here ships in the binary (the
 * output is types, erased at compile time), and the CLI keeps holding its own
 * tolerant Zod schemas as the runtime parser. What the generated types buy is a
 * compiler that can compare the two.
 *
 * The output is not committed. `postinstall` runs this script, so
 * `src/api-types.d.ts` exists after `bun install` for editors, `bun run
 * typecheck` and CI; regenerating it is never something a person has to
 * remember. Refresh the source with `bun run api-contract:refresh`.
 */

const CONTRACT = new URL("../contract/openapi.json", import.meta.url);
const OUTPUT = new URL("../src/api-types.d.ts", import.meta.url);

const HEADER = `/**
 * GENERATED FILE — do not edit, and do not commit.
 *
 * Source: contract/openapi.json
 * Regenerate: bun run api-types:generate
 *
 * The API's published response and request shapes, as TypeScript. \`api-contract.ts\`
 * compares them against the CLI's own Zod-inferred types; this file is never
 * imported at runtime.
 */

`;

export async function renderApiTypes(): Promise<string> {
  const ast = await openapiTS(CONTRACT, {
    // The CLI compares shapes, so a body that is absent on the wire and a body
    // explicitly `null` are the same thing to it; emitting `| null` everywhere
    // would only add noise to every comparison.
    emptyObjectsUnknown: true,
  });
  return `${HEADER}${astToString(ast)}`;
}

if (import.meta.main) {
  await Bun.write(OUTPUT, await renderApiTypes());
  console.log("wrote src/api-types.d.ts");
}
