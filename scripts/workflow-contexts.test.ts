/**
 * Composite actions reach only for contexts they can see.
 *
 * An action has no `needs`, `matrix` or `secrets`; those must arrive as inputs.
 * An action that references one anyway runs and reads the empty string, which in
 * an `if:` makes the condition permanently false, so the step it guards silently
 * stops running and the lane stays green.
 *
 * Workflows are checked by actionlint in `ci-cli`, but actionlint (1.7.12, as
 * pinned) never sees composite actions:
 *
 *   - Its default discovery walks `.github/workflows/` only, and `ci-cli`
 *     invokes it with no path arguments.
 *   - Handed an `action.yml` explicitly, it reads it as a workflow and stops on
 *     `"jobs" section is missing in workflow`.
 *
 * So this suite covers exactly the files nothing else checks.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ACTIONS = ".github/actions";

describe("composite actions: reach only for contexts they can see", () => {
  const actionFiles = readdirSync(ACTIONS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(ACTIONS, d.name, "action.yml"));

  // A suite that matched no files would pass having asserted nothing.
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
