/**
 * The plugin lane's git plumbing, shared by `publish-plugin.ts` and
 * `verify-plugin-published.ts` (foundations#101).
 *
 * One writes the plugin repo, the other re-clones it and checks what landed.
 * Sharing one copy of this plumbing keeps the two from drifting apart.
 *
 * Nothing here decides what is published. That policy lives in
 * `pluginPublishPlan()` in `plugin-publish.ts`, and this module never imports it.
 */
import { spawnSync } from "node:child_process";
import { redactRemote } from "./plugin-publish";

// Resolved to an absolute path rather than letting each spawn search `$PATH`
// (Sonar typescript:S4036: a writable directory earlier on PATH could shadow the
// binary, and these processes hold a publish credential). `NOSONAR` does not
// suppress hotspots. Same idiom as `integration/harness/binary.ts`.
//
// Resolved lazily, on the first git call: both scripts have paths that return
// before any git runs (`--print-plan` and the graceful token skip), and those
// must not depend on a git binary being installed.
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

export function git(cwd: string, ...args: string[]): string {
  const r = spawnSync(resolveGit(), args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    // `r.error` is the only diagnostic when git could not be launched at all:
    // spawnSync then leaves status null and both streams empty.
    const why =
      r.stderr || r.stdout || r.error?.message || "(no output from git)";
    // Redact the whole message, not just our parts: `args` carries the remote
    // verbatim on a clone, and git echoes it in its own stderr, so a
    // credential-bearing remote would otherwise reach CI logs.
    throw new Error(redactRemote(`git ${args.join(" ")} failed:\n${why}`));
  }
  return r.stdout;
}

/** Returns the exit status and never throws. `git diff --cached --quiet`
 *  (the publisher's idempotence check) answers "something is staged" by exiting
 *  non-zero, which {@link git} would turn into an error. */
export function gitStatus(cwd: string, ...args: string[]): number {
  return spawnSync(resolveGit(), args, { cwd, encoding: "utf8" }).status ?? -1;
}

/** Thrown to leave a work block with a chosen exit code without skipping the
 *  `finally` that removes the temporary clone. `process.exit()` terminates
 *  without unwinding (`finally` does not run), so calling it inside the `try`
 *  would leave a full clone behind on the refusal and no-op paths. */
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
