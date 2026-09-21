#!/usr/bin/env bun
// The Conventional Commits contract for this repository, in one place.
//
// Two callers share it, which is the whole point of the file existing:
//
//   - `.husky/commit-msg` checks the message you just wrote, locally.
//   - `ci-cli` checks the pull request TITLE, which is the one that matters:
//     pull requests here are squashed, the squash takes its subject from the
//     title, and release-please reads that subject to compute the next version
//     and write the changelog. A local hook cannot see the title, because the
//     title is edited on GitHub after every hook has run. A local hook cannot
//     enforce this. It can only stop you arriving with a habit that the gate
//     then rejects.
//
// `.coderabbit.yaml` states the same convention in prose for the reviewer bot, now
// at `mode: error`. commit-convention.test.ts asserts both lists below appear in
// that prose, so a list the bot blocks on cannot drift from the one enforced here.

/**
 * Types release-please understands. `fix` produces a patch, `feat` a minor, and
 * a `!` or a `BREAKING CHANGE:` footer a major. The rest produce no release.
 *
 * Closed set: an unrecognised type is not a style problem, it is a release that
 * silently does not happen.
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
 * Scopes are NOT a closed set, and deliberately so: 200 commits of history carry
 * 22 distinct ones (`rehearsal`, `codeowners`, `audit`, `repo`, `review` among
 * them), every one of them legitimate, and Dependabot adds `deps` without asking.
 * A closed list would reject honest work and teach people to reach for
 * `--no-verify`, which costs more than a typo in a scope ever will.
 *
 * So the shape is checked and the spelling is not. The list below is NOT all 22:
 * it is the common ones, quoted back in the error so a typo is obvious next to
 * them, and asserted against `.coderabbit.yaml` so the two stay in step.
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

/** Lowercase kebab, which is every scope this repository has ever used. */
const SCOPE_SHAPE = /^[a-z][a-z0-9-]*$/;

/** A header git itself writes or rewrites. Checking these helps nobody. */
const EXEMPT = [
  /^Merge /,
  /^Revert "/,
  /^fixup! /,
  /^squash! /,
  /^amend! /,
  /^Bumps /,
] as const;

const HEADER =
  /^(?<type>[a-z]+)(?:\((?<scope>[^()]+)\))?(?<breaking>!)?: (?<subject>.+)$/;

const MAX_HEADER = 100;

export type Problem = { readonly line: string; readonly hint?: string };

/**
 * Check one Conventional Commits header. Takes the header alone or a whole
 * commit message; only the first line is a contract, the body is free text.
 *
 * `exempt` applies the EXEMPT list, and only a commit message may ask for it. A
 * pull request title is never a header git wrote, so on that call site the
 * exemptions are a hole: `Merge the two release docs` and `Bumps the timeout`
 * are ordinary titles that would walk straight past the gate.
 *
 * Returns every problem rather than the first, so one run tells you everything
 * you have to fix.
 */
export function checkHeader(
  message: string,
  { exempt = false } = {},
): Problem[] {
  const header = message.split("\n", 1)[0]?.trim() ?? "";

  if (header === "" || header.startsWith("#")) return [];
  if (exempt && EXEMPT.some((pattern) => pattern.test(header))) return [];

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
 * Two callers, two explicit modes, and no guessing between them:
 *
 *   commit-convention.ts --file <path>    a commit message git wrote out
 *   commit-convention.ts --title <text>   a pull request title
 *
 * The mode is named because the earlier version inferred it - it read the
 * argument as a file when that path existed, and as literal text otherwise.
 * On the CI call site the argument is the pull request title: attacker-chosen
 * text on a public repository. A title of `package.json`, or of any path the
 * runner can read, made the gate open that file, check ITS first line, and
 * print that line into a public log. Verified: the title `package.json`
 * printed `{`.
 *
 * Exit 1 on a problem, and say which.
 */
if (import.meta.main) {
  const [mode, value] = process.argv.slice(2);
  if ((mode !== "--file" && mode !== "--title") || value === undefined) {
    console.error("usage: commit-convention.ts --file <path> | --title <text>");
    process.exit(2);
  }

  const fromFile = mode === "--file";
  const message = fromFile ? await Bun.file(value).text() : value;
  const problems = checkHeader(message, { exempt: fromFile });

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
