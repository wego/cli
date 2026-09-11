#!/usr/bin/env bun
import openapiTS, { astToString } from "openapi-typescript";

/**
 * Generate `src/api-types.d.ts` from the API's **committed** contract
 * (`apps/api/contract/openapi.json`) — links 5-7 of #1300.
 *
 * This is the one place the two apps meet, and it meets them the only way that
 * keeps them independently deployable: a **build-time** read of a checked-in
 * file. No import crosses the app boundary, nothing here ships in the binary
 * (the output is types, erased at compile time), and the CLI keeps holding its
 * own tolerant Zod schemas as the runtime parser. What the generated types buy
 * is a compiler that can compare the two.
 *
 * Regenerating is not optional after an API wire change: `api-contract.test.ts`
 * fails when this output is stale, and `.github/workflows/ci-contract.yml` runs
 * on a change to EITHER app so an api-only PR cannot skip the CLI's half.
 */

const CONTRACT = new URL("../../api/contract/openapi.json", import.meta.url);
const OUTPUT = new URL("../src/api-types.d.ts", import.meta.url);

const HEADER = `/**
 * GENERATED FILE — do not edit.
 *
 * Source: apps/api/contract/openapi.json
 * Regenerate: bun run --filter cli api-types:generate
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
