/**
 * Test fixtures shared by the plugin lane's two suites (foundations#101).
 *
 * `plugin-publish.test.ts` and `verify-plugin-published.test.ts` both drive
 * their script against a real git repository over `file://`, so both need
 * throwaway directories and a `git` that throws with git's own stderr.
 *
 * Not a `.test.ts`: `bun test` collects by that suffix, and a module with no
 * assertions would report as an empty suite.
 *
 * Each suite still builds its own bare repo because they need different
 * accessors (what is tracked and how many commits, versus what a ref holds).
 */
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolveGit } from "./plugin-git";

/** Throwaway directories to remove after each test. Push into it on create;
 *  the suite's `afterEach` calls {@link cleanupWorkspaces}. */
export const workspaces: string[] = [];

export function cleanupWorkspaces(): void {
  for (const w of workspaces.splice(0)) {
    rmSync(w, { recursive: true, force: true });
  }
}

/** Resolves the binary through `plugin-git.ts` rather than spawning the bare
 *  name, even in tests: Sonar raises S4036 on the bare name wherever it
 *  appears, `NOSONAR` does not suppress hotspots, and one resolution path for
 *  the whole lane is simpler than a justified exception. */
export function git(cwd: string, ...args: string[]): string {
  const r = spawnSync(resolveGit(), args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${r.stderr || r.stdout}`);
  }
  return r.stdout;
}
