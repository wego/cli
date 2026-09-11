/**
 * Test fixtures shared by the plugin lane's two suites (foundations#101).
 *
 * `plugin-publish.test.ts` and `verify-plugin-published.test.ts` both drive
 * their script against a REAL git repository over `file://`, so both need the
 * same two things: somewhere to put throwaway directories, and a `git` that
 * throws with git's own stderr. Those were identical in both files.
 *
 * Deliberately NOT a `.test.ts`: `bun test` collects by that suffix, and a
 * fixtures module with no assertions in it would report as an empty suite.
 *
 * Kept small on purpose. Each suite still builds its own bare repo, because
 * they want different accessors from it - the publisher's suite asks what is
 * tracked and how many commits there are, the verifier's asks what a given ref
 * holds - and folding those into one helper would make both harder to read to
 * save nothing.
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

/** Run git in `cwd`, throwing with git's own output on failure.
 *
 *  Resolves the binary through `plugin-git.ts` rather than spawning the bare
 *  name. The argument that a test process needs no `$PATH` hardening is true
 *  and beside the point: Sonar raises S4036 on the bare name wherever it
 *  appears, `NOSONAR` does not suppress hotspots, and one resolution path for
 *  the whole lane is simpler than an exception that has to be re-justified
 *  every time someone reads it. */
export function git(cwd: string, ...args: string[]): string {
  const r = spawnSync(resolveGit(), args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${r.stderr || r.stdout}`);
  }
  return r.stdout;
}
