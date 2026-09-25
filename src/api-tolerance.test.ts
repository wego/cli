import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

/**
 * Response schemas stay tolerant in value.
 *
 * Checks A, B and C (`api-contract.ts`, `api-contract.test.ts`) ask whether a
 * shape still lines up. This asks whether the CLI's parser has promised that a
 * value set will never grow.
 *
 * A closed set fails the whole response on an unknown value, and every
 * installed binary has it compiled in. When the API adds a value (an additive,
 * contract-compatible change), every CLI already installed starts rejecting
 * whole responses, and the only fix is for everyone to upgrade.
 *
 * Check A does not cover this. It compares the CLI's schema against the
 * contract as it stands, so a closed set that matches today passes, and fails
 * only on the next refresh, after the API has shipped the new value and the
 * brittle binaries are already out. Check A protects the next build; this
 * protects the installed base.
 *
 * Type safety is kept: the generated types carry the contract's enums, so the
 * compiler knows every value. Only the runtime parser stays open, and a command
 * that branches on a value says so in CLOSED_SET_ALLOWLIST.
 *
 * This is an AST walk, not a text scan, because the mentions of `z.enum` and
 * `.refine` in api.ts are comments explaining this rule. A grep would flag the
 * documentation itself.
 */

const SOURCE = new URL("./api.ts", import.meta.url);

const source = ts.createSourceFile(
  "api.ts",
  readFileSync(SOURCE, "utf8"),
  ts.ScriptTarget.ESNext,
  true,
);

/** Zod calls that close a value set, or hide an invariant from every type. */
function findCalls(names: {
  zodFactories?: string[];
  methods?: string[];
}): Array<{ line: number; text: string }> {
  const hits: Array<{ line: number; text: string }> = [];
  const firstLine = (node: ts.Node): string =>
    (node.getText(source).split("\n")[0] ?? "").slice(0, 90);
  const walk = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const member = node.expression.name.text;
      const onZod =
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "z";
      const matches = onZod
        ? (names.zodFactories ?? []).includes(member)
        : (names.methods ?? []).includes(member);
      if (matches) {
        hits.push({
          line:
            source.getLineAndCharacterOfPosition(node.getStart(source)).line +
            1,
          text: firstLine(node),
        });
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return hits;
}

/** Closed sets a command branches on, each naming the branch that justifies it.
 *  Empty while no command branches on a value the API sends. */
const CLOSED_SET_ALLOWLIST: Array<{ line: number; because: string }> = [];

describe("response schemas stay tolerant in value", () => {
  it("finds zod calls at all (the walk is not silently empty)", () => {
    // Without this, a broken walk would report zero offenders and read as a
    // pass.
    expect(
      findCalls({ zodFactories: ["string", "object"] }).length,
    ).toBeGreaterThan(10);
  });

  it("declares no cross-field .refine on a response schema", () => {
    const offenders = findCalls({ methods: ["refine", "superRefine"] }).map(
      ({ line, text }) =>
        `api.ts:${line} - ${text}\n  A response schema must not carry a cross-field .refine: no type can see a predicate, so Check A never reports it and neither does any other gate. Move the invariant to the API, where a redeploy can fix a mistake.`,
    );
    expect(offenders).toEqual([]);
  });

  it("uses no closed value set a command does not branch on", () => {
    const allowed = new Set(CLOSED_SET_ALLOWLIST.map((entry) => entry.line));
    const offenders = findCalls({ zodFactories: ["enum", "literal"] })
      .filter(({ line }) => !allowed.has(line))
      .map(
        ({ line, text }) =>
          `api.ts:${line} - ${text}\n  A closed set fails the WHOLE response on an unknown value, and every installed binary carries it compiled in. Use z.string() unless a command branches on the value - if one does, add its line to CLOSED_SET_ALLOWLIST with that branch.`,
      );
    expect(offenders).toEqual([]);
  });
});
