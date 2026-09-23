/**
 * THE TWO LANES THAT WRITE `cli/stable`, AND THE SEPARATION BETWEEN THEM.
 *
 * `promote-cli.yml` moves `stable` onto what `cli/next` serves. `rollback-cli.yml`
 * moves it onto a named earlier release. They used to be ONE workflow with a
 * boolean (`allow_not_next`) that subtracted gates, and that boolean was the
 * defect: it silently changed the meaning of twenty downstream steps, so every new
 * gate had to remember to opt rollback out. wego/cli#48 added two `cli/next`-coupled
 * gates without the guard and both hard-failed every rollback — silently, because
 * nothing exercises a rollback until an incident.
 *
 * Splitting the files fixes that by CONSTRUCTION rather than by convention: promote
 * has no mode left to forget, and rollback has nothing to couple to. These two
 * assertions are what keep it that way, and they are deliberately structural rather
 * than stylistic — each one names a thing that, if it reappeared, would reintroduce
 * exactly the failure the split removed.
 *
 * SCOPED TO THE PARSED WORKFLOW, NOT THE FILE TEXT. `Bun.YAML.parse` drops
 * comments, which is the point: both files EXPLAIN this history in their headers,
 * and prose naming `cli/next` or `allow_not_next` is documentation, not coupling.
 * What must not reappear is an executable reference — a `run` body, an `if`, a
 * `with` — so the parsed object is the right surface to assert against.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

const workflow = (file: string): unknown =>
  Bun.YAML.parse(readFileSync(`.github/workflows/${file}`, "utf8"));

/** Every executable string in the parsed workflow: `run`, `if`, `with`, `env`, … */
const executableText = (wf: unknown): string => JSON.stringify(wf);

describe("rollback-cli.yml: never couples to cli/next", () => {
  // The rollback lane promotes a tag that `cli/next` does not serve — that is its
  // entire reason to exist. A gate here that reads `ring=next` or compares against
  // `cli/next` can only ever refuse, because the ring is by definition serving
  // something else. Both gates wego/cli#48 added to the promote lane had this
  // shape, and both blocked every rollback.
  it("has no executable reference to the next ring", () => {
    const text = executableText(workflow("rollback-cli.yml"));
    const hits = [
      ...text.matchAll(/ring=next|cli\\?\/next|--require-serving/g),
    ].map((m) => m[0]);
    expect(hits).toEqual([]);
  });

  // A rollback reads nothing from the tag's tree — it publishes no plugin — so it
  // checks out `main` and runs TODAY'S scripts. `ref: <the tag>` would silently
  // run whatever `upgrade-path.sh` and the publisher looked like at a tag cut
  // months ago, against today's store and today's interfaces.
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
  // THE DEFECT ITSELF. `allow_not_next` was a human-typed boolean that subtracted
  // gates from the forward path, so correctness depended on every future gate's
  // author reconstructing an invariant documented per-step in prose and nowhere as
  // a whole. Re-introducing it — as an input, an `if`, or an env var — brings back
  // the exact shape that let #48 break rollback silently.
  it("declares no allow_not_next input", () => {
    const wf = workflow("promote-cli.yml") as {
      on?: { workflow_dispatch?: { inputs?: Record<string, unknown> } };
    };
    const inputs = Object.keys(wf.on?.workflow_dispatch?.inputs ?? {});
    expect(inputs).not.toContain("allow_not_next");
  });

  // The input being gone is not enough on its own: a leftover `!inputs.allow_not_next`
  // in an `if` evaluates to TRUE for a missing input, so the guard silently inverts
  // rather than erroring, and a gate that was meant to be conditional becomes
  // permanently on — or off, depending which way it was written.
  it("has no executable reference to the removed input", () => {
    const text = executableText(workflow("promote-cli.yml"));
    expect(text).not.toContain("allow_not_next");
  });

  // A promote only ever advances `stable` onto what `next` serves, and the
  // publisher is where that is enforced — it holds the origin it is about to
  // write, so the gate and the write are the same store by construction. Dropping
  // the flag is how the old rollback mode worked; nothing should drop it now.
  it("always passes --require-serving next to the publisher", () => {
    const wf = workflow("promote-cli.yml") as {
      jobs: Record<string, { steps?: { name?: string; run?: string }[] }>;
    };
    const move = Object.values(wf.jobs)
      .flatMap((j) => j.steps ?? [])
      .find((s) => s.name === "Advance cli/stable");
    expect(move?.run).toContain("--require-serving next");
  });
});

describe("the two lanes serialise against each other", () => {
  // Concurrency groups are scoped to the REPOSITORY, not the workflow, so the
  // shared group string is what stops a rollback racing a promote for the same
  // pointer. Rename it in one file and the two lanes can write `cli/stable`
  // simultaneously — a promote's manifest copy interleaved with a rollback's.
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
 * The step/job keys that can change WHETHER or HOW the gate runs, as opposed to
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
 * The status functions that let a job run even though a dependency FAILED.
 *
 * This is the whole reason a `needs:` edge is not by itself proof of a gate. An
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
 * Every distinct owner named by a CODEOWNERS RULE.
 *
 * Comment lines are dropped rather than scanned, and that is the whole subtlety:
 * this file is mostly prose explaining why each path is owned, and that prose is
 * free to name a handle. Only a rule confers ownership, so only a rule counts.
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
 * THE INVARIANT THIS REPOSITORY LEARNED THE HARD WAY.
 *
 * `github.actor` is the user who triggered the INITIAL run, and it does NOT change
 * on a re-run. `github.triggering_actor` is whoever started THIS run. Re-running an
 * existing run needs only write access — a far larger set than the promoter
 * allow-list — so an `approve` job reading `github.actor` alone passes a replay on
 * the ORIGINAL promoter's name, with that run's original `inputs.tag`. Replaying a
 * rollback puts `cli/stable` back on an old tag; replaying a promote is a downgrade
 * the moment `stable` has advanced past it. Neither needs a stolen account.
 *
 * So: a lane that can reach the store with a manual trigger must gate on BOTH.
 * A lane with no manual trigger is out of scope by construction — the only way to
 * start it is the event itself, and re-running it re-runs that event's own commit.
 * That is why `edge-cli.yml` answers this by having no `workflow_dispatch` at all
 * rather than by growing a gate it could not usefully hold (its `publish` job is
 * the one holding the token, and it must run unattended on every merge).
 */
describe("every store-writing lane with a manual trigger gates on both actors", () => {
  // BOTH EXTENSIONS. GitHub Actions recognises `.yml` and `.yaml` alike, so an
  // `.yml`-only filter would drop a token-bearing `.yaml` lane out of this scan
  // silently — the suite would go green having asserted nothing about it. Matches
  // the idiom `workflow-contexts.test.ts` already uses.
  //
  // Sorted: `readdirSync` returns filesystem order, so the exact-set assertion
  // below would otherwise pass or fail depending on the machine.
  const workflowFiles = readdirSync(".github/workflows")
    .filter((f) => /\.ya?ml$/.test(f))
    .sort();

  // Scoped to `jobs`, not the whole file: several workflows DISCUSS the token in
  // their headers precisely to explain that they do not hold it, and comments are
  // documentation, not reach. `release-badge.yml` is the live example — it is
  // dispatchable and names the token only to say it has none.
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

      // A GATE THAT CAN BE SWITCHED OFF IS NOT A GATE. Everything below reads the
      // gate's CONTENT; none of it would notice the gate being neutered from the
      // outside. `continue-on-error: true` is the sharp one — GitHub treats a
      // failed-but-continued job as satisfied for `needs:`, so the actor check
      // could exit 1 on an outsider and the privileged job would still run, with
      // every assertion here still green. `if:` can make the gate conditional on
      // whatever the author picks (including the actor it is supposed to judge);
      // `shell:` can replace the interpreter whose `set -euo pipefail` and `exit 1`
      // the checks below assume; `working-directory:` moves where it all runs.
      //
      // None has a legitimate use on this job, so the invariant is that they are
      // absent — on the job and on each of its steps.
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

      // TWO HALVES, AND THEY PROVE DIFFERENT THINGS.
      //
      // The `env:` mapping proves the gate reads the right GitHub CONTEXTS - the
      // only place a context can enter the shell, and something running the script
      // can never show, because the runner supplies those values.
      //
      // Then the script is EXECUTED with controlled actors, which proves it
      // actually refuses. That half replaced a static reading of the shell, and the
      // reason is worth keeping: every attempt to decide "does this branch refuse?"
      // by looking at the text was defeated by text that merely LOOKED like a
      // refusal - first the gate's own comments (which must name both contexts in
      // order to explain them), then an `exit 1` belonging to the other actor's
      // branch, then `echo "exit 1"`, then an `exit 1` inside a heredoc. Each fix
      // was a better approximation of a shell lexer, and the next variation always
      // existed. Running the thing has no such class of evasion: text that only
      // looks like a refusal does not change the exit status.
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

      // `github.actor` alone is the bug; `github.triggering_actor` alone would drop
      // the guarantee about who chose the tag in the first place. Both, or neither
      // property holds.
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

      // THE SAME THREE HANDLES LIVE IN FOUR PLACES, AND ONE OF THEM IS THIS LANE.
      //
      // `.github/CODEOWNERS`, this `PROMOTERS` string, the rollback lane's copy of
      // it, and the `cli-release-signers` GitHub team. Adding or removing a signer
      // is four edits in two systems, and nothing makes them happen together. The
      // failure that costs something is the SILENT half: a handle dropped from
      // CODEOWNERS but left here can still move `cli/stable` while no longer being
      // required to review the file that says who may, and a handle added here but
      // not there gains the ring without the review that was supposed to grant it.
      // Neither shows up in a run - the gate passes, the review passes, and the two
      // lists have simply stopped describing the same people.
      //
      // Sets, not strings: `PROMOTERS` is one space-separated line and CODEOWNERS
      // repeats the handles across nineteen rules, so order and spacing are not the
      // property. The remote team is out of scope here - it cannot be read without
      // the network, and a periodic out-of-band sweep is what reconciles it.
      const promoters = new Set(promoterList.split(/\s+/).map(normaliseHandle));
      const owners = codeownersOwners();

      // A set comparison against an empty set passes for the wrong reason: a
      // CODEOWNERS that has been renamed, emptied, or reshaped past this parser
      // would read as "no owners" and take the assertion below with it.
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
      // `${{ }}` expression into the shell. That is what makes the values data
      // rather than code, and it is also what makes this script safe to execute
      // here: there is nothing left for the runner to substitute.
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
        // `-e`, BECAUSE THAT IS WHAT THE RUNNER DOES. GitHub Actions executes a
        // `run:` body as `bash -e {0}` unless the step sets `shell:` - and the
        // OVERRIDES check above asserts this step does not. Both gates currently
        // set `set -euo pipefail` themselves, so this changes nothing today; it
        // keeps the harness faithful for a gate that validly leans on the
        // runner-supplied `-e` instead.
        //
        // Without it such a gate would run to completion here and exit 0 where the
        // runner would abort nonzero - so the failure would be this suite going
        // RED against a gate that is correct in production, not a regression
        // slipping through. A false alarm still costs the right thing eventually:
        // it pressures whoever meets it into weakening the assertion.
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

      // THE ORIGINAL DISPATCHER IS NOT A PROMOTER.
      expect(
        runGate(outsider, promoter),
        `${file}: the gate admits a run dispatched by '${outsider}'`,
      ).not.toBe(0);

      // THE RE-RUNNER IS NOT A PROMOTER - the vector this whole suite exists for.
      // `github.actor` still names the original promoter on a re-run, so a gate
      // reading it alone passes this case, and passing it is the bug.
      expect(
        runGate(promoter, outsider),
        `${file}: the gate admits a re-run started by '${outsider}' because the original dispatcher was a promoter`,
      ).not.toBe(0);

      expect(
        runGate(outsider, outsider),
        `${file}: the gate admits a run with no promoter involved at all`,
      ).not.toBe(0);

      // A GATE NOTHING DEPENDS ON IS DECORATION. Everything above establishes that
      // `approve` refuses the wrong actor; none of it establishes that the job
      // holding the token cannot start without it. So walk the dependency graph:
      // every token-bearing job must have `approve` as an ancestor.
      //
      // TRANSITIVELY, not just directly. The property that matters is "approve is
      // an ancestor", and demanding the literal `needs: approve` on the
      // token-bearing job asserts a stricter proxy — it would fail a perfectly
      // sound `approve -> validate -> promote` chain and push a future author to
      // weaken the test rather than keep the chain.
      for (const [name, job] of Object.entries(wf.jobs ?? {})) {
        if (name === "approve") continue;
        if (!JSON.stringify(job).includes("BLOB_READ_WRITE_TOKEN")) continue;
        const jobs = wf.jobs ?? {};
        expect(
          reachesApprove(name, jobs),
          `${file}: job '${name}' reaches the store without approve anywhere in its needs chain`,
        ).toBe(true);

        // AN EDGE IS NOT A GATE ON ITS OWN. `needs: approve` only blocks the job
        // while the job waits for approve to SUCCEED, and a status function in
        // `if:` removes exactly that. `if: ${{ always() }}` on this job, or on any
        // job between it and approve, runs the privileged step after the gate has
        // already refused - with the ancestry assertion above still green.
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
 * THE PROMOTE BANNER IS A READING, NOT A GATE.
 *
 * `next-report` at the top of `promote-cli.yml` shows wego-ai's verdict for the
 * tag. It is deliberately outside the gate chain: a promote is a human decision,
 * and the banner exists so the verdict was in front of that human, not to make
 * the decision for them. Two ways it could quietly become a gate:
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
 * THE INTEGRATION MATRIX COVERS WHAT THE RELEASE BUILDS, AND HOLDS PUBLICATION.
 *
 * `integration` runs the compiled binary against a fake API on each target's own
 * runner. Its matrix is a literal and `scripts/build-release.ts`'s target list is
 * another, and nothing makes them move together: a sixth target added to the
 * build would ship with no job ever having executed it, green. So the set is
 * derived from the build script, not restated here.
 *
 * And a job `release` does not need is decoration. The whole point is that a
 * target that cannot run its own commands never reaches `cli/next`.
 */
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

  it("covers exactly the assets the build produces", () => {
    expect(include.map((e) => e.asset).sort()).toEqual([...built].sort());
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
