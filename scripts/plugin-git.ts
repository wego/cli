/**
 * The plugin lane's git plumbing, shared by `publish-plugin.ts` and
 * `verify-plugin-published.ts` (foundations#101).
 *
 * These two scripts are siblings by design - one writes the plugin repo, the
 * other re-clones it and checks what landed - and they were carrying identical
 * copies of this block. That is a drift vector as much as a duplication: the
 * verify exists to disagree with the publish when something went wrong, and it
 * can only do that honestly if the machinery underneath them is the same
 * machinery rather than two copies that happen to match today.
 *
 * Nothing here decides WHAT is published. That policy lives in
 * `pluginPublishPlan()` in `plugin-publish.ts`, and this module never imports it.
 */
import { spawnSync } from "node:child_process";
import { redactRemote } from "./plugin-publish";

// Resolved to an absolute path rather than letting each spawn search `$PATH` at
// call time (Sonar typescript:S4036 - a writable directory earlier on PATH could
// shadow the binary, and these processes hold a publish credential). `NOSONAR`
// does not suppress hotspots, so the fix is the resolution, not a comment. Same
// idiom as `integration/harness/binary.ts` and `apps/docs/scripts/diff-board.ts`.
//
// Resolved LAZILY, on the first git call. Both scripts have paths that return
// before any git runs - `--print-plan` and the graceful token skip - and both
// are documented as needing no remote and no credential, so neither may be made
// to depend on a git binary being installed. Resolving at module load broke
// exactly that once already.
let gitBin: string | null = null;

export function resolveGit(): string {
  if (gitBin === null) {
    const found = Bun.which("git");
    if (!found) {
      throw new Error("`git` was not found on PATH.");
    }
    gitBin = found;
  }
  return gitBin;
}

/** Run a git command in `cwd`, throwing with git's own stderr on failure. */
export function git(cwd: string, ...args: string[]): string {
  const r = spawnSync(resolveGit(), args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    // `r.error` is the ONLY diagnostic when git could not be launched at all:
    // spawnSync leaves status null and both streams empty in that case, so
    // reading stderr alone would report a blank failure for a PATH problem.
    const why =
      r.stderr || r.stdout || r.error?.message || "(no output from git)";
    // REDACT THE WHOLE MESSAGE, not just the parts we wrote. `args` carries the
    // remote verbatim on a clone, and git echoes it back in its own stderr, so
    // a credential-bearing remote would reach CI logs through the one error
    // path every git call in this lane shares.
    throw new Error(redactRemote(`git ${args.join(" ")} failed:\n${why}`));
  }
  return r.stdout;
}

/** Run a git command for its EXIT STATUS, not its output, and never throw.
 *
 *  `git diff --cached --quiet` answers a question - is anything staged? - by
 *  exiting non-zero, so routing it through {@link git} would turn its normal
 *  "yes, there are changes" answer into an error. The publisher's idempotence
 *  check is exactly that question. */
export function gitStatus(cwd: string, ...args: string[]): number {
  return spawnSync(resolveGit(), args, { cwd, encoding: "utf8" }).status ?? -1;
}

/** Thrown to leave a work block with a chosen exit code without skipping the
 *  `finally` that removes the temporary clone. `process.exit()` terminates
 *  without unwinding, so calling it inside the `try` would leave a full clone
 *  behind - on the refusal path AND on the no-op path, which is the common
 *  outcome of a healthy repeat promote. Verified:
 *  `node -e "try{process.exit(3)}finally{console.log('x')}"` prints nothing. */
export class Done extends Error {
  constructor(readonly code: number) {
    super(`done(${code})`);
  }
}

/** Single-quote a value for a shell command a human is meant to paste. POSIX
 *  has no escape inside single quotes, so an embedded quote closes the string,
 *  adds an escaped one, and reopens: `'` becomes `'\''`. */
export function shellQuote(value: string): string {
  const escaped = value.replaceAll("'", String.raw`'\''`);
  return `'${escaped}'`;
}
