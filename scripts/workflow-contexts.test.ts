/**
 * A `${{ needs.X.outputs.Y }}` that resolves to nothing is the worst shape of CI
 * bug: it does not error, it evaluates to the empty string. Used in a `with:` it
 * hands a step an empty argument; used in an `if:` it makes the condition
 * permanently FALSE, and the step it guards never runs again. The lane stays
 * green and the coverage is simply gone — there is nothing in the log to notice,
 * because a skipped step looks the same as a step that had nothing to do.
 *
 * This lane has exactly that shape in two places. `replace-macos` guards its
 * post-advance checks on `needs.release.outputs.store_origin`, and passes the
 * same value in. Misspell the output, or forget to declare it on `release`, and
 * every darwin check silently stops running on every release.
 *
 * Three ways it can break, all checked here:
 *
 *   1. the producing job does not declare that output
 *   2. the consuming job does not `needs:` the producing job — the context is
 *      then unavailable and evaluates empty, exactly as a typo would
 *   3. a composite action reaches for a context it cannot see. Actions have no
 *      `needs`, `matrix` or `secrets`; those must arrive as inputs. An action
 *      that references one compiles, runs, and reads empty.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const WORKFLOWS = ".github/workflows";
const ACTIONS = ".github/actions";

interface Job {
  needs?: string | string[];
  outputs?: Record<string, string>;
}
interface Workflow {
  jobs?: Record<string, Job>;
}

const needsOf = (j: Job): string[] =>
  j.needs === undefined ? [] : Array.isArray(j.needs) ? j.needs : [j.needs];

const workflowFiles = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));

describe("workflows: every `needs.<job>.outputs.<name>` actually resolves", () => {
  for (const file of workflowFiles) {
    const raw = readFileSync(join(WORKFLOWS, file), "utf8");
    const wf = Bun.YAML.parse(raw) as Workflow;
    if (!wf.jobs) continue;

    it(`${file}: names only outputs the producing job declares`, () => {
      const missing: string[] = [];
      for (const [jobName, job] of Object.entries(wf.jobs ?? {})) {
        // Serialise the whole job so the scan covers `if:`, `with:`, `env:` and
        // `run:` alike — the reference is equally silent wherever it appears.
        const text = JSON.stringify(job);
        for (const m of text.matchAll(
          /needs\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)/g,
        )) {
          const [, producer, output] = m;
          const declared = wf.jobs?.[producer]?.outputs ?? {};
          if (!(output in declared)) {
            missing.push(
              `${file} ${jobName} → needs.${producer}.outputs.${output}`,
            );
          }
        }
      }
      expect(missing).toEqual([]);
    });

    it(`${file}: only reads outputs from jobs it declares a need on`, () => {
      const unreachable: string[] = [];
      for (const [jobName, job] of Object.entries(wf.jobs ?? {})) {
        const declared = needsOf(job);
        const text = JSON.stringify(job);
        for (const m of text.matchAll(/needs\.([A-Za-z0-9_-]+)\.outputs\./g)) {
          const producer = m[1];
          if (!declared.includes(producer)) {
            unreachable.push(
              `${file} ${jobName} reads needs.${producer}.* but does not need it`,
            );
          }
        }
      }
      expect(unreachable).toEqual([]);
    });
  }
});

describe("composite actions: reach only for contexts they can see", () => {
  const actionFiles = readdirSync(ACTIONS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(ACTIONS, d.name, "action.yml"));

  for (const file of actionFiles) {
    it(`${file}: uses inputs, not needs/matrix/secrets`, () => {
      let raw: string;
      try {
        raw = readFileSync(file, "utf8");
      } catch {
        return; // action.yaml, or not an action dir
      }
      const blind = [...raw.matchAll(/\$\{\{\s*(needs|matrix|secrets)\./g)].map(
        (m) => m[1],
      );
      // An action cannot see these. The expression is not an error — it is empty,
      // which is how a guard becomes permanently false without anyone noticing.
      expect(blind).toEqual([]);
    });
  }
});
