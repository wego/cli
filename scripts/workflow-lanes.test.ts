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
import { readFileSync } from "node:fs";

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
