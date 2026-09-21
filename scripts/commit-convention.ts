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
// `.coderabbit.yaml` states the same convention in prose for the reviewer bot.
// commit-convention.test.ts asserts the type list appears there too, so the prose
// cannot drift away from what is enforced.

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
 * So the shape is checked and the spelling is not. These are the ones in use,
 * quoted back in the error so a typo is obvious next to them.
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
 * Returns every problem rather than the first, so one run tells you everything
 * you have to fix.
 */
export function checkHeader(message: string): Problem[] {
  const header = message.split("\n", 1)[0]?.trim() ?? "";

  if (header === "" || header.startsWith("#")) return [];
  if (EXEMPT.some((pattern) => pattern.test(header))) return [];

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
 * `bun run scripts/commit-convention.ts <file-or-title>` - a path when git
 * hands one over (commit-msg), the literal text otherwise (the pull request
 * title in CI). Exit 1 on a problem, and say which.
 */
if (import.meta.main) {
  const argument = process.argv[2];
  if (argument === undefined) {
    console.error("usage: commit-convention.ts <path-to-message-file|title>");
    process.exit(2);
  }

  const file = Bun.file(argument);
  const message = (await file.exists()) ? await file.text() : argument;
  const problems = checkHeader(message);

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
