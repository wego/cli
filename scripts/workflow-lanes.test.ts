/**
 * The two lanes that write `cli/stable`, and the separation between them.
 *
 * `promote-cli.yml` moves `stable` onto what `cli/next` serves. `rollback-cli.yml`
 * moves it onto a named earlier release. A single workflow with a boolean
 * (`allow_not_next`) that subtracted gates made every new gate remember to opt
 * rollback out: wego/cli#48 added two `cli/next`-coupled gates without the guard,
 * and both broke every rollback unnoticed, because nothing exercises a rollback
 * until an incident. Separate files mean promote has no mode to forget and
 * rollback has nothing to couple to; these assertions keep it that way.
 *
 * Asserted against the parsed workflow, not the file text: `Bun.YAML.parse` drops
 * comments, and prose naming `cli/next` or `allow_not_next` is documentation, not
 * coupling. What must not appear is an executable reference (a `run` body, an
 * `if`, a `with`).
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

const workflow = (file: string): unknown =>
  Bun.YAML.parse(readFileSync(`.github/workflows/${file}`, "utf8"));

/** Every executable string in the parsed workflow: `run`, `if`, `with`, `env`, … */
const executableText = (wf: unknown): string => JSON.stringify(wf);

describe("rollback-cli.yml: never couples to cli/next", () => {
  // The rollback lane promotes a tag that `cli/next` does not serve, so a gate
  // here that reads `ring=next` or compares against `cli/next` can only refuse.
  it("has no executable reference to the next ring", () => {
    const text = executableText(workflow("rollback-cli.yml"));
    const hits = [
      ...text.matchAll(/ring=next|cli\\?\/next|--require-serving/g),
    ].map((m) => m[0]);
    expect(hits).toEqual([]);
  });

  // A rollback reads nothing from the tag's tree (it publishes no plugin), so it
  // checks out `main` and runs today's scripts. `ref: <the tag>` would run
  // scripts from a tag cut months ago against today's store and interfaces.
  it("checks out main, not the tag being rolled back to", () => {
    const wf = workflow("rollback-cli.yml") as {
      jobs: Record<
        string,
        { steps?: { uses?: string; with?: { ref?: string } }[] }
      >;
    };
    for (const job of Object.values(wf.jobs)) {
      for (const step of job.steps ?? []) {
        if ((step.uses ?? "").startsWith("actions/checkout")) {
          expect(step.with?.ref).toBeUndefined();
        }
      }
    }
  });
});

describe("promote-cli.yml: has no rollback mode", () => {
  // A boolean that subtracts gates from the forward path makes correctness depend
  // on every future gate's author remembering it. That shape let #48 break
  // rollback.
  it("declares no allow_not_next input", () => {
    const wf = workflow("promote-cli.yml") as {
      on?: { workflow_dispatch?: { inputs?: Record<string, unknown> } };
    };
    const inputs = Object.keys(wf.on?.workflow_dispatch?.inputs ?? {});
    expect(inputs).not.toContain("allow_not_next");
  });

  // A leftover `!inputs.allow_not_next` in an `if` evaluates to true for a
  // missing input, so the guard silently inverts rather than erroring.
  it("has no executable reference to the removed input", () => {
    const text = executableText(workflow("promote-cli.yml"));
    expect(text).not.toContain("allow_not_next");
  });

  // A promote only advances `stable` onto what `next` serves, and the publisher
  // enforces that because it holds the origin it is about to write, so the gate
  // and the write are the same store.
  it("always passes --require-serving next to the publisher", () => {
    const wf = workflow("promote-cli.yml") as {
      jobs: Record<string, { steps?: { name?: string; run?: string }[] }>;
    };
    const move = Object.values(wf.jobs)
      .flatMap((j) => j.steps ?? [])
      .find((s) => s.name === "Advance cli/stable");
    expect(move?.run).toContain("--require-serving next");
  });

  // Minted after the move, a key GitHub refused would leave `stable` moved with
  // the plugin unpublished. Minted before, it fails the promote with `stable`
  // untouched. The mint must not wait on the move's output, or it cannot run
  // first.
  it("mints the plugin token before cli/stable moves", () => {
    const wf = workflow("promote-cli.yml") as {
      jobs: Record<
        string,
        { steps?: { id?: string; name?: string; if?: string }[] }
      >;
    };
    const steps = Object.values(wf.jobs).find((j) =>
      (j.steps ?? []).some((s) => s.name === "Advance cli/stable"),
    )?.steps;
    const mint = steps?.findIndex((s) => s.id === "plugin-token") ?? -1;
    const move = steps?.findIndex((s) => s.name === "Advance cli/stable") ?? -1;
    expect(mint).toBeGreaterThanOrEqual(0);
    expect(mint).toBeLessThan(move);
    expect(steps?.[mint]?.if ?? "").not.toContain("steps.promote");
  });
});

describe("the two lanes serialise against each other", () => {
  // Concurrency groups are scoped to the repository, not the workflow, so the
  // shared group string is what stops a rollback racing a promote. Rename it in
  // one file and the two lanes can write `cli/stable` simultaneously.
  it("both write cli/stable under the same concurrency group", () => {
    for (const file of ["promote-cli.yml", "rollback-cli.yml"]) {
      const wf = workflow(file) as {
        jobs: Record<string, { concurrency?: { group?: string } }>;
      };
      const groups = Object.values(wf.jobs)
        .map((j) => j.concurrency?.group)
        .filter(Boolean);
      expect(groups).toContain("ring-stable");
    }
  });
});

interface Job {
  needs?: string | string[];
  steps?: { run?: string; env?: Record<string, unknown> }[];
}

/**
 * The step/job keys that can change whether or how the gate runs, as opposed to
 * what it checks. Asserted absent on the approve job and every one of its steps.
 */
const OVERRIDES: string[] = [
  "continue-on-error",
  "if",
  "shell",
  "working-directory",
];

const needsOf = (job: Job | undefined): string[] =>
  job?.needs === undefined ? [] : [job.needs].flat();

/**
 * Every job reachable from this one through `needs`. Depth-first with a seen-set:
 * GitHub rejects a cycle, but this parses YAML that GitHub has not necessarily
 * accepted yet, and a cycle here would otherwise hang the suite.
 */
const ancestryOf = (start: string, jobs: Record<string, Job>): string[] => {
  const seen = new Set<string>();
  const stack = needsOf(jobs[start]);
  while (stack.length > 0) {
    const next = stack.pop() as string;
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...needsOf(jobs[next]));
  }
  return [...seen];
};

const reachesApprove = (start: string, jobs: Record<string, Job>): boolean =>
  ancestryOf(start, jobs).includes("approve");

/**
 * The status functions that let a job run even though a dependency failed, which
 * is why a `needs:` edge is not by itself proof of a gate. An
 * `if:` with no status function implicitly carries `success()`, so an ordinary
 * condition (`inputs.plan_only != 'true'`) still waits for every dependency to
 * succeed and is harmless here. `always()`, `cancelled()` and `failure()` are the
 * three that override that, and `if: ${{ always() }}` on a token-bearing job with
 * `needs: approve` runs the job after the gate has already refused.
 */
const BYPASSES_FAILURE = /\b(always|cancelled|failure)\s*\(\s*\)/;

/** A handle as the two files should be compared: no `@`, case-insensitive. */
const normaliseHandle = (handle: string): string =>
  handle.replace(/^@/, "").toLowerCase();

/**
 * Every distinct owner named by a CODEOWNERS rule.
 *
 * Comments are dropped: the file is mostly prose explaining why each path is
 * owned, and that prose may name a handle. Only a rule confers ownership.
 */
const codeownersOwners = (): Set<string> =>
  new Set(
    readFileSync(".github/CODEOWNERS", "utf8")
      .split("\n")
      .map((line) => line.replace(/(^|\s)#.*$/, "").trim())
      .filter((line) => line !== "")
      .flatMap((line) => line.split(/\s+/))
      .filter((token) => token.startsWith("@"))
      .map(normaliseHandle),
  );

/** The members of `a` that `b` does not have, for a failure message. */
const missingFrom = (a: Set<string>, b: Set<string>): string[] =>
  [...a].filter((handle) => !b.has(handle)).sort();

/**
 * `github.actor` is the user who triggered the initial run, and it does not change
 * on a re-run. `github.triggering_actor` is whoever started this run. Re-running a
 * run needs only write access, a far larger set than the promoter allow-list, so
 * an `approve` job reading `github.actor` alone passes a replay on the original
 * promoter's name, with that run's original `inputs.tag`. Replaying a rollback
 * puts `cli/stable` back on an old tag; replaying a promote is a downgrade once
 * `stable` has moved past it.
 *
 * So a lane that can reach the store with a manual trigger must gate on both. A
 * lane with no manual trigger is out of scope: re-running it re-runs that event's
 * own commit. That is why `edge-cli.yml` has no `workflow_dispatch` at all rather
 * than a gate (its `publish` job holds the token and must run unattended on every
 * merge).
 */
describe("every store-writing lane with a manual trigger gates on both actors", () => {
  // GitHub Actions recognises `.yml` and `.yaml` alike, so an `.yml`-only filter
  // would silently skip a token-bearing `.yaml` lane.
  //
  // Sorted: `readdirSync` returns filesystem order, so the exact-set assertion
  // below would otherwise depend on the machine.
  const workflowFiles = readdirSync(".github/workflows")
    .filter((f) => /\.ya?ml$/.test(f))
    .sort();

  // Scoped to `jobs`, not the whole file: some workflows name the token in their
  // headers only to say they do not hold it (e.g. `release-badge.yml`).
  const holdsStoreToken = (wf: { jobs?: unknown }): boolean =>
    JSON.stringify(wf.jobs ?? {}).includes("BLOB_READ_WRITE_TOKEN");

  it("is a non-empty set, so this suite cannot pass by matching nothing", () => {
    const gated = workflowFiles.filter((f) => {
      const wf = workflow(f) as {
        on?: Record<string, unknown>;
        jobs?: unknown;
      };
      return holdsStoreToken(wf) && "workflow_dispatch" in (wf.on ?? {});
    });
    expect(gated).toEqual(["promote-cli.yml", "rollback-cli.yml"]);
  });

  for (const file of workflowFiles) {
    it(`${file}: no manual trigger, or an approve job reading both actors`, () => {
      const wf = workflow(file) as {
        on?: Record<string, unknown>;
        jobs?: Record<string, Job>;
      };

      if (!holdsStoreToken(wf)) return;
      if (!("workflow_dispatch" in (wf.on ?? {}))) return;

      const approve = wf.jobs?.approve;
      expect(
        approve,
        `${file} holds the store token and is manually dispatchable, so it needs an approve job`,
      ).toBeDefined();
      const steps = approve?.steps ?? [];

      // Everything below reads the gate's content; none of it would notice the
      // gate being switched off from outside. `continue-on-error: true` is the
      // sharp one: GitHub treats a failed-but-continued job as satisfied for
      // `needs:`, so the privileged job would still run after the actor check
      // exits 1. `if:` can make the gate conditional on anything; `shell:` can
      // replace the interpreter the checks below assume; `working-directory:`
      // moves where it runs. None has a legitimate use on this job.
      for (const override of OVERRIDES) {
        expect(
          (approve as Record<string, unknown> | undefined)?.[override],
          `${file}: approve sets '${override}', which can neutralise the gate`,
        ).toBeUndefined();
        for (const [i, step] of steps.entries()) {
          expect(
            (step as Record<string, unknown>)[override],
            `${file}: approve step ${i} sets '${override}', which can neutralise the gate`,
          ).toBeUndefined();
        }
      }

      // Two halves. The `env:` mapping proves the gate reads the right GitHub
      // contexts, which running the script cannot show because the runner
      // supplies those values.
      //
      // Then the script is executed with controlled actors, which proves it
      // refuses. Reading the shell text statically cannot: comments naming the
      // contexts, an `exit 1` in the other branch, `echo "exit 1"` or an
      // `exit 1` in a heredoc all look like a refusal without being one.
      const bound = new Map<string, string>();
      for (const step of steps) {
        for (const [name, value] of Object.entries(step.env ?? {})) {
          if (typeof value === "string") bound.set(name, value);
        }
      }
      const varFor = (context: string): string | undefined =>
        [...bound].find(
          ([, v]) => v.replace(/\s+/g, "") === `\${{${context}}}`,
        )?.[0];

      const actorVar = varFor("github.actor");
      const triggeringVar = varFor("github.triggering_actor");

      // `github.actor` alone is the replay bug; `github.triggering_actor` alone
      // would drop the guarantee about who chose the tag.
      expect(
        actorVar,
        `${file}: approve binds no env var to github.actor`,
      ).toBeDefined();
      expect(
        triggeringVar,
        `${file}: approve binds no env var to github.triggering_actor`,
      ).toBeDefined();

      const promoterList = (bound.get("PROMOTERS") ?? "").trim();
      expect(
        promoterList,
        `${file}: approve binds no PROMOTERS allow-list`,
      ).not.toBe("");

      // The same handles live in four places: `.github/CODEOWNERS`, this
      // `PROMOTERS` string, the other lane's copy, and the `cli-release-signers`
      // GitHub team. A handle dropped from CODEOWNERS but left here can still move
      // `cli/stable` without having to review the file that says who may; one
      // added here but not there gains the ring without that review. Neither
      // shows up in a run.
      //
      // Compared as sets: `PROMOTERS` is one space-separated line and CODEOWNERS
      // repeats handles across many rules. The GitHub team is out of scope: it
      // cannot be read without the network.
      const promoters = new Set(promoterList.split(/\s+/).map(normaliseHandle));
      const owners = codeownersOwners();

      // A CODEOWNERS renamed, emptied, or reshaped past this parser would read as
      // "no owners" and make the comparison below meaningless.
      expect(
        owners.size,
        `${file}: parsed no owners out of .github/CODEOWNERS, so the comparison below would assert nothing`,
      ).toBeGreaterThan(0);

      expect(
        [...promoters].sort(),
        `${file}: PROMOTERS and .github/CODEOWNERS name different people - ` +
          `in PROMOTERS only: [${missingFrom(promoters, owners).join(", ") || "none"}]; ` +
          `in CODEOWNERS only: [${missingFrom(owners, promoters).join(", ") || "none"}]`,
      ).toEqual([...owners].sort());

      // The gate step is the one that binds the actor contexts; `approve` may hold
      // others (promote's second step records what was approved) and they are not
      // the gate.
      const gateStep = steps.find((s) =>
        Object.keys(s.env ?? {}).includes(actorVar as string),
      );
      expect(
        gateStep?.run,
        `${file}: approve's gate step has no run body`,
      ).toBeDefined();
      const script = gateStep?.run ?? "";

      // The gate must take its actors through `env:`, never by interpolating a
      // `${{ }}` expression into the shell. That makes the values data rather
      // than code, and makes this script safe to execute here.
      expect(
        script.includes("${{"),
        `${file}: approve's gate interpolates a \${{ }} expression into the shell instead of binding it through env:`,
      ).toBe(false);

      /** Run the real gate with these two actors; return its exit status. */
      const runGate = (actor: string, triggering: string): number => {
        const env: Record<string, string> = {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
        };
        for (const [k, v] of bound) env[k] = v;
        env[actorVar as string] = actor;
        env[triggeringVar as string] = triggering;
        // `-e` because GitHub Actions runs a `run:` body as `bash -e {0}` unless
        // the step sets `shell:` (which OVERRIDES forbids). It keeps the harness
        // faithful for a gate that relies on the runner's `-e` rather than its
        // own `set -e`.
        return (
          Bun.spawnSync(["bash", "-e", "-c", script], {
            env,
            stdout: "pipe",
            stderr: "pipe",
          }).exitCode ?? -1
        );
      };

      // Real names from the lane's own allow-list, against one that is plainly not
      // on it. Each case isolates a single condition, so no case can pass for the
      // reason another one does.
      const promoter = promoterList.split(/\s+/)[0];
      const outsider = "not-a-promoter-mutation-probe";

      expect(
        runGate(promoter, promoter),
        `${file}: the gate refuses '${promoter}', who is on its own allow-list`,
      ).toBe(0);

      // The original dispatcher is not a promoter.
      expect(
        runGate(outsider, promoter),
        `${file}: the gate admits a run dispatched by '${outsider}'`,
      ).not.toBe(0);

      // The re-runner is not a promoter. `github.actor` still names the original
      // promoter on a re-run, so a gate reading it alone passes this case.
      expect(
        runGate(promoter, outsider),
        `${file}: the gate admits a re-run started by '${outsider}' because the original dispatcher was a promoter`,
      ).not.toBe(0);

      expect(
        runGate(outsider, outsider),
        `${file}: the gate admits a run with no promoter involved at all`,
      ).not.toBe(0);

      // `approve` refusing the wrong actor is worthless unless the job holding
      // the token cannot start without it: every token-bearing job must have
      // `approve` as an ancestor. Transitively, so a sound
      // `approve -> validate -> promote` chain passes.
      for (const [name, job] of Object.entries(wf.jobs ?? {})) {
        if (name === "approve") continue;
        if (!JSON.stringify(job).includes("BLOB_READ_WRITE_TOKEN")) continue;
        const jobs = wf.jobs ?? {};
        expect(
          reachesApprove(name, jobs),
          `${file}: job '${name}' reaches the store without approve anywhere in its needs chain`,
        ).toBe(true);

        // `needs: approve` only blocks the job while it waits for approve to
        // succeed, and a status function in `if:` removes that. `always()` on
        // this job, or any job between it and approve, runs the privileged step
        // after the gate refused.
        for (const link of [name, ...ancestryOf(name, jobs)]) {
          const condition = (jobs[link] as Record<string, unknown> | undefined)
            ?.if;
          if (typeof condition !== "string") continue;
          expect(
            BYPASSES_FAILURE.test(condition),
            `${file}: job '${link}' is on '${name}'s path to the store and its if: can run after approve fails`,
          ).toBe(false);
        }
      }
    });
  }
});

/**
 * The promote banner is a reading, not a gate.
 *
 * `next-report` at the top of `promote-cli.yml` shows wego-ai's verdict for the
 * tag. It is deliberately outside the gate chain: a promote is a human decision,
 * and the banner puts the verdict in front of that human. Two ways it could
 * quietly become a gate:
 *
 *   - a job `needs:` it, directly or through another job, so a red or slow
 *     banner holds `approve` or `promote` back;
 *   - it grows a `needs:` of its own, so it waits behind the gate it is meant to
 *     sit beside, and the promoter reads the verdict after the pointer moved.
 *
 * Its capabilities (read-only, no secret, never red) are asserted with the
 * release lane's reader in `workflow-shape.test.ts`.
 */
describe("promote-cli.yml: the next report banner gates nothing", () => {
  const wf = workflow("promote-cli.yml") as {
    jobs: Record<
      string,
      Job & {
        "continue-on-error"?: unknown;
        steps?: { run?: string; "continue-on-error"?: unknown }[];
      }
    >;
  };
  const banner = Object.entries(wf.jobs).find(([, job]) =>
    (job.steps ?? []).some((s) =>
      /scripts\/next-report\.ts\s+--banner/.test(s.run ?? ""),
    ),
  );

  it("exists, in one job", () => {
    expect(banner).toBeDefined();
  });

  it("is in no other job's needs chain", () => {
    const name = banner?.[0] as string;
    for (const other of Object.keys(wf.jobs)) {
      expect(
        ancestryOf(other, wf.jobs),
        `promote-cli.yml: '${other}' waits for the banner`,
      ).not.toContain(name);
    }
  });

  it("waits for nothing itself", () => {
    expect(needsOf(banner?.[1])).toEqual([]);
  });

  it("cannot fail the run, at the job or at the step", () => {
    const job = banner?.[1];
    expect(job?.["continue-on-error"]).toBe(true);
    const step = (job?.steps ?? []).find((s) =>
      (s.run ?? "").includes("next-report.ts"),
    );
    expect(
      (step as Record<string, unknown> | undefined)?.["continue-on-error"],
    ).toBe(true);
  });
});

/**
 * The integration matrix covers what the release builds, and holds publication.
 *
 * `integration` runs the compiled binary against a fake API on each target's own
 * runner. Its matrix and `scripts/build-release.ts`'s target list are separate
 * literals, so a target added to the build could ship without ever being
 * executed. The set is derived from the build script, not restated here, and
 * `release` must need the job so a target that cannot run never reaches
 * `cli/next`.
 *
 * One named exemption: Windows. Its first leg (v1.4.0) failed on the suite, not
 * the binary, and was taken out rather than hold every release. It is a list, not
 * a looser comparison, so anything else the build adds still needs a leg.
 */
const NOT_INTEGRATION_TESTED = ["wego-windows-x64.exe"];

describe("release-cli.yml: integration runs every built target before publication", () => {
  const wf = workflow("release-cli.yml") as {
    jobs: Record<
      string,
      Job & {
        name?: string;
        strategy?: {
          "fail-fast"?: boolean;
          matrix?: {
            include?: { target: string; runner: string; asset: string }[];
          };
        };
      }
    >;
  };
  const job = wf.jobs.integration;
  const include = job?.strategy?.matrix?.include ?? [];

  /** The asset names `build-release.ts` writes: `wego-<suffix>`, per target. */
  const built = [
    ...readFileSync("scripts/build-release.ts", "utf8").matchAll(
      /\{\s*target:\s*"bun-[^"]+",\s*suffix:\s*"([^"]+)"\s*\}/g,
    ),
  ].map((m) => `wego-${m[1]}`);

  it("reads a target list out of the build script", () => {
    // A reshaped TARGETS table would otherwise parse as "builds nothing" and the
    // comparison below would pass against an empty matrix.
    expect(built.length).toBeGreaterThanOrEqual(5);
  });

  it("covers exactly the assets the build produces, apart from the named exemption", () => {
    // The exemption must name a real asset, or it would exempt nothing and read
    // as coverage.
    for (const asset of NOT_INTEGRATION_TESTED) expect(built).toContain(asset);
    expect(include.map((e) => e.asset).sort()).toEqual(
      built.filter((a) => !NOT_INTEGRATION_TESTED.includes(a)).sort(),
    );
  });

  it("runs each target on a runner that can execute it", () => {
    const families: Record<string, string> = {
      linux: "ubuntu-",
      darwin: "macos-",
      windows: "windows-",
    };
    for (const { target, runner, asset } of include) {
      expect(asset, `${target} runs ${asset}`).toContain(target);
      const [os = "", arch = ""] = target.split("-");
      expect(
        runner.startsWith(families[os] ?? "?"),
        `${target} on ${runner}`,
      ).toBe(true);
      // `macos-latest` is Apple silicon and `ubuntu-latest` is x64, so the other
      // architecture needs a label that names it.
      if (os === "linux" && arch === "arm64") expect(runner).toMatch(/-arm$/);
      if (os === "darwin" && arch === "x64") expect(runner).toMatch(/intel/);
    }
  });

  it("names each leg by its target, and lets every leg finish", () => {
    expect(job?.name).toBe(`integration (\${{ matrix.target }})`);
    expect(job?.strategy?.["fail-fast"]).toBe(false);
  });

  it("drives the built artifact, not a binary of its own", () => {
    const step = (job?.steps ?? []).find((s) =>
      (s.run ?? "").includes("bun run test:integration"),
    );
    expect(String(step?.env?.WEGO_INTEGRATION_BINARY)).toContain(
      `\${{ matrix.asset }}`,
    );
  });

  it("holds publication: release needs it, and it does not need release", () => {
    expect(needsOf(wf.jobs.release)).toContain("integration");
    expect(ancestryOf("integration", wf.jobs)).not.toContain("release");
  });
});

/**
 * Promote gates on the publishing jobs, not on the reports.
 *
 * `promote-cli.yml` reads the release run job by job and leaves out two jobs by
 * display name, because `notify-verify` goes red on a receiver outage and
 * `next-report` keeps the run in progress for up to 45 min. The names are strings
 * in a script, so a rename in `release-cli.yml` would silently gate on the reports
 * or find no publishing job and refuse every promote.
 */
describe("promote-cli.yml: the release gate names real jobs", () => {
  const release = workflow("release-cli.yml") as {
    jobs: Record<string, { name?: string }>;
  };
  const promote = workflow("promote-cli.yml") as {
    jobs: Record<
      string,
      { steps?: { name?: string; with?: { script?: string } }[] }
    >;
  };
  const gate =
    Object.values(promote.jobs)
      .flatMap((j) => j.steps ?? [])
      .find(
        (s) =>
          s.name === "Require a completed, successful release run for the tag",
      )?.with?.script ?? "";

  it.each([
    ["notify-verify", "report-only"],
    ["next-report", "report-only"],
    ["release", "the publishing job"],
  ])("%s's display name is the one the gate uses (%s)", (id) => {
    const name = release.jobs[id]?.name;
    expect(name).toBeDefined();
    expect(gate).toContain(`"${name}"`);
  });
});
