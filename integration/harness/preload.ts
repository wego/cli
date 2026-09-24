/**
 * Resolve the binary once, before any scenario file loads, so a compile failure is
 * one clear error rather than one per file.
 */
import { resolveBinary } from "./binary";

const path = await resolveBinary();
console.log(`integration: driving ${path}`);
