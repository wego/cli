/**
 * PLATFORM COVERAGE: the release runs the replace code it is shipping, on both
 * platforms this lane gates, asserted.
 *
 * Two failures hide here, and both leave a green lane:
 *
 *  1. TIMING, every platform. Until `--force-replace`, no release executed its own
 *     `downloadAndReplace`: SMOKE 3 runs the PREDECESSOR's copy, SMOKE 4 returns on
 *     the up-to-date branch above it. The shipping build's replace half first ran a
 *     release later, after publication.
 *  2. PLATFORM, macOS only. The replace code is compiled per target and one line -
 *     `if (os === "darwin") await deps.clearQuarantine(tmp)` - is unreachable from
 *     any Linux runner, at any release. That is the wego/cli#25 shape: every check
 *     passes and none of them runs the thing that breaks.
 *
 * Both are closed by a flag and a job, which makes them exactly the kind of thing a
 * later edit removes without meaning to:
 *
 *   - the macOS job dropped ("the release takes 20 minutes and macOS runners bill
 *     at 10x") -> failure 2 is back, and every release still green.
 *   - `--force-replace` dropped from either leg, or swapped for the sibling step's
 *     `--expect-unchanged` ("the ring already serves these bytes, why force?") ->
 *     the step runs, costs the minutes, and returns on the up-to-date branch
 *     without reaching the replace. Green, and proving nothing.
 *   - the macOS asset pointed back at a linux binary -> the job cannot even execute
 *     it, which at least fails loudly; asserted anyway, because the failure would
 *     read as a runner problem rather than as a coverage one.
 *
 * ASSERTED BY PROPERTY, NOT BY NAME: nothing here pins the string "replace-macos".
 * The claim is "this lane runs the self-update gate in a real-swap mode on both a
 * Linux and a macOS runner, each against its own asset" - rename or restructure
 * freely.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

interface Step {
  uses?: string;
  run?: string;
}
interface Job {
  "runs-on"?: string;
  permissions?: Record<string, string>;
  environment?: unknown;
  steps?: Step[];
}
interface Workflow {
  jobs: Record<string, Job>;
}

const LANE = "release-cli.yml";
const GATE = "scripts/assert-self-update.ts";

const wf = Bun.YAML.parse(
  readFileSync(`.github/workflows/${LANE}`, "utf8"),
) as Workflow;

/** Jobs whose steps invoke the self-update gate, with the runner they run on. */
function gateJobs(): { name: string; job: Job; runs: string; body: string }[] {
  return Object.entries(wf.jobs)
    .map(([name, job]) => ({
      name,
      job,
      runs: job["runs-on"] ?? "",
      body: (job.steps ?? [])
        .map((s) => s.run ?? "")
        .filter((r) => r.includes(GATE))
        .join("\n"),
    }))
    .filter((j) => j.body !== "");
}

/** The gate legs running on macOS - what this file is about. */
function macLegs(): ReturnType<typeof gateJobs> {
  return gateJobs().filter((j) => j.runs.startsWith("macos-"));
}

describe(`${LANE}: the shipping build's replace code is executed`, () => {
  it("forces a real swap on linux-x64, in the job that builds and publishes", () => {
    // Closes the timing gap: without this the release ships replace code whose
    // first execution is a consumer's machine, or the NEXT release's SMOKE 3.
    const linux = gateJobs().filter((j) => j.runs.startsWith("ubuntu-"));
    expect(linux.some((j) => j.body.includes("--force-replace"))).toBe(true);
    expect(linux.some((j) => j.body.includes("wego-linux-x64"))).toBe(true);
  });

  it("runs the self-update gate on a macOS runner", () => {
    expect(macLegs()).not.toEqual([]);
  });

  it("drives a REAL swap there, against the darwin asset", () => {
    for (const leg of macLegs()) {
      // --force is the only way past the up-to-date branch when the ring already
      // serves these bytes, which it does by the time this job runs.
      expect(leg.body).toContain("--force-replace");
      expect(leg.body).toMatch(/wego-darwin-(arm64|x64)\b/);
      // The opposite claim. Mutually exclusive in the script too, which errors -
      // this catches the lane asking for it at all.
      expect(leg.body).not.toContain("--expect-unchanged");
    }
  });

  it("keeps the up-to-date assertion alongside it, not instead of it", () => {
    // Two claims, one per step, and a forced run cannot make the first: only an
    // unforced run proves `update`'s OWN comparison concluded "already current"
    // against the ring. Collapsing the pair into one forced step would silently
    // drop that.
    const linux = gateJobs().filter((j) => j.runs.startsWith("ubuntu-"));
    expect(linux.some((j) => j.body.includes("--expect-unchanged"))).toBe(true);
  });

  it("gives the macOS job neither capability the lane guards", () => {
    // It executes a release binary against the public route and needs nothing
    // else: no store token to write a ring with, no OIDC token to sign with.
    for (const leg of macLegs()) {
      expect(leg.job.permissions?.["id-token"]).toBeUndefined();
      expect(leg.job.environment).toBeUndefined();
      expect(JSON.stringify(leg.job)).not.toContain("BLOB_READ_WRITE_TOKEN");
    }
  });
});
