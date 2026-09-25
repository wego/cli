#!/usr/bin/env bun
import openapiTS, { astToString } from "openapi-typescript";

/**
 * Generate `src/api-types.d.ts` from the vendored API contract
 * (`contract/openapi.json`).
 *
 * The CLI ships separately from the API, so they meet through a build-time read
 * of a checked-in file, which keeps them independently deployable. Nothing here
 * ships in the binary (types are erased at compile time), and the CLI keeps its
 * own tolerant Zod schemas as the runtime parser. The generated types let the
 * compiler compare the two.
 *
 * The output is not committed. Both `postinstall` and `bun run typecheck` run
 * this script, so nobody has to remember to regenerate it. Refresh the source
 * with `bun run api-contract:refresh`.
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
    // The CLI compares shapes, so an absent body and an explicit `null` body are
    // the same to it; `| null` everywhere would only add noise.
    emptyObjectsUnknown: true,
  });
  return `${HEADER}${astToString(ast)}`;
}

if (import.meta.main) {
  await Bun.write(OUTPUT, await renderApiTypes());
  console.log("wrote src/api-types.d.ts");
}
