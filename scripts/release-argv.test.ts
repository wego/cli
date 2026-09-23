/**
 * The routing decision on the lane that writes `cli/stable`.
 *
 * `computeAdvanceTargets` decides whether a run moves the pointer the entire
 * install base follows, moves the candidate ring, or moves nothing. Everything
 * downstream is HANDED that answer rather than re-deriving it - the crossed-pair
 * guard, the consistency barrier, the signed-record verify and the summary all
 * iterate `advanceTargets` - so a wrong answer here is not caught later, it is
 * faithfully executed by every gate in turn.
 *
 * Until now nothing could ask it anything. It closed over a module-level `argv`
 * and ended in `process.exit`, inside an 810-line module that runs its whole
 * publish at import - no `import.meta.main` guard, every statement top-level -
 * so the only way to exercise a routing decision was to start a publisher, and
 * the first refusal it reached would exit the test runner with it.
 * `release-argv.ts` is that decision with the exiting taken out.
 *
 * The mutations this suite kills:
 *   - `--freeze` routed to anything but `[]` -> it advances a pointer the
 *     operator explicitly asked it to leave alone.
 *   - the bare-publish default flipped to `stable` -> a fresh build lands in
 *     front of the whole install base instead of the candidate ring.
 *   - `--to` defaulting to the LAST ring rather than `next`, or reading the flag
 *     rather than its value.
 *   - a bad ring falling through as `next` instead of refusing -> `--to stabel`
 *     silently advances the wrong pointer, which is the promote's entire job
 *     done wrong, green.
 *   - the two `--` guards swapped, so a typo'd mode flag is reported as a bad
 *     tag and the operator is sent to the wrong end of the lane.
 */
import { describe, expect, it } from "bun:test";
import {
  computeAdvanceTargets,
  isArgvError,
  leadingFlagError,
  type Mode,
  parseMode,
  parsePromoteTarget,
  parseRequireServing,
  tagPositionError,
} from "./release-argv";

/** The value side of a result, or a failure naming what came back instead. */
function ok<T>(v: T | { error: string }): T {
  if (isArgvError(v)) throw new Error(`expected a value, got: ${v.error}`);
  return v;
}

/** The error side, for the refusal cases. */
function err(v: unknown): string {
  if (!isArgvError(v)) throw new Error(`expected a refusal, got: ${String(v)}`);
  return v.error;
}

describe("parseMode", () => {
  it("reads the two mode flags", () => {
    expect(parseMode("--promote")).toBe("promote");
    expect(parseMode("--freeze")).toBe("freeze");
  });

  // Total by design: the bare form is `upload-release-blob.ts v1.2.3`, so
  // anything that is not one of the two flags has to be a publish. That is what
  // makes `leadingFlagError` load-bearing rather than cosmetic - without it an
  // unrecognised flag becomes the TAG.
  it("reads everything else, including a typo, as a publish", () => {
    expect(parseMode("v1.2.3")).toBe("publish");
    expect(parseMode(undefined)).toBe("publish");
    expect(parseMode("--frezee")).toBe("publish");
  });
});

describe("leadingFlagError", () => {
  it("passes the two real flags and a bare tag", () => {
    expect(leadingFlagError(["--promote", "v1.2.3"])).toBeNull();
    expect(leadingFlagError(["--freeze", "v1.2.3"])).toBeNull();
    expect(leadingFlagError(["v1.2.3"])).toBeNull();
    expect(leadingFlagError([])).toBeNull();
  });

  it("refuses a typo'd mode flag before it can be read as a tag", () => {
    expect(err(leadingFlagError(["--frezee", "v1.2.3"]))).toBe(
      'Unknown flag "--frezee" - use --freeze or --promote, or a bare tag.',
    );
  });

  // Only the MODE position. `--to` and `--require-serving` are legitimate flags
  // further along, and a guard that scanned the whole argv would refuse every
  // promote this lane exists to run.
  it("looks only at the first argument", () => {
    expect(
      leadingFlagError(["--promote", "v1.2.3", "--to", "stable"]),
    ).toBeNull();
  });
});

describe("tagPositionError", () => {
  it("is silent on a publish, which has no flag in that position", () => {
    expect(tagPositionError(["v1.2.3"], "publish")).toBeNull();
    // A publish's argv[1] may legitimately be a flag.
    expect(tagPositionError(["v1.2.3", "--to", "next"], "publish")).toBeNull();
  });

  it("passes a real tag after either mode flag", () => {
    expect(tagPositionError(["--freeze", "v1.2.3"], "freeze")).toBeNull();
    expect(
      tagPositionError(["--promote", "v1.2.3", "--to", "stable"], "promote"),
    ).toBeNull();
  });

  // Named separately from the tag-shape guard so the operator reads "unknown
  // flag" rather than "malformed version" for a flag they mistyped.
  it("refuses a stray flag where the tag belongs, naming both", () => {
    expect(err(tagPositionError(["--freeze", "--typo"], "freeze"))).toBe(
      'Unknown flag "--typo" after --freeze - expected a tag.',
    );
    expect(err(tagPositionError(["--promote", "--to"], "promote"))).toBe(
      'Unknown flag "--to" after --promote - expected a tag.',
    );
  });
});

describe("parsePromoteTarget", () => {
  it("defaults to next when --to is absent", () => {
    expect(ok(parsePromoteTarget(["--promote", "v1.2.3"]))).toBe("next");
  });

  it("reads the value after --to, not the flag", () => {
    expect(
      ok(parsePromoteTarget(["--promote", "v1.2.3", "--to", "stable"])),
    ).toBe("stable");
  });

  // Every ring is nameable here, `edge` included - the real guards are the tag
  // gate, `--require-serving` and the byte-identity check, not this parser.
  it.each(["edge", "next", "stable"])("accepts the ring %s", (ring) => {
    expect(ok(parsePromoteTarget(["--promote", "v1.2.3", "--to", ring]))).toBe(
      ring,
    );
  });

  // THE MUTATION THAT COSTS THE MOST: falling back to `next` on a bad value
  // rather than refusing. `--to stabel` would then advance the candidate ring
  // while the operator believed they had promoted to the install base, and every
  // gate downstream would agree, because they are handed this answer.
  it("refuses an unknown ring rather than falling back to the default", () => {
    expect(
      err(parsePromoteTarget(["--promote", "v1.2.3", "--to", "stabel"])),
    ).toBe('--to must name a ring: edge, next or stable (got "stabel").');
  });

  it("refuses a --to with nothing after it", () => {
    expect(err(parsePromoteTarget(["--promote", "v1.2.3", "--to"]))).toContain(
      'got ""',
    );
  });

  // A trailing flag is not a ring. Without this `--to --require-serving next`
  // would have to be caught by `isRing`, and it is - stated here so the case
  // cannot regress into a fallback.
  it("refuses another flag as the ring", () => {
    expect(
      err(
        parsePromoteTarget([
          "--promote",
          "v1.2.3",
          "--to",
          "--require-serving",
        ]),
      ),
    ).toContain("--require-serving");
  });
});

describe("parseRequireServing", () => {
  // `null`, not an error: the flag is optional, and the publish and freeze modes
  // never pass it at all.
  it("is null when the flag is absent", () => {
    expect(parseRequireServing(["--promote", "v1.2.3"])).toBeNull();
  });

  it("reads the ring after the flag", () => {
    expect(
      ok(
        parseRequireServing([
          "--promote",
          "v1.2.3",
          "--require-serving",
          "next",
        ]),
      ),
    ).toBe("next");
  });

  it("refuses an unknown ring", () => {
    expect(
      err(
        parseRequireServing([
          "--promote",
          "v1.2.3",
          "--require-serving",
          "nope",
        ]),
      ),
    ).toBe(
      '--require-serving must name a ring: edge, next or stable (got "nope").',
    );
  });

  it("refuses the flag with no value", () => {
    expect(
      err(parseRequireServing(["--promote", "v1.2.3", "--require-serving"])),
    ).toContain('got ""');
  });

  // Both flags in one argv, which is what the promote lane really passes.
  it("reads its own flag when --to is present too", () => {
    const argv = [
      "--promote",
      "v1.2.3",
      "--to",
      "stable",
      "--require-serving",
      "next",
    ];
    expect(ok(parseRequireServing(argv))).toBe("next");
    expect(ok(parsePromoteTarget(argv))).toBe("stable");
  });
});

describe("computeAdvanceTargets", () => {
  // THE WHOLE POINT OF --freeze. It publishes the immutable `cli/<tag>/` prefix
  // and moves no pointer at all, which is how a release is staged before anyone
  // is asked to receive it. Anything but `[]` here advances a ring the operator
  // explicitly asked it not to.
  it("advances nothing on a freeze", () => {
    expect(ok(computeAdvanceTargets("freeze", ["--freeze", "v1.2.3"]))).toEqual(
      [],
    );
  });

  // A bare publish reproduces the release job's routing: the candidate ring, and
  // never the one the whole install base follows.
  it("advances only cli/next on a bare publish", () => {
    expect(ok(computeAdvanceTargets("publish", ["v1.2.3"]))).toEqual(["next"]);
  });

  // A case feeding `["v1.2.3", "--to", "stable"]` to the publish branch used to
  // sit here, titled "ignores a stray --to". It was removed, and the reason is
  // worth stating so it does not come back: the publish branch returns `["next"]`
  // WITHOUT reading argv, so that case exercised no branch the case above does
  // not, and `upload-release-blob.ts` refuses the shape outright before the
  // router is ever reached ("--to is only valid with --promote."). Its real cost
  // was the title - it read as the router defending against a stray `--to`,
  // which could talk a future reader into relaxing the upstream guard that is
  // actually doing the work.

  it("advances the promote's target, defaulting to next", () => {
    expect(
      ok(computeAdvanceTargets("promote", ["--promote", "v1.2.3"])),
    ).toEqual(["next"]);
    expect(
      ok(
        computeAdvanceTargets("promote", [
          "--promote",
          "v1.2.3",
          "--to",
          "stable",
        ]),
      ),
    ).toEqual(["stable"]);
  });

  // Exactly one pointer per run. Two would make the summary, the barrier and the
  // record verify each iterate a set the operator never asked for.
  it("names exactly one target whenever it names any", () => {
    for (const mode of ["publish", "promote"] as Mode[]) {
      const argv = mode === "promote" ? ["--promote", "v1.2.3"] : ["v1.2.3"];
      expect(ok(computeAdvanceTargets(mode, argv))).toHaveLength(1);
    }
  });

  // The refusal has to survive the wrapper: a `--to` typo must not become
  // `["next"]` on its way through here.
  it("propagates a bad --to instead of routing to the default", () => {
    const out = computeAdvanceTargets("promote", [
      "--promote",
      "v1.2.3",
      "--to",
      "prod",
    ]);
    expect(err(out)).toContain("--to must name a ring");
  });
});
