/**
 * ARGV ROUTING FOR THE RELEASE PUBLISHER: which moving pointer a run advances.
 *
 * Extracted from `upload-release-blob.ts` for the reason `ring-rules.ts`,
 * `release-signing.ts`, `blob-publish.ts` and `blob-consistency.ts` were all
 * extracted from it before: the decisions below are the ones that can be wrong,
 * and in the publisher they were unreachable. They closed over a module-level
 * `argv` and ended in `process.exit`, in a module that runs its whole publish at
 * import - no `import.meta.main` guard, every statement top-level - so importing
 * it to ask "what does `--promote --to stable` route to?" starts a publisher
 * instead of answering, and the first refusal it reaches exits the test runner.
 *
 * WHAT IS AT STAKE. `computeAdvanceTargets` decides whether a run moves
 * `cli/stable` - the pointer the entire install base follows - moves `cli/next`,
 * or moves nothing at all. `wego update` replaces the running binary on a
 * CHECKSUM difference and never on a version comparison, so whatever a ring
 * serves is what its install base receives on the next update. A `--freeze` that
 * routed to `["next"]` would advance a pointer the operator asked to leave
 * alone, and every gate downstream of this function would agree with it, because
 * they are handed the targets rather than asked to re-derive them.
 *
 * NO `process.exit`, AND NO PRINTING. Each function returns its value or an
 * `{ error }`, and the publisher does the exiting. That is what makes the
 * refusals testable: the messages below are what an operator reads at 3am during
 * a promote, and a message naming the wrong flag sends them to the wrong lane.
 */
import { isRing, type Ring } from "./ring-rules";

/** `--freeze` advances nothing, `--promote` advances its `--to`, a bare tag
 *  advances `cli/next`. */
export type Mode = "publish" | "freeze" | "promote";

/** A refusal, carrying the line the publisher prints before it exits 1. */
export interface ArgvError {
  error: string;
}

export const isArgvError = (v: unknown): v is ArgvError =>
  typeof v === "object" && v !== null && "error" in v;

/**
 * The mode a leading flag selects.
 *
 * Total on purpose: anything that is not one of the two flags is a publish,
 * because the bare-positional form is `upload-release-blob.ts v1.2.3`. That
 * makes an unrecognised `--flag` read as a publish TAG, which is what
 * {@link leadingFlagError} exists to catch first.
 */
export function parseMode(flag: string | undefined): Mode {
  if (flag === "--promote") return "promote";
  if (flag === "--freeze") return "freeze";
  return "publish";
}

/**
 * An unknown flag in the mode position, refused before any store access.
 *
 * Without this a typo'd `--frezee` becomes the tag, and the run gets as far as
 * the `vX.Y.Z` shape guard before complaining - about a tag the operator never
 * typed.
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
 * Every ring is nameable, `edge` included. It was refused here while this lived
 * in the previous repository, on the reasoning that the edge lane publishes
 * its own `X.Y.Z-edge.<sha>` builds and a plain release must never land on
 * `edge`. That is still true as a DEFAULT - the default is `next`, and nothing
 * routes a release to `edge` on its own - but a parser that cannot even name a
 * ring the promote lane operates on is the wrong place to enforce it. An
 * operator promoting deliberately would get a usage error instead of the
 * promote, and the real guards (the tag gate, `--require-serving`, and the
 * byte-identity check against `cli/<tag>/`) are the ones that decide whether a
 * ring may be advanced.
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
 * Resolved at argv time and beside the tag gate, so a typo costs one cheap step
 * rather than a Blob round trip - the same reason `releaseTagError` runs before
 * any store access.
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
 * THE ROUTING DECISION: which moving pointers this run advances, if any.
 *
 * `next` and `stable` are the same stable line at two distances from the install
 * base - `cli/next` is the candidate real people run, `cli/stable` is what
 * everyone receives, and stable is reached ONLY by promoting a next build.
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
