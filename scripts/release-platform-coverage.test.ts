/**
 * Platform coverage: linux-x64 and darwin-arm64 make the same claims.
 *
 * Three failures can each leave a release green:
 *
 *  1. Timing, every platform. Without `--force-replace` no release executes its
 *     own `downloadAndReplace`: SMOKE 3 runs the predecessor's copy, and SMOKE 4
 *     returns on the up-to-date branch before it. The shipping build's replace
 *     code would first run a release later, after publication.
 *  2. Platform, macOS only. The replace code is compiled per target, and
 *     `if (os === "darwin") await deps.clearQuarantine(tmp)` is unreachable from
 *     any Linux runner. That is the wego/cli#25 shape: every check passes and
 *     none runs the thing that breaks.
 *  3. Half the claims. A darwin version-parse bug that makes an up-to-date binary
 *     think it is behind passes a forced replace, and is caught only by the
 *     unforced comparison.
 *
 * Each is closed by a flag, step or job that a later edit could remove:
 *
 *   - the macOS job dropped (it is slow and expensive): failure 2 returns.
 *   - `--force-replace` dropped from either leg, or swapped for
 *     `--expect-unchanged`: the step returns on the up-to-date branch without
 *     reaching the replace.
 *   - a darwin leg deleted as redundant with linux: failure 3.
 *   - the darwin arriving leg ungated from the linux one: on a first release, or
 *     a ring not serving a complete set, linux skips SMOKE 3 and darwin invents a
 *     predecessor. The two must skip together.
 *   - the macOS asset pointed at a linux binary: it fails loudly, but reads as a
 *     runner problem rather than a coverage one.
 *
 * Asserted by property, not by job name, so jobs can be renamed or restructured.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

interface Step {
  name?: string;
  shell?: string;
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
/** The one definition both platform legs call. The assertions follow the
 *  claims into the action and ask the same questions of each resolved leg. */
const ACTION = ".github/actions/verify-replace/action.yml";
const ACTION_REF = "./.github/actions/verify-replace";
/** The pre-publication half. Everything that gates the store lives here. */
const BUILD_ACTION = ".github/actions/verify-build/action.yml";
const BUILD_REF = "./.github/actions/verify-build";
/** The install contract: the installer writes a record, this build reads it. */
const INSTALL = "scripts/install-smoke.sh";
/** The up-to-date / replace gate. Drives `wego update` from a built asset. */
const GATE = "scripts/assert-self-update.ts";
/** The arriving gate. Drives a published predecessor's own `wego update`. */
const ARRIVE = "scripts/update-smoke.sh";

const wf = Bun.YAML.parse(
  readFileSync(`.github/workflows/${LANE}`, "utf8"),
) as Workflow;

interface Action {
  inputs?: Record<string, { default?: string }>;
  runs: { steps?: Step[] };
}
const action = Bun.YAML.parse(readFileSync(ACTION, "utf8")) as Action;
const buildAction = Bun.YAML.parse(
  readFileSync(BUILD_ACTION, "utf8"),
) as Action;
/** Resolve a `uses:` to the action it names, or undefined for a plain step. */
const actionFor = (uses?: string): Action | undefined =>
  uses === ACTION_REF ? action : uses === BUILD_REF ? buildAction : undefined;

/** Substitute a calling step's `with:` (falling back to the action's declared
 *  defaults) into an action step's text, so a resolved leg reads
 *  `wego-darwin-arm64`, not `${{ inputs.asset }}`. */
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
 * individual steps. Per-step matters: `--force-replace` and
 * `--expect-unchanged` are mutually exclusive within one invocation but both are
 * wanted in one job, so a job-wide string search cannot tell "two correct steps"
 * from "one contradictory one".
 */
function legs(tool: string): Leg[] {
  return Object.entries(wf.jobs).flatMap(([job, j]) =>
    (j.steps ?? []).flatMap((s) => {
      // A step that delegates to an action stands for the action's own steps,
      // attributed to the job that called it.
      const act = actionFor(s.uses);
      const steps: Step[] = act ? (act.runs.steps ?? []) : [s];
      const withs = (s.with ?? {}) as Record<string, unknown>;
      const resolve = (t: string) => (act ? resolveInputs(t, withs) : t);
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
      // Without --require-replace a rerun past the advance captures this release as
      // its own predecessor, swaps nothing, and passes. Checked on every leg: with
      // `some`, dropping the flag from one platform would go unnoticed.
      for (const leg of arriving) {
        expect(leg.body).toContain("--require-replace");
      }
    });

    it("proves a machine can LEAVE it (SMOKE 4)", () => {
      // Only an unforced run proves `update`'s own comparison concluded "already
      // current" against the ring. A forced run skips that, so SMOKE 5 cannot
      // stand in for this.
      const leaving = legs(GATE).filter(
        (l) => onPlatform(l) && l.body.includes("--expect-unchanged"),
      );
      expect(leaving).not.toEqual([]);
      expect(leaving.some((l) => asset.test(l.body))).toBe(true);
    });

    it("executes the replace code THIS BUILD ships (SMOKE 5)", () => {
      // Without this the release ships replace code whose first execution is a
      // consumer's machine, or the next release's SMOKE 3.
      const replacing = legs(GATE).filter(
        (l) => onPlatform(l) && l.body.includes("--force-replace"),
      );
      expect(replacing).not.toEqual([]);
      expect(replacing.some((l) => asset.test(l.body))).toBe(true);
    });
  });

  it("never asks one invocation for both mutually exclusive claims", () => {
    // The script errors on this pairing. Asserted here so the lane is caught asking
    // for it before a release spends the minutes to reach the error.
    for (const leg of legs(GATE)) {
      const both =
        leg.body.includes("--force-replace") &&
        leg.body.includes("--expect-unchanged");
      expect(both).toBe(false);
    }
  });

  it("skips the arriving legs together, never one without the other", () => {
    // Both read the same capture. On a first release, or a ring not serving a
    // complete set, neither has a predecessor, so a darwin leg still running
    // there would be testing something it invented.
    const arriving = legs(ARRIVE);
    expect(arriving.length).toBeGreaterThanOrEqual(2);
    for (const leg of arriving) {
      expect(leg.step.if ?? "").toMatch(/usable/);
    }
  });

  it("captures the predecessor BEFORE the ring advances", () => {
    // This is why the darwin predecessor travels as an artifact: `cli/next` stops
    // serving it once the pointer moves, and the macOS job starts long after.
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
    // A rename on one side alone fails at download time, but during a release.
    // Cheaper to catch here.
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
    // would leave the other's install path untested.
    expect(legs(INSTALL).length).toBe(2);
    expect(legs(INSTALL).some(onLinux)).toBe(true);
    expect(legs(INSTALL).some(onMac)).toBe(true);
  });

  it("skips only the arriving gate when there is no predecessor", () => {
    // SMOKE 3 needs an older build to update from; 4, 5 and 6 do not. Gating the
    // whole action on the predecessor would silently drop three proofs on a first
    // release.
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
  /** Jobs that run the leave proof: `upgrade-path.sh … stable`, one hop. The proof
   *  lives in a composite action, so a job runs it by calling one; scanning job
   *  steps alone would find nothing and pass. */
  const runsLeave = (st: Step): boolean => {
    const bodies = (actionFor(st.uses)?.runs.steps ?? [st]).map(
      (x) => x.run ?? "",
    );
    return bodies.some(
      (b) =>
        b.includes("upgrade-path.sh") &&
        b.includes("stable") &&
        !b.includes("cli-v1.1.0"),
    );
  };
  const leaveJobs = Object.entries(wf.jobs)
    .filter(([, j]) => (j.steps ?? []).some(runsLeave))
    .map(([job]) => job);

  it("proves it on linux AND on macOS", () => {
    expect(leaveJobs).toHaveLength(2);
    const runners = leaveJobs.map((j) => wf.jobs[j]?.["runs-on"] ?? "");
    expect(runners.some((r) => r.startsWith("ubuntu-"))).toBe(true);
    expect(runners.some((r) => r.startsWith("macos-"))).toBe(true);
  });

  it("holds publication until the macOS leg has proved it", () => {
    // In a job downstream of `release`, a Mac that could not replace itself would
    // be discovered with `cli/next` already serving the build, and `cli/next` has
    // no backward path.
    expect(needsOf("release")).toContain("leave-macos");
  });

  it("keeps that job UPSTREAM of publication, not merely beside it", () => {
    // A `needs: release` here would move the proof after publication while
    // leaving every other assertion in this file green.
    const upstream = needsOf("leave-macos");
    expect(upstream).not.toContain("release");
    expect(upstream).toEqual(expect.arrayContaining(["prepare", "build"]));
  });

  it("runs no leave proof downstream of publication", () => {
    // A proof that runs after the ring moved can only report damage; one that
    // runs before can prevent it.
    for (const job of leaveJobs) {
      expect(needsOf(job)).not.toContain("release");
    }
  });
});

/**
 * Parity: every check the lane runs on one platform must run on the other, at
 * the same stage. A check before publication prevents a bad build reaching
 * anyone; the same check after the ring advanced can only report the damage,
 * because `cli/next` has no backward path.
 *
 * A check is identified by what a step invokes, not its name: the legs name the
 * same check differently ("Smoke test built binaries" vs "...(darwin-arm64)").
 * Name rules come first, because several steps mention `cli-v1.1.0` or
 * `SHA256SUMS.txt` in their error messages and a content rule alone mis-bins
 * them.
 *
 * Adding a check? Add it here too. An entry missing from this list is not
 * compared, so parity could regress without this turning red.
 */
const PARITY_CHECKS: [string, (body: string, name: string) => boolean][] = [
  [
    "user-agent / legacy bridge pin",
    (_b, n) => /distinguishable from a pre-relay/i.test(n),
  ],
  [
    "built binaries run at all",
    (_b, n) => /^Smoke test built binaries/i.test(n),
  ],
  ["predecessor checksum verify", (_b, n) => /predecessor checksum/i.test(n)],
  [
    "manifest verify before execution",
    (b) =>
      /SHA256SUMS\.txt/.test(b) &&
      /shasum -a 256 -c|sha256sum -c|-c SHA256SUMS/.test(b),
  ],
  [
    "1.1.0 multi-hop",
    (b) => /upgrade-path\.sh/.test(b) && /cli-v1\.1\.0/.test(b),
  ],
  [
    "LEAVE · replace self with stable's bytes",
    (b) => /upgrade-path\.sh/.test(b) && /\bstable\b/.test(b),
  ],
  ["SMOKE 3 · predecessor can arrive", (b) => /update-smoke\.sh/.test(b)],
  [
    "SMOKE 4 · reports up to date",
    (b) => /assert-self-update/.test(b) && /--expect-unchanged/.test(b),
  ],
  [
    "SMOKE 5 · forced in-place replace",
    (b) => /assert-self-update/.test(b) && /--force-replace/.test(b),
  ],
  ["SMOKE 6 · install contract", (b) => /install-smoke\.sh/.test(b)],
];

interface Hit {
  plat: "linux" | "macos";
  stage: "pre-publish" | "post-advance";
  job: string;
}

function classify(): Map<string, Hit[]> {
  const found = new Map<string, Hit[]>();
  for (const [job, j] of Object.entries(wf.jobs)) {
    const runner = j["runs-on"] ?? "";
    const plat = runner.startsWith("ubuntu-")
      ? "linux"
      : runner.startsWith("macos-")
        ? "macos"
        : null;
    if (!plat) continue;
    const needs = Array.isArray(j.needs) ? j.needs : j.needs ? [j.needs] : [];
    const steps = j.steps ?? [];
    const pubIdx = steps.findIndex((st) =>
      (st.name ?? "").startsWith("Publish immutable artifact"),
    );
    steps.forEach((st, idx) => {
      const act = actionFor(st.uses);
      const inner: Step[] = act ? (act.runs.steps ?? []) : [st];
      const withs = (st.with ?? {}) as Record<string, unknown>;
      // A delegated step's stage is that of its call site. Both actions are
      // called from both platforms; what separates pre-publication from
      // post-advance is the position of the `uses:` step.
      const stage: Hit["stage"] =
        needs.includes("release") || (pubIdx >= 0 && idx > pubIdx)
          ? "post-advance"
          : "pre-publish";
      for (const one of inner) {
        const body = act
          ? resolveInputs(one.run ?? "", withs)
          : (one.run ?? "");
        const name = act
          ? resolveInputs(one.name ?? "", withs)
          : (one.name ?? "");
        if (!body && !name) continue;
        for (const [check, matches] of PARITY_CHECKS) {
          if (matches(body, name)) {
            if (!found.has(check)) found.set(check, []);
            found.get(check)?.push({ plat: plat as Hit["plat"], stage, job });
            break;
          }
        }
      }
    });
  }
  return found;
}

describe(`${LANE}: linux-x64 and darwin-arm64 run the same checks, at the same stage`, () => {
  const found = classify();

  // Not redundant with "leaves no check-bearing step body in the workflow
  // itself" plus "calls each action from both platforms". Those catch a check
  // vanishing from one leg, but not a step deleted from the shared action, which
  // removes it from both: then `hits` is empty, `offenders` is empty, the action
  // is still called from both runners, and the stage comparison reads
  // `false === false`. So presence is asserted, not inferred.
  for (const [check] of PARITY_CHECKS) {
    it(`runs on both platforms: ${check}`, () => {
      const hits = found.get(check) ?? [];
      const linux = hits.filter((h) => h.plat === "linux");
      const macos = hits.filter((h) => h.plat === "macos");
      expect(linux.length).toBeGreaterThan(0);
      expect(macos.length).toBeGreaterThan(0);
    });

    it(`gates publication on both platforms, or on neither: ${check}`, () => {
      // Not "same stage": a check may legitimately run in several jobs, and macOS
      // verifies the manifest in both of its jobs because each downloads its own
      // artifacts. What must match is whether the check stands between a bad
      // build and users.
      const hits = found.get(check) ?? [];
      const gates = (plat: Hit["plat"]) =>
        hits.some((h) => h.plat === plat && h.stage === "pre-publish");
      expect(gates("macos")).toBe(gates("linux"));
    });
  }
});

describe(`${LANE}: no check is written twice`, () => {
  it("leaves no check-bearing step body in the workflow itself", () => {
    // Drift is only possible where a check exists in two places. Every check
    // the parity list names is defined once in an action and called twice, so
    // this asserts there is no second copy rather than that two copies agree.
    const offenders: string[] = [];
    for (const [job, j] of Object.entries(wf.jobs)) {
      for (const st of j.steps ?? []) {
        if (actionFor(st.uses)) continue;
        const body = st.run ?? "";
        const name = st.name ?? "";
        if (!body) continue;
        for (const [check, matches] of PARITY_CHECKS) {
          if (matches(body, name)) offenders.push(`${job}: ${name} (${check})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("calls each action from both platforms", () => {
    for (const ref of [ACTION_REF, BUILD_REF]) {
      const callers = Object.values(wf.jobs)
        .filter((j) => (j.steps ?? []).some((st) => st.uses === ref))
        .map((j) => j["runs-on"] ?? "");
      expect(callers.some((r) => r.startsWith("ubuntu-"))).toBe(true);
      expect(callers.some((r) => r.startsWith("macos-"))).toBe(true);
    }
  });
});

describe("composite actions: one interpreter, on every runner", () => {
  it("declares `shell: bash` on every step", () => {
    // A composite step must name its shell; there is no default to inherit. Not
    // `sh`: the step bodies are written for bash (the workflow default,
    // `bash -e {0}`), and `/bin/sh` is dash on ubuntu but bash in POSIX mode on
    // macOS, a per-platform difference.
    //
    // The scripts these steps invoke keep their own `#!/bin/sh` and are called as
    // `sh scripts/...`. That is deliberate: the interpreter is named explicitly,
    // so it is the same on both platforms.
    const offenders: string[] = [];
    for (const [file, act] of [
      [ACTION, action],
      [BUILD_ACTION, buildAction],
    ] as const) {
      for (const st of act.runs.steps ?? []) {
        if (!st.run) continue;
        if (st.shell !== "bash") {
          offenders.push(
            `${file}: ${st.name ?? "(unnamed)"} → ${st.shell ?? "(none)"}`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe(`${LANE}: the platforms agree on WHEN a check runs, not only that it does`, () => {
  /** Whether a call site is guarded on something having been published. */
  const publishedGuard = (cond: string) =>
    /store_origin\s*!=\s*''/.test(cond) ? "guarded-on-published" : "unguarded";

  it("guards each action the same way on both platforms", () => {
    // A check that silently skips on one platform is not a check on that
    // platform. If only one leg guarded on `store_origin != ''`, a run that
    // published nothing would skip on one leg and fail on the other.
    for (const ref of [ACTION_REF, BUILD_REF]) {
      const byPlat = new Map<string, string[]>();
      for (const j of Object.values(wf.jobs)) {
        const runner = j["runs-on"] ?? "";
        const plat = runner.startsWith("ubuntu-")
          ? "linux"
          : runner.startsWith("macos-")
            ? "macos"
            : null;
        if (!plat) continue;
        for (const st of j.steps ?? []) {
          if (st.uses !== ref) continue;
          if (!byPlat.has(plat)) byPlat.set(plat, []);
          byPlat.get(plat)?.push(publishedGuard(st.if ?? ""));
        }
      }
      expect(byPlat.get("linux")).toEqual(byPlat.get("macos"));
    }
  });

  it("lets neither call site override the URL or the ring", () => {
    // Both are defaulted inside the action: the production install endpoint and
    // `next`. A caller that overrode either would change what the gate measures
    // without changing the gate, the same rule the smokes' install URL is held to.
    for (const j of Object.values(wf.jobs)) {
      for (const st of j.steps ?? []) {
        if (!actionFor(st.uses)) continue;
        const withs = (st.with ?? {}) as Record<string, unknown>;
        expect(withs["install-url"]).toBeUndefined();
        expect(withs.ring).toBeUndefined();
      }
    }
  });
});
