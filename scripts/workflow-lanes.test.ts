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
 * Is `approve` anywhere in this job's dependency chain? Depth-first over `needs`,
 * with a seen-set: GitHub rejects a cycle, but this parses YAML that GitHub has
 * not necessarily accepted yet, and a cycle here would otherwise hang the suite.
 */
const reachesApprove = (start: string, jobs: Record<string, Job>): boolean => {
  const seen = new Set<string>();
  const stack = needsOf(jobs[start]);
  while (stack.length > 0) {
    const next = stack.pop() as string;
    if (next === "approve") return true;
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...needsOf(jobs[next]));
  }
  return false;
};

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

      // ASSERT ON THE EXECUTABLE SURFACE, NOT THE STEP TEXT. A `run:` body is one
      // YAML string, so the shell comments inside it survive parsing — and this
      // gate's comments necessarily NAME both contexts in order to explain the
      // difference between them. A substring search over the step would therefore
      // still pass with the binding deleted and only the prose left, which is the
      // one regression this test exists to catch. So: read the `env:` mapping,
      // which is the only place a context can actually enter the shell.
      const bound = new Map<string, string>();
      for (const step of steps) {
        for (const [name, value] of Object.entries(step.env ?? {})) {
          if (typeof value === "string")
            bound.set(name, value.replace(/\s+/g, ""));
        }
      }
      const varFor = (context: string): string | undefined =>
        [...bound].find(([, v]) => v === `\${{${context}}}`)?.[0];

      // `github.actor` alone is the bug; `github.triggering_actor` alone would drop
      // the guarantee about who chose the tag in the first place. Both, or neither
      // property holds.
      for (const context of ["github.actor", "github.triggering_actor"]) {
        const name = varFor(context);
        expect(
          name,
          `${file}: approve binds no env var to ${context}`,
        ).toBeDefined();

        // A bound-but-unread variable is not a gate, and neither is one that is
        // merely echoed — the refusal has to hang off it. So require the variable
        // to appear on a line that is part of a CONDITION. Whole-line shell
        // comments are stripped first, for the same reason as above.
        //
        // This is a shape check, not a proof: a deliberate rewrite into some other
        // control flow would need this assertion updated alongside it, which is the
        // intended cost. What it does catch is the silent regression — the gate
        // decaying back to one actor while the comments still describe two.
        const code = steps
          .map((s) => s.run ?? "")
          .join("\n")
          .split("\n")
          .filter((line) => !line.trimStart().startsWith("#"));

        const conditioned = code.some(
          (line) => /\bif\b/.test(line) && line.includes(`$${name}`),
        );
        expect(
          conditioned,
          `${file}: approve binds ${context} to $${name} but never branches on it`,
        ).toBe(true);

        // And the branch must be able to refuse.
        expect(code.join("\n")).toContain("exit 1");
      }

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
        expect(
          reachesApprove(name, wf.jobs ?? {}),
          `${file}: job '${name}' reaches the store without approve anywhere in its needs chain`,
        ).toBe(true);
      }
    });
  }
});
