import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

/**
 * Response schemas stay tolerant in VALUE.
 *
 * Checks A, B and C all ask whether a shape still lines up. This asks something
 * they cannot: whether the CLI's parser has quietly promised that a value set
 * will never grow.
 *
 * The failure it prevents is the only one in this repository that cannot be
 * fixed after the fact. A closed set fails the WHOLE response on an unknown
 * value, and every installed binary carries it compiled in. So the API adds a
 * value - additive, contract intact, nobody at fault - and every CLI already on
 * a laptop starts rejecting whole responses, with no fix but "everyone please
 * upgrade".
 *
 * Note this is NOT covered by Check A. Check A compares the CLI's schema
 * against the contract as it stands, so a closed set that matches the contract
 * today passes. It fails only on the next refresh - which is after the API has
 * shipped the new value, and long after the brittle binaries went out.
 * Check A protects the next build; this protects the installed base.
 *
 * Type safety is not what is given up. The generated types carry the contract's
 * enums (`code` is a ten-value union in `api-types.d.ts`), so the compiler
 * knows every value. Only the runtime parser stays open, and a command that
 * genuinely branches on a value says so in CLOSED_SET_ALLOWLIST.
 *
 * AN AST WALK, NOT A TEXT SCAN, and that is load-bearing. Every current mention
 * of `z.enum` and `.refine` in api.ts sits inside a COMMENT explaining this very
 * rule - a grep reports five offenders and all five are the documentation. A
 * check that cries wolf on its own rationale teaches people to weaken it.
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

/** Closed sets a command genuinely branches on. An entry here is the "branch
 *  that justifies it", named - which is what the rule asks for. Empty today: no
 *  command branches on any value the API sends. */
const CLOSED_SET_ALLOWLIST: Array<{ line: number; because: string }> = [];

describe("response schemas stay tolerant in value", () => {
  it("finds zod calls at all (the walk is not silently empty)", () => {
    // Without this, a broken walk would report zero offenders and read as a
    // pass - the same vacuity Check A guards against with its `never` arm.
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
