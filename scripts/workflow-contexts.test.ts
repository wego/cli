/**
 * Composite actions reach only for contexts they can see.
 *
 * An action has no `needs`, `matrix` or `secrets`; those must arrive as inputs.
 * An action that references one anyway compiles, runs, and reads the EMPTY
 * STRING - which in an `if:` makes the condition permanently false, so the step
 * it guards silently stops running. The lane stays green and the coverage is
 * simply gone, because a skipped step looks the same as a step that had nothing
 * to do.
 *
 * WHY THIS FILE IS THE SIZE IT IS. It used to carry two more suites, asserting
 * that every `needs.<job>.outputs.<name>` named an output the producing job
 * declares, and that the consuming job declared a `needs:` edge to it. `ci-cli`
 * now runs actionlint, which decides both by resolving each expression against
 * the contexts GitHub really supplies - a strictly better answer, typed and
 * located, and it catches a great deal those two regexes never looked at. So
 * they went.
 *
 * What did NOT go is this suite, and the reason is not a preference: actionlint
 * parses `action.yml` as a WORKFLOW, so on a composite action it reports a
 * missing `jobs:` section and stops. The files below are exactly the ones it
 * cannot read, which is why the check survives its arrival.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ACTIONS = ".github/actions";

describe("composite actions: reach only for contexts they can see", () => {
  const actionFiles = readdirSync(ACTIONS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(ACTIONS, d.name, "action.yml"));

  // A suite that matched no files would pass having asserted nothing, which is
  // the one way this check can regress without turning red.
  it("finds composite actions to check", () => {
    expect(actionFiles.length).toBeGreaterThan(0);
  });

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
      expect(blind).toEqual([]);
    });
  }
});
