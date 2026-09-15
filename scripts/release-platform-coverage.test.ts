/**
 * PLATFORM COVERAGE: the replace path is exercised on macOS, asserted.
 *
 * `update`'s replace half is compiled per platform and has one branch Linux
 * never reaches - `if (os === "darwin") await deps.clearQuarantine(tmp)` - so
 * for as long as every gate in the release lane ran linux-x64, a darwin-only bug
 * in the swap shipped GREEN. That is the wego/cli#25 shape: a lane where every
 * check passes and none of them runs the thing that breaks.
 *
 * The leg that closes it is one job and two flags, which makes it exactly the
 * kind of thing a later edit removes without meaning to:
 *
 *   - the macOS job dropped ("the release takes 20 minutes and macOS runners
 *     bill at 10x") -> no platform coverage, and every release still green.
 *   - `--force-replace` dropped, or swapped for the linux leg's
 *     `--expect-unchanged` ("the ring already serves these bytes, why force?")
 *     -> the job runs, costs the minutes, and returns on the up-to-date branch
 *     without ever reaching the replace. Green, and proving nothing.
 *   - the asset pointed back at a linux binary -> the job cannot even execute it,
 *     which at least fails loudly; asserted anyway, because the failure would
 *     read as a runner problem rather than as a coverage one.
 *
 * ASSERTED BY PROPERTY, NOT BY NAME: nothing here pins the string
 * "replace-macos". The claim is "some job in this lane runs the self-update gate
 * on a macOS runner, against a darwin asset, in a mode that performs a real
 * swap" - rename or restructure freely.
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

describe(`${LANE}: the replace path is exercised on macOS`, () => {
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

  it("keeps the arriving-direction leg on the runner-native binary", () => {
    // The linux leg is not replaced by the macOS one: it asserts the ring is
    // serving these exact bytes ("already up to date"), which the forced swap
    // deliberately bypasses.
    const linux = gateJobs().filter((j) => j.runs.startsWith("ubuntu-"));
    expect(linux.some((j) => j.body.includes("--expect-unchanged"))).toBe(true);
    expect(linux.some((j) => j.body.includes("wego-linux-x64"))).toBe(true);
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
