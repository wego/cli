/**
 * Argv routing for the release publisher: which moving pointer a run advances.
 *
 * Kept out of `upload-release-blob.ts` because that module runs its whole
 * publish at import (no `import.meta.main` guard), so these decisions could not
 * be tested there.
 *
 * `computeAdvanceTargets` decides whether a run moves `cli/stable` (the pointer
 * the whole install base follows), moves `cli/next`, or moves nothing.
 * `wego update` replaces the binary on a checksum difference, not a version
 * comparison, so whatever a ring serves is what its install base gets next.
 * Every downstream gate is handed these targets rather than re-deriving them,
 * so a wrong answer here is not caught later.
 *
 * No `process.exit` and no printing: each function returns its value or an
 * `{ error }`, and the publisher does the exiting, so the refusals are testable.
 */
import { isRing, type Ring } from "./ring-rules";

/** `--freeze` advances nothing, `--promote` advances its `--to`, a bare tag
 *  advances `cli/next`. */
export type Mode = "publish" | "freeze" | "promote";

/** A refusal: the line the publisher prints before it exits 1. */
export interface ArgvError {
  error: string;
}

export const isArgvError = (v: unknown): v is ArgvError =>
  typeof v === "object" && v !== null && "error" in v;

/**
 * Anything that is not one of the two flags is a publish, because the bare form
 * is `upload-release-blob.ts v1.2.3`. That makes an unrecognised `--flag` read
 * as a publish tag, which {@link leadingFlagError} catches first.
 */
export function parseMode(flag: string | undefined): Mode {
  if (flag === "--promote") return "promote";
  if (flag === "--freeze") return "freeze";
  return "publish";
}

/**
 * An unknown flag in the mode position, refused before any store access.
 *
 * Without this a typo'd `--frezee` becomes the tag, and the `vX.Y.Z` shape
 * guard complains about a tag the operator never typed.
 */
export function leadingFlagError(argv: string[]): ArgvError | null {
  const first = argv[0];
  if (
    first?.startsWith("--") &&
    first !== "--freeze" &&
    first !== "--promote"
  ) {
    return {
      error: `Unknown flag "${first}" - use --freeze or --promote, or a bare tag.`,
    };
  }
  return null;
}

/**
 * A stray flag where `--freeze`/`--promote` expect their tag.
 *
 * Separate from the tag-shape guard so the message names the flag rather than
 * reporting `--typo` as a malformed version.
 */
export function tagPositionError(argv: string[], mode: Mode): ArgvError | null {
  if (mode !== "publish" && argv[1]?.startsWith("--")) {
    return {
      error: `Unknown flag "${argv[1]}" after ${argv[0]} - expected a tag.`,
    };
  }
  return null;
}

/**
 * `--to <ring>`, defaulting to `next`.
 *
 * Every ring is nameable, `edge` included. A plain release should not land on
 * `edge` by default, and nothing routes it there on its own, but the parser is
 * the wrong place to enforce that. The real guards (the tag gate,
 * `--require-serving`, and the byte-identity check against `cli/<tag>/`) decide
 * whether a ring may be advanced.
 */
export function parsePromoteTarget(argv: string[]): Ring | ArgvError {
  const i = argv.indexOf("--to");
  if (i < 0) return "next";
  const v = argv[i + 1];
  if (v && isRing(v)) return v;
  return {
    error: `--to must name a ring: edge, next or stable (got "${v ?? ""}").`,
  };
}

/**
 * `--require-serving <ring>`: the ring that must already serve this tag before a
 * promote may proceed, or `null` when the flag is absent.
 *
 * Resolved at argv time so a typo fails before any Blob round trip, like
 * `releaseTagError`.
 */
export function parseRequireServing(argv: string[]): Ring | null | ArgvError {
  const i = argv.indexOf("--require-serving");
  if (i < 0) return null;
  const v = argv[i + 1];
  if (v && isRing(v)) return v;
  return {
    error: `--require-serving must name a ring: edge, next or stable (got "${v ?? ""}").`,
  };
}

/**
 * Which moving pointers this run advances, if any.
 *
 * `cli/next` is the candidate real people run, `cli/stable` is what everyone
 * receives, and stable is reached only by promoting a next build.
 *
 * A bare publish advances `cli/next` so that a local one-shot reproduces the
 * release job's routing, rather than putting a fresh build in front of the whole
 * install base.
 */
export function computeAdvanceTargets(
  mode: Mode,
  argv: string[],
): Ring[] | ArgvError {
  if (mode === "promote") {
    const target = parsePromoteTarget(argv);
    return isArgvError(target) ? target : [target];
  }
  if (mode === "freeze") return [];
  return ["next"];
}
