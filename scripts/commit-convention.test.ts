import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkHeader, TYPES } from "./commit-convention";

// The mutations this suite kills:
//   - the header regex loosened to accept a missing colon or unbalanced scope parens
//     -> a "rejects" case passes.
//   - a type dropped from TYPES -> release-please stops seeing that release; the parity
//     test against .coderabbit.yaml goes red.
//   - the merge/revert/fixup exemptions removed -> git's own headers start failing commits.
//   - the check made to return on the first problem -> "reports every problem" fails.
//   - the scope check tightened back into a closed list -> `feat(hotels)`, the example
//     CONTRIBUTING.md gives contributors, stops being accepted.

describe("headers this repository writes", () => {
  it.each([
    "fix(update): keep the ring when the manifest is unreadable",
    "feat(hotels): add --sort for room rates",
    "docs: explain how a promote picks its bytes",
    "chore(cli): release 1.3.1",
    "chore(deps): bump zod from 4.6.1 to 4.6.2",
    "ci(release-signing): pin the fulcio roots",
    "feat(cli)!: drop the bare --json flag",
  ])("accepts %s", (header) => {
    expect(checkHeader(header)).toEqual([]);
  });
});

describe("headers that would cost a release", () => {
  it("rejects a type release-please does not read", () => {
    const problems = checkHeader("feature(cli): add a thing");
    expect(problems.map((p) => p.line).join(" ")).toContain("unknown type");
  });

  it("rejects a header with no type at all", () => {
    expect(checkHeader("add a thing")).not.toEqual([]);
  });

  it("rejects a header with no space after the colon", () => {
    expect(checkHeader("fix(cli):keep the ring")).not.toEqual([]);
  });

  it("rejects a scope that is not lowercase kebab-case", () => {
    expect(
      checkHeader("fix(Release Signing): a thing")
        .map((p) => p.line)
        .join(" "),
    ).toContain("kebab-case");
  });

  it("rejects a capitalised subject", () => {
    expect(
      checkHeader("fix(cli): Keep the ring")
        .map((p) => p.line)
        .join(" "),
    ).toContain("capital");
  });

  it("rejects a trailing full stop", () => {
    expect(
      checkHeader("fix(cli): keep the ring.")
        .map((p) => p.line)
        .join(" "),
    ).toContain("full stop");
  });

  it("rejects a header over the length limit", () => {
    expect(
      checkHeader(`fix(cli): ${"a".repeat(120)}`)
        .map((p) => p.line)
        .join(" "),
    ).toContain("over the");
  });

  it("reports every problem at once, not just the first", () => {
    expect(checkHeader("feature(cli): Do it.").length).toBeGreaterThan(2);
  });
});

describe("headers git writes for you", () => {
  it.each([
    "Merge branch 'main' into feature",
    'Revert "fix(cli): keep the ring"',
    "fixup! fix(cli): keep the ring",
    "squash! fix(cli): keep the ring",
    "# comment-only message, the commit is being aborted",
    "",
  ])("leaves %s alone", (header) => {
    expect(checkHeader(header)).toEqual([]);
  });
});

describe("the body is free text", () => {
  it("checks only the first line", () => {
    expect(
      checkHeader("fix(cli): keep the ring\n\nAnything At All. Capitals."),
    ).toEqual([]);
  });
});

// `.coderabbit.yaml` asks the reviewer bot to enforce this convention in prose, and
// `ci-cli` enforces it as a gate. Prose and code drift. This is what stops them.
describe("the convention the reviewer bot is told about", () => {
  const coderabbit = readFileSync(
    join(import.meta.dir, "..", ".coderabbit.yaml"),
    "utf8",
  );

  it.each([...TYPES])("names the type %s", (type) => {
    expect(coderabbit).toContain(type);
  });
});
