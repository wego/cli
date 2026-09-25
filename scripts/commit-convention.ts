#!/usr/bin/env bun
// The Conventional Commits contract for this repository, shared by two callers:
//
//   - `.husky/commit-msg` checks the message you just wrote, locally.
//   - `ci-cli` checks the pull request title, which is the one that matters:
//     pull requests are squashed, the squash takes its subject from the title,
//     and release-please reads that subject to compute the next version and
//     write the changelog. The title is edited on GitHub after every local hook
//     has run, so the hook can only catch habits early, not enforce this.
//
// `.coderabbit.yaml` states the same convention in prose for the reviewer bot
// (`mode: error`). commit-convention.test.ts asserts both lists below appear in
// that prose so they cannot drift.

/**
 * Types release-please understands. `fix` produces a patch, `feat` a minor, and
 * a `!` or a `BREAKING CHANGE:` footer a major. The rest produce no release.
 *
 * Closed set: an unrecognised type means a release that silently does not
 * happen.
 */
export const TYPES = [
  "feat",
  "fix",
  "docs",
  "test",
  "chore",
  "refactor",
  "perf",
  "ci",
  "build",
] as const;

/**
 * Scopes are deliberately not a closed set: history carries many legitimate
 * ones (`rehearsal`, `codeowners`, `audit`, `repo`, `review`, ...) and
 * Dependabot adds `deps`. A closed list would reject honest work and push
 * people towards `--no-verify`, which costs more than a scope typo.
 *
 * So the shape is checked and the spelling is not. This list is the common
 * scopes, quoted back in the error so a typo stands out, and asserted against
 * `.coderabbit.yaml` so the two stay in step.
 */
export const KNOWN_SCOPES = [
  "cli",
  "release",
  "release-signing",
  "signing",
  "edge",
  "promote",
  "rollback",
  "update",
  "notice",
  "runbook",
  "skill",
  "auth",
  "ci",
  "hooks",
  "deps",
] as const;

/** Lowercase kebab, which every scope in this repository's history uses. */
const SCOPE_SHAPE = /^[a-z][a-z0-9-]*$/;

/**
 * Headers `git commit --fixup` writes for an autosquash. The rebase that
 * consumes them discards them, so they never become a real subject.
 */
const AUTOSQUASH = [/^fixup! /, /^squash! /, /^amend! /] as const;

/**
 * Headers git offers during a merge or a revert. `Merge the two release docs`
 * could be an ordinary subject, so these pass only when the repository state
 * shows a merge or revert in progress.
 */
const IN_PROGRESS = [/^Merge /, /^Revert "/] as const;

const HEADER =
  /^(?<type>[a-z]+)(?:\((?<scope>[^()]+)\))?(?<breaking>!)?: (?<subject>.+)$/;

const MAX_HEADER = 100;

export type Problem = { readonly line: string; readonly hint?: string };

/**
 * Check one Conventional Commits header. Takes the header alone or a whole
 * commit message; only the first line is a contract, the body is free text.
 *
 * `exempt` says this is a commit message, so headers git writes are allowed
 * through, including a `#`-prefixed one (git's sign of an aborted commit). A
 * pull request title is never written by git, so `Merge the two release docs`
 * and `# release` are checked like any other title.
 *
 * `inProgress` is the repository state behind the `Merge `/`Revert "` pass. The
 * caller reads it so this function stays pure.
 *
 * Returns every problem rather than the first, so one run shows everything to
 * fix.
 */
export function checkHeader(
  message: string,
  { exempt = false, inProgress = false } = {},
): Problem[] {
  const header = message.split("\n", 1)[0]?.trim() ?? "";

  if (header === "") return [];
  if (exempt && header.startsWith("#")) return [];
  if (exempt && AUTOSQUASH.some((pattern) => pattern.test(header))) return [];
  if (exempt && inProgress && IN_PROGRESS.some((p) => p.test(header))) {
    return [];
  }

  const match = HEADER.exec(header);
  if (!match?.groups) {
    return [
      {
        line: `not a Conventional Commits header: ${header}`,
        hint: `expected \`type(scope): subject\`, e.g. \`fix(update): keep the ring when the manifest is unreadable\`\n  types:  ${TYPES.join(", ")}\n  scopes in use: ${KNOWN_SCOPES.join(", ")}`,
      },
    ];
  }

  const { type, scope, subject } = match.groups as {
    type: string;
    scope?: string;
    subject: string;
  };
  const problems: Problem[] = [];

  if (!(TYPES as readonly string[]).includes(type)) {
    problems.push({
      line: `unknown type \`${type}\``,
      hint: `release-please only reads: ${TYPES.join(", ")}`,
    });
  }

  if (scope !== undefined && !SCOPE_SHAPE.test(scope)) {
    problems.push({
      line: `scope \`${scope}\` is not lowercase kebab-case`,
      hint: `scopes in use: ${KNOWN_SCOPES.join(", ")}`,
    });
  }

  if (/^[A-Z]/.test(subject)) {
    problems.push({
      line: "subject starts with a capital - it is lowercase and imperative",
    });
  }

  if (subject.endsWith(".")) {
    problems.push({ line: "subject ends with a full stop - drop it" });
  }

  if (header.length > MAX_HEADER) {
    problems.push({
      line: `header is ${header.length} characters, over the ${MAX_HEADER} limit`,
    });
  }

  return problems;
}

/**
 * Usage:
 *
 *   commit-convention.ts --file <path>    a commit message git wrote out
 *   commit-convention.ts --title <text>   a pull request title
 *
 * The mode is explicit, never inferred from whether the argument is an existing
 * path: in CI the argument is the pull request title, attacker-chosen text on a
 * public repository, and a title like `package.json` must not make the gate
 * read that file and print its first line into a public log.
 *
 * Exits 1 on a problem, 2 on bad usage.
 */
if (import.meta.main) {
  const [mode, value] = process.argv.slice(2);
  // An empty value is rejected here because `checkHeader` treats an empty
  // header as an aborted commit message and passes it.
  if ((mode !== "--file" && mode !== "--title") || !value) {
    console.error("usage: commit-convention.ts --file <path> | --title <text>");
    process.exit(2);
  }

  const fromFile = mode === "--file";
  let message = value;
  if (fromFile) {
    try {
      message = await Bun.file(value).text();
    } catch {
      console.error(`commit-convention.ts: cannot read ${value}`);
      process.exit(2);
    }
  }

  // Marker files git writes while a merge, revert or cherry-pick is unfinished.
  // Only their presence lets a `Merge ...` subject through.
  const inProgress =
    fromFile &&
    (await Promise.all(
      ["MERGE_HEAD", "REVERT_HEAD", "CHERRY_PICK_HEAD"].map((marker) =>
        Bun.file(`${process.env.GIT_DIR ?? ".git"}/${marker}`).exists(),
      ),
    ).then((found) => found.includes(true)));

  const problems = checkHeader(message, { exempt: fromFile, inProgress });

  if (problems.length > 0) {
    console.error(`\n  ${message.split("\n", 1)[0]?.trim()}\n`);
    for (const problem of problems) {
      console.error(`  x ${problem.line}`);
      if (problem.hint) console.error(`    ${problem.hint}`);
    }
    console.error("");
    process.exit(1);
  }
}
