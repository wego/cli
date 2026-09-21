import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkHeader, KNOWN_SCOPES, TYPES } from "./commit-convention";

// The mutations this suite kills:
//   - the header regex loosened to accept a missing colon or unbalanced scope parens
//     -> a "rejects" case passes.
//   - a type dropped from TYPES -> release-please stops seeing that release; the parity
//     test against .coderabbit.yaml goes red.
//   - the merge/revert/fixup exemptions applied unconditionally -> a pull request titled
//     "Merge the two release docs" walks past the gate release-please reads.
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

describe("headers git writes for you, in a commit message", () => {
  it.each([
    "fixup! fix(cli): keep the ring",
    "squash! fix(cli): keep the ring",
  ])("leaves the autosquash header %s alone", (header) => {
    expect(checkHeader(header, { exempt: true })).toEqual([]);
  });

  it("leaves a comment-only message alone - git writes that when you abort", () => {
    expect(
      checkHeader("# please enter the commit message", { exempt: true }),
    ).toEqual([]);
  });

  it("leaves an empty message alone", () => {
    expect(checkHeader("")).toEqual([]);
  });
});

// `Merge ...` and `Revert "..."` are ordinary English. The words alone cannot earn
// the pass, so the repository state has to agree that a merge or a revert is what
// is happening.
describe("merge and revert headers, in a commit message", () => {
  it.each([
    "Merge branch 'main' into feature",
    'Revert "fix(cli): keep the ring"',
  ])("accepts %s while a merge or revert is in progress", (header) => {
    expect(checkHeader(header, { exempt: true, inProgress: true })).toEqual([]);
  });

  it.each([
    "Merge the two release docs",
    'Revert "the flaky retry" by hand',
  ])("rejects %s on an ordinary commit", (header) => {
    expect(
      checkHeader(header, { exempt: true, inProgress: false }),
    ).not.toEqual([]);
  });
});

// The exemptions exist for headers GIT wrote. A pull request title is written by a
// person, so none of them apply - and the title is the one string release-please
// reads. `ci-cli` calls `--title`, which leaves exempt off.
describe("the same prefixes in a pull request title", () => {
  it.each([
    "Merge the two release docs",
    'Revert "the flaky retry"',
    "fixup! the help text",
    "# release",
    "#123 fix the ring",
  ])("rejects %s", (title) => {
    expect(checkHeader(title)).not.toEqual([]);
  });

  it("rejects a merge-shaped title even if a merge is somehow in progress", () => {
    expect(
      checkHeader("Merge the two release docs", { inProgress: true }),
    ).not.toEqual([]);
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
  // The `requirements:` block alone, not the whole file: `hooks` and `deps` both
  // occur in unrelated comments, so a file-wide search passes while the list the
  // bot actually judges against is missing them.
  //
  // Parsed, not matched. A regex for this block has to hard-code the indent of the
  // key that ends it, and a reformatted file would then over-capture into the
  // comments this test exists to exclude - passing, vacuously.
  const coderabbit = Bun.YAML.parse(
    readFileSync(join(import.meta.dir, "..", ".coderabbit.yaml"), "utf8"),
  ) as {
    reviews?: { pre_merge_checks?: { title?: { requirements?: string } } };
  };
  const requirements =
    coderabbit.reviews?.pre_merge_checks?.title?.requirements ?? "";

  it("finds the title requirements block", () => {
    expect(requirements).toContain("Conventional Commits");
  });

  it.each([...TYPES])("names the type %s", (type) => {
    expect(requirements).toContain(type);
  });

  it.each([...KNOWN_SCOPES])("names the scope %s", (scope) => {
    expect(requirements).toContain(scope);
  });
});
