/**
 * The routing decision on the lane that writes `cli/stable`.
 *
 * Everything downstream (the crossed-pair guard, the consistency barrier, the
 * signed-record verify, the summary) iterates `advanceTargets` rather than
 * re-deriving it, so a wrong answer here is not caught later.
 *
 * The mutations this suite kills:
 *   - `--freeze` routed to anything but `[]`: it advances a pointer the
 *     operator asked it to leave alone.
 *   - the bare-publish default flipped to `stable`: a fresh build lands in
 *     front of the whole install base instead of the candidate ring.
 *   - `--to` defaulting to the last ring rather than `next`, or reading the flag
 *     rather than its value.
 *   - a bad ring falling through as `next` instead of refusing: `--to stabel`
 *     silently advances the wrong pointer.
 *   - the two `--` guards swapped, so a typo'd mode flag is reported as a bad
 *     tag.
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

function err(v: unknown): string {
  if (!isArgvError(v)) throw new Error(`expected a refusal, got: ${String(v)}`);
  return v.error;
}

describe("parseMode", () => {
  it("reads the two mode flags", () => {
    expect(parseMode("--promote")).toBe("promote");
    expect(parseMode("--freeze")).toBe("freeze");
  });

  // The bare form is `upload-release-blob.ts v1.2.3`, so anything that is not
  // one of the two flags is a publish. That is why `leadingFlagError` matters:
  // without it an unrecognised flag becomes the tag.
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

  // `--to` and `--require-serving` are legitimate flags further along, so a
  // guard that scanned the whole argv would refuse every promote.
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

  // `edge` included: the real guards are the tag gate, `--require-serving` and
  // the byte-identity check, not this parser.
  it.each(["edge", "next", "stable"])("accepts the ring %s", (ring) => {
    expect(ok(parsePromoteTarget(["--promote", "v1.2.3", "--to", ring]))).toBe(
      ring,
    );
  });

  // Falling back to `next` here would make `--to stabel` advance the candidate
  // ring while the operator believed they had promoted to stable, and no
  // downstream gate would notice.
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
  // `--freeze` publishes the immutable `cli/<tag>/` prefix and moves no
  // pointer, which is how a release is staged before anyone receives it.
  it("advances nothing on a freeze", () => {
    expect(ok(computeAdvanceTargets("freeze", ["--freeze", "v1.2.3"]))).toEqual(
      [],
    );
  });

  // A bare publish reproduces the release job's routing: the candidate ring, and
  // never the one the whole install base follows.
  //
  // There is deliberately no "ignores a stray --to" case for the publish branch:
  // it never reads argv, and `upload-release-blob.ts` refuses that shape before
  // the router is reached ("--to is only valid with --promote."). Such a case
  // would suggest the router is the guard, when the upstream check is.
  it("advances only cli/next on a bare publish", () => {
    expect(ok(computeAdvanceTargets("publish", ["v1.2.3"]))).toEqual(["next"]);
  });

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
