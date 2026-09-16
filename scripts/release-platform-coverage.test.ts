/**
 * PLATFORM COVERAGE: linux-x64 and darwin-arm64 make the SAME four claims, asserted.
 *
 * The lane gates two platforms, and until recently it tested one. Three failures
 * hide in the gap, and every one of them leaves a green release:
 *
 *  1. TIMING, every platform. Until `--force-replace`, no release executed its own
 *     `downloadAndReplace`: SMOKE 3 runs the PREDECESSOR's copy, SMOKE 4 returns on
 *     the up-to-date branch above it. The shipping build's replace half first ran a
 *     release later, after publication.
 *  2. PLATFORM, macOS only. The replace code is compiled per target and one line -
 *     `if (os === "darwin") await deps.clearQuarantine(tmp)` - is unreachable from
 *     any Linux runner, at any release. That is the wego/cli#25 shape: every check
 *     passes and none of them runs the thing that breaks.
 *  3. HALF A COLUMN. The macOS job initially made only the replace claim. A darwin
 *     version-parse bug that left an up-to-date binary believing it was behind -
 *     re-downloading itself on every invocation - passes a forced replace and is
 *     caught only by the unforced comparison, which darwin did not run.
 *
 * All three are closed by flags, steps and a job, which makes them exactly the kind
 * of thing a later edit removes without meaning to:
 *
 *   - the macOS job dropped ("the release takes 20 minutes and macOS runners bill
 *     at 10x") -> failure 2 is back, and every release still green.
 *   - `--force-replace` dropped from either leg, or swapped for the sibling step's
 *     `--expect-unchanged` ("the ring already serves these bytes, why force?") ->
 *     the step runs, costs the minutes, and returns on the up-to-date branch
 *     without reaching the replace. Green, and proving nothing.
 *   - a darwin leg deleted as "redundant with the linux one" -> failure 3, on
 *     whichever claim went.
 *   - the darwin arriving leg UNGATED from the linux one -> on a first release, or
 *     a ring not serving a complete set, linux skips SMOKE 3 and darwin invents a
 *     predecessor. The two must skip together.
 *   - the macOS asset pointed back at a linux binary -> the job cannot even execute
 *     it, which at least fails loudly; asserted anyway, because the failure would
 *     read as a runner problem rather than as a coverage one.
 *
 * ASSERTED BY PROPERTY, NOT BY NAME: nothing here pins the string "replace-macos".
 * The claim is "this lane makes each of the arriving, up-to-date and replace claims
 * on both a Linux and a macOS runner, each against its own asset" - rename or
 * restructure freely.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  "runs-on"?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  environment?: unknown;
  outputs?: Record<string, string>;
  steps?: Step[];
}
interface Workflow {
  jobs: Record<string, Job>;
}

const LANE = "release-cli.yml";
/** The one definition both platform legs call. Before it existed, every gate
 *  below was written twice — inline for linux-x64 and copied into the macOS job —
 *  and this file's whole job was to notice when the two copies drifted. They can
 *  no longer drift, so the assertions now follow the claims into the action and
 *  ask the same questions of the resolved leg. */
const ACTION = ".github/actions/verify-replace/action.yml";
const ACTION_REF = "./.github/actions/verify-replace";
/** The install contract: the installer writes a record, this build reads it. */
const INSTALL = "scripts/install-smoke.sh";
/** The up-to-date / replace gate. Drives `wego update` from a built asset. */
const GATE = "scripts/assert-self-update.ts";
/** The arriving gate. Drives a PUBLISHED PREDECESSOR's own `wego update`. */
const ARRIVE = "scripts/update-smoke.sh";

const wf = Bun.YAML.parse(
  readFileSync(`.github/workflows/${LANE}`, "utf8"),
) as Workflow;

interface Action {
  inputs?: Record<string, { default?: string }>;
  runs: { steps?: Step[] };
}
const action = Bun.YAML.parse(readFileSync(ACTION, "utf8")) as Action;

/** Substitute a calling step's `with:` (falling back to the action's declared
 *  defaults) into an action step's text, so a resolved leg reads exactly as the
 *  inline copy it replaced — `wego-darwin-arm64`, not `${{ inputs.asset }}`. */
function resolveInputs(text: string, withs: Record<string, unknown>): string {
  return text.replace(/\$\{\{\s*inputs\.([a-z-]+)\s*\}\}/g, (_m, key: string) =>
    String(withs[key] ?? action.inputs?.[key]?.default ?? ""),
  );
}

interface Leg {
  job: string;
  runs: string;
  step: Step;
  body: string;
}

/**
 * Every step that runs one of the two gates, flattened across jobs and kept as
 * INDIVIDUAL steps. Per-step is load-bearing: `--force-replace` and
 * `--expect-unchanged` are mutually exclusive within one invocation but both are
 * wanted in one job, so a job-wide string search cannot tell "two correct steps"
 * from "one contradictory one".
 */
function legs(tool: string): Leg[] {
  return Object.entries(wf.jobs).flatMap(([job, j]) =>
    (j.steps ?? []).flatMap((s) => {
      // A step that delegates to the action stands for the action's own steps,
      // attributed to the job that called it — which is what keeps "does the
      // darwin leg prove SMOKE 5" a question about the lane and not about a file.
      const steps: Step[] =
        s.uses === ACTION_REF ? (action.runs.steps ?? []) : [s];
      const withs = (s.with ?? {}) as Record<string, unknown>;
      const resolve = (t: string) =>
        s.uses === ACTION_REF ? resolveInputs(t, withs) : t;
      return steps
        .filter((step) => resolve(step.run ?? "").includes(tool))
        .map((step) => ({
          job,
          runs: j["runs-on"] ?? "",
          step,
          // env is part of the body on purpose: the arriving legs name their asset
          // in `OLD_BINARY` rather than inline, so a run-only search would report a
          // leg pointed at the wrong platform's binary as correct.
          body: [step.run ?? "", ...Object.values(step.env ?? {})]
            .map((t) => resolve(String(t)))
            .join("\n"),
        }));
    }),
  );
}

const onLinux = (l: Leg) => l.runs.startsWith("ubuntu-");
const onMac = (l: Leg) => l.runs.startsWith("macos-");
const DARWIN = /wego-darwin-(arm64|x64)\b/;

/** The jobs holding a macOS gate leg - what the capability assertions are about. */
function macJobs(): Job[] {
  const names = new Set(
    [...legs(GATE), ...legs(ARRIVE)].filter(onMac).map((l) => l.job),
  );
  return [...names].map((n) => wf.jobs[n] as Job);
}

describe(`${LANE}: linux-x64 and darwin-arm64 make the same claims`, () => {
  it("runs both gates on a macOS runner at all", () => {
    // The cheapest thing to delete, and the one whose absence is silent.
    expect(legs(GATE).filter(onMac)).not.toEqual([]);
    expect(legs(ARRIVE).filter(onMac)).not.toEqual([]);
  });

  describe.each([
    ["linux-x64", onLinux, /wego-linux-x64\b/],
    ["darwin-arm64", onMac, DARWIN],
  ] as const)("%s", (_label, onPlatform, asset) => {
    it("proves a machine can ARRIVE at this release (SMOKE 3)", () => {
      // The predecessor's own code pulls these bytes in. Old, frozen code - so a
      // failure is a fact about consumers on the previous build, not about this one.
      const arriving = legs(ARRIVE).filter(onPlatform);
      expect(arriving).not.toEqual([]);
      expect(arriving.some((l) => asset.test(l.body))).toBe(true);
      // Without --require-replace a rerun past the advance captures THIS release as
      // its own predecessor, swaps nothing, and passes having measured nothing.
      // EVERY leg, not just one: with `some`, dropping the flag from one platform
      // leaves the other one holding the assertion up for both.
      for (const leg of arriving) {
        expect(leg.body).toContain("--require-replace");
      }
    });

    it("proves a machine can LEAVE it (SMOKE 4)", () => {
      // Only an unforced run proves `update`'s OWN comparison concluded "already
      // current" against the ring. A forced run skips that by construction, so
      // SMOKE 5 cannot stand in for this.
      const leaving = legs(GATE).filter(
        (l) => onPlatform(l) && l.body.includes("--expect-unchanged"),
      );
      expect(leaving).not.toEqual([]);
      expect(leaving.some((l) => asset.test(l.body))).toBe(true);
    });

    it("executes the replace code THIS BUILD ships (SMOKE 5)", () => {
      // Closes the timing gap: without this the release ships replace code whose
      // first execution is a consumer's machine, or the NEXT release's SMOKE 3.
      const replacing = legs(GATE).filter(
        (l) => onPlatform(l) && l.body.includes("--force-replace"),
      );
      expect(replacing).not.toEqual([]);
      expect(replacing.some((l) => asset.test(l.body))).toBe(true);
    });
  });

  it("never asks one invocation for both mutually exclusive claims", () => {
    // The script errors on this pairing. Asserted here so the LANE is caught asking
    // for it, rather than a release burning the minutes to reach the error.
    for (const leg of legs(GATE)) {
      const both =
        leg.body.includes("--force-replace") &&
        leg.body.includes("--expect-unchanged");
      expect(both).toBe(false);
    }
  });

  it("skips the arriving legs together, never one without the other", () => {
    // Both read the SAME capture. First release, or a ring not serving a complete
    // set, and neither has a predecessor - so a darwin leg still running there
    // would be testing something it invented.
    const arriving = legs(ARRIVE);
    expect(arriving.length).toBeGreaterThanOrEqual(2);
    for (const leg of arriving) {
      expect(leg.step.if ?? "").toMatch(/usable/);
    }
  });

  it("captures the predecessor BEFORE the ring advances", () => {
    // The window is the whole reason the darwin predecessor travels as an artifact:
    // `cli/next` stops serving it the instant the pointer moves, and the macOS job
    // does not start until long after that.
    const steps = Object.values(wf.jobs).flatMap((j) => j.steps ?? []);
    const capture = steps.findIndex((s) =>
      /Capture the predecessor/i.test(s.name ?? ""),
    );
    const advance = steps.findIndex((s) =>
      /Advance cli\/next/i.test(s.name ?? ""),
    );
    expect(capture).toBeGreaterThanOrEqual(0);
    expect(advance).toBeGreaterThanOrEqual(0);
    expect(capture).toBeLessThan(advance);
  });

  it("hands the darwin predecessor over under a name both sides agree on", () => {
    // A rename on one side alone fails loudly at download time rather than silently,
    // but it fails DURING a release. Cheaper to catch here.
    const artifactName = (pred: (u: string) => boolean) =>
      Object.values(wf.jobs)
        .flatMap((j) => j.steps ?? [])
        .filter((s) => pred(s.uses ?? ""))
        .map((s) => s.with?.name)
        .filter((n): n is string => typeof n === "string");

    const uploaded = artifactName((u) =>
      u.startsWith("actions/upload-artifact"),
    );
    const downloaded = artifactName((u) =>
      u.startsWith("actions/download-artifact"),
    );
    const predecessor = uploaded.filter((n) => /predecessor/i.test(n));
    expect(predecessor).not.toEqual([]);
    for (const name of predecessor) expect(downloaded).toContain(name);
  });

  it("gives the macOS job neither capability the lane guards", () => {
    // It executes release binaries against the public route and needs nothing else:
    // no store token to write a ring with, no OIDC token to sign with.
    for (const job of macJobs()) {
      expect(job.permissions?.["id-token"]).toBeUndefined();
      expect(job.environment).toBeUndefined();
      expect(JSON.stringify(job)).not.toContain("BLOB_READ_WRITE_TOKEN");
    }
  });
});

describe(`${ACTION}: one definition, so the legs cannot drift`, () => {
  const callers = Object.entries(wf.jobs).flatMap(([job, j]) =>
    (j.steps ?? [])
      .filter((s) => s.uses === ACTION_REF)
      .map((s) => ({ job, runs: j["runs-on"] ?? "", with: s.with ?? {} })),
  );

  it("is called by both platform legs and by nothing else", () => {
    expect(callers.length).toBe(2);
    expect(callers.some((c) => c.runs.startsWith("ubuntu-"))).toBe(true);
    expect(callers.some((c) => c.runs.startsWith("macos-"))).toBe(true);
  });

  it("is called for a different asset on each leg", () => {
    const assets = callers.map((c) => String(c.with.asset));
    expect(new Set(assets).size).toBe(2);
    expect(assets).toContain("wego-linux-x64");
    expect(assets.some((a) => DARWIN.test(a))).toBe(true);
  });

  it("carries every gate, so neither leg can be missing one", () => {
    const bodies = (action.runs.steps ?? []).map((s) => s.run ?? "").join("\n");
    for (const tool of [ARRIVE, GATE, INSTALL]) {
      expect(bodies).toContain(tool);
    }
  });

  it("executes the install contract on both platforms (SMOKE 6)", () => {
    // The installer's own `uname` mapping picks the asset, so darwin and linux
    // take different paths through the script it serves. Running it on one leg
    // would leave the other's install path as untested as it was before.
    expect(legs(INSTALL).length).toBe(2);
    expect(legs(INSTALL).some(onLinux)).toBe(true);
    expect(legs(INSTALL).some(onMac)).toBe(true);
  });

  it("skips only the arriving gate when there is no predecessor", () => {
    // SMOKE 3 needs an older build to update FROM; 4, 5 and 6 do not. Gating the
    // whole action on the predecessor would silently drop three proofs on a first
    // release, which is exactly when a lane most wants them.
    const gated = (action.runs.steps ?? []).filter((s) =>
      (s.if ?? "").includes("prev-usable"),
    );
    // Two, and they are the arriving pair: verify the predecessor's checksum, then
    // run it. With no predecessor there is nothing to verify and nothing to run.
    expect(gated.length).toBe(2);
    expect(gated.some((s) => (s.run ?? "").includes(ARRIVE))).toBe(true);
    // The three that do not need one stay ungated.
    for (const tool of [GATE, INSTALL]) {
      expect(gated.some((s) => (s.run ?? "").includes(tool))).toBe(false);
    }
  });
});

describe(`${LANE}: nothing publishes until BOTH platforms can leave`, () => {
  const needsOf = (job: string): string[] => {
    const n = wf.jobs[job]?.needs;
    return n === undefined ? [] : Array.isArray(n) ? n : [n];
  };
  /** Jobs that run the leave proof: `upgrade-path.sh … stable`, one hop. */
  const leaveJobs = Object.entries(wf.jobs)
    .filter(([, j]) =>
      (j.steps ?? []).some(
        (st) =>
          (st.run ?? "").includes("upgrade-path.sh") &&
          (st.run ?? "").includes("stable"),
      ),
    )
    .map(([job]) => job);

  it("proves it on linux AND on macOS", () => {
    expect(leaveJobs).toHaveLength(2);
    const runners = leaveJobs.map((j) => wf.jobs[j]?.["runs-on"] ?? "");
    expect(runners.some((r) => r.startsWith("ubuntu-"))).toBe(true);
    expect(runners.some((r) => r.startsWith("macos-"))).toBe(true);
  });

  it("holds publication until the macOS leg has proved it", () => {
    // The whole point. This proof used to run in `replace-macos`, downstream of
    // `release` — so a Mac that could not replace itself was discovered with
    // `cli/next` already serving the build, and `cli/next` has no backward path.
    expect(needsOf("release")).toContain("leave-macos");
  });

  it("keeps that job UPSTREAM of publication, not merely beside it", () => {
    // A `needs: release` here would restore the old ordering while leaving every
    // other assertion in this file green.
    const upstream = needsOf("leave-macos");
    expect(upstream).not.toContain("release");
    expect(upstream).toEqual(expect.arrayContaining(["prepare", "build"]));
  });

  it("runs no leave proof downstream of publication", () => {
    // Where the proof RUNS decides what a failure costs. One that runs after the
    // ring moved can only report damage; one that runs before can prevent it.
    for (const job of leaveJobs) {
      expect(needsOf(job)).not.toContain("release");
    }
  });
});
