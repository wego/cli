/**
 * CREDENTIAL SHAPE: the rules `src/api.ts` follows when it attaches a credential
 * to an outbound request, asserted against its source text.
 *
 * WHY THIS FILE IS IN `scripts/` AND NOT BESIDE `src/api.ts`. That is the whole
 * point of it, so it goes first.
 *
 * `src/api.ts` is ~1,700 lines and is deliberately NOT in `.github/CODEOWNERS`.
 * Owning it would put the three release signers on a file that churns
 * constantly — the bottleneck the missing `*` line in that file exists to avoid.
 * But it is also where every outbound credential is attached: the `Bearer`
 * access token, and the `x-wego-id-token` identity assertion. This repository is
 * public, so anyone may open a pull request, and a plausible-looking change to
 * WHERE or UNDER WHAT CONDITION a credential is sent currently needs one
 * ordinary reviewer.
 *
 * `scripts/` IS code-owned. Putting the guard here means the gate and the thing
 * that can weaken the gate sit at different review bars: a pull request that
 * loosens credential attachment in `src/api.ts` fails this test, and silencing
 * this test requires a release signer. That is the protection CODEOWNERS on
 * `api.ts` would give, without the bottleneck.
 *
 * The same assertions placed in `src/api.test.ts` would buy nothing — both files
 * are unowned, so one pull request could weaken the gate AND edit its guard
 * under a single ordinary review.
 *
 * WHAT THIS DOES *NOT* PROTECT. A future reader who over-trusts this file is a
 * worse outcome than not having it, so, plainly:
 *
 *   - **It asserts what it asserts.** These are four specific structural rules.
 *     A sufficiently novel credential path can be written to satisfy every one
 *     of them — a request built outside `fetchOrUnreachable`, a token folded
 *     into a URL or a request body, a credential handed to a helper in another
 *     module. None of that is caught here.
 *   - **A reviewer still has to think.** This narrows what can be done QUIETLY.
 *     It is friction and detection, not prevention.
 *   - **It does not protect `src/api.ts` from a release signer**, and is not
 *     meant to. A signer can change both files in one pull request. The threat
 *     model is an outsider's pull request seen by one ordinary reviewer.
 *   - **It reads source text, not behaviour.** It cannot tell you the token a
 *     parameter carries is the right one, only where the parameter came from.
 *     Behavioural coverage lives in `src/api.test.ts`; this is the structural
 *     half, and the two are not substitutes.
 *
 * WHY AN AST AND NOT A REGEX. Invariants 2 and 3 are claims about SCOPE — "this
 * call is inside that `if`", "this function never assigns that property". Line
 * proximity is not scope: a `headers.set` moved one line down, out of a guard's
 * block, looks identical to grep, and is exactly the regression worth catching.
 * `typescript` is already a devDependency (it backs `bun run typecheck`), so
 * parsing costs nothing new.
 *
 * INVARIANT 4 IS THE ONE THAT MATTERS MOST. Invariants 1-3 pin gates we already
 * know about. Invariant 4 — the allowlist of header names — catches the
 * credential path nobody has thought of yet, because it fails BY DEFAULT on
 * anything new: adding a header to `src/api.ts` goes red until somebody edits
 * `scripts/`, which is to say until a release signer looks at it. If this file
 * ever has to be cut down, cut everything before invariant 4.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

const SOURCE_PATH = "src/api.ts";

const sourceFile = ts.createSourceFile(
  SOURCE_PATH,
  readFileSync(SOURCE_PATH, "utf8"),
  ts.ScriptTarget.Latest,
  /* setParentNodes */ true,
  ts.ScriptKind.TS,
);

/** 1-based line of a node, so a failure names a place rather than a shape. */
const lineOf = (node: ts.Node): number =>
  sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

const where = (node: ts.Node): string => `${SOURCE_PATH}:${lineOf(node)}`;

const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Every node in the file, depth-first. */
function* walk(node: ts.Node): Generator<ts.Node> {
  yield node;
  for (const child of node.getChildren(sourceFile)) yield* walk(child);
}

const allNodes = [...walk(sourceFile)];

/** The static text of a property name or a string-ish literal, or `undefined`
 *  when it is computed. A computed name defeats every allowlist below, so
 *  `undefined` is always treated as a failure rather than quietly skipped. */
function staticName(node: ts.Node | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isStringLiteralLike(node)) return node.text;
  return undefined;
}

/** HTTP header names are case-insensitive on the wire, so every comparison here
 *  is too: `authorization` must not be a way around a rule about
 *  `Authorization`. */
const headerKey = (name: string): string => name.toLowerCase();

/** Every `headers.set(...)` call. Narrow on purpose: `res.headers.get(...)` is a
 *  read of a RESPONSE and is not a credential decision. */
const headerSetCalls = allNodes.filter(
  (node): node is ts.CallExpression =>
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "set" &&
    staticName(node.expression.expression) === "headers",
);

/** Every property of an object literal that is itself the value of a `headers:`
 *  property — the header bag handed to `fetch` inline, as `authedJsonGet` and
 *  `authedJsonPost` both do. `{ ...init, headers }` is a shorthand whose value
 *  is the `Headers` instance already covered above, so it yields nothing. */
const headerLiteralProps = allNodes
  .filter(
    (node): node is ts.PropertyAssignment =>
      ts.isPropertyAssignment(node) &&
      staticName(node.name) === "headers" &&
      ts.isObjectLiteralExpression(node.initializer),
  )
  .flatMap((node) =>
    (node.initializer as ts.ObjectLiteralExpression).properties.filter(
      (prop): prop is ts.PropertyAssignment => ts.isPropertyAssignment(prop),
    ),
  );

// ---------------------------------------------------------------------------
// Invariant 1 - every Authorization value is `Bearer ${<a parameter>}`
// ---------------------------------------------------------------------------

/** Both ways a header can be set in this file, reduced to (name, value), then
 *  narrowed to the Authorization ones. */
const authorizationSites: { name: ts.Node; value: ts.Expression }[] = [
  ...headerLiteralProps.map((prop) => ({
    name: prop.name as ts.Node,
    value: prop.initializer,
  })),
  ...headerSetCalls.map((call) => ({
    name: call.arguments[0] as ts.Node,
    value: call.arguments[1] as ts.Expression,
  })),
].filter((site) => headerKey(staticName(site.name) ?? "") === "authorization");

describe("invariant 1: Authorization carries a Bearer token from a parameter", () => {
  it("sets Authorization somewhere, so the rules below are exercised", () => {
    // Without this, removing every call site would make the cases below
    // vacuously green: `it.each([])` asserts nothing at all.
    expect(authorizationSites.length).toBeGreaterThan(0);
  });

  it.each(
    authorizationSites.map((site) => [where(site.value), site] as const),
  )("%s is a template of exactly Bearer + one interpolation", (_label, site) => {
    // A string literal here would be a hardcoded credential. A concatenation,
    // a second span or a tail would let a prefix or suffix smuggle something
    // else into the same header.
    expect(ts.isTemplateExpression(site.value)).toBe(true);
    const template = site.value as ts.TemplateExpression;
    expect(template.head.text).toBe("Bearer ");
    expect(template.templateSpans).toHaveLength(1);
    expect(template.templateSpans[0]?.literal.text).toBe("");
  });

  it.each(
    authorizationSites.map((site) => [where(site.value), site] as const),
  )("%s interpolates a bare parameter of the enclosing function", (_label, site) => {
    const template = site.value as ts.TemplateExpression;
    const interpolated = template.templateSpans[0]?.expression;

    // A bare identifier: not `process.env.X`, not `config.token`, not a call.
    // The credential must be PASSED IN, so the decision about which token to
    // send stays with the command that made it.
    expect(interpolated !== undefined && ts.isIdentifier(interpolated)).toBe(
      true,
    );
    const name = (interpolated as ts.Identifier).text;

    // ...and passed in to THIS function. A module-scope `let accessToken`
    // would satisfy the check above while turning the token into ambient state
    // that anything in 1,700 lines can write.
    const parameterNames = new Set<string>();
    for (
      let scope: ts.Node | undefined = site.value;
      scope !== undefined;
      scope = scope.parent
    ) {
      if (
        ts.isFunctionDeclaration(scope) ||
        ts.isFunctionExpression(scope) ||
        ts.isArrowFunction(scope) ||
        ts.isMethodDeclaration(scope)
      ) {
        for (const param of scope.parameters) {
          const paramName = staticName(param.name);
          if (paramName !== undefined) parameterNames.add(paramName);
        }
      }
    }
    expect([...parameterNames]).toContain(name);
  });
});

// ---------------------------------------------------------------------------
// Invariant 2 - x-wego-id-token only inside the consent guard
// ---------------------------------------------------------------------------

/** The guard the identity assertion must sit behind, normalized for whitespace
 *  so reformatting is free and reordering is not. `allowed` is the user's
 *  consent; `token` is the assertion itself. Both, or nothing is sent. */
const CONSENT_GUARD = "identityAssertion.allowed && identityAssertion.token";

const idTokenSets = headerSetCalls.filter(
  (call) =>
    headerKey(staticName(call.arguments[0]) ?? "") === "x-wego-id-token",
);

describe("invariant 2: x-wego-id-token is sent only under the consent guard", () => {
  it("is set exactly once", () => {
    // One call site is what lets "inside the guard" be a complete statement
    // about the file. A second would mean the rule below has to hold in two
    // places and a reviewer has to notice both — the situation this prevents.
    expect(idTokenSets.map(where)).toHaveLength(1);
  });

  it.each(
    idTokenSets.map((call) => [where(call), call] as const),
  )(`%s sits in the THEN branch of \`if (${CONSENT_GUARD})\``, (_label, call) => {
    // Scope, not proximity. An `if` whose ELSE branch holds the call, or an
    // `if` the call merely follows, must not count — so this walks the parent
    // chain and requires the child to be on the `thenStatement` side.
    const guards: string[] = [];
    let node: ts.Node = call;
    while (node.parent !== undefined) {
      const parent: ts.Node = node.parent;
      if (ts.isIfStatement(parent) && parent.thenStatement === node) {
        guards.push(normalize(parent.expression.getText(sourceFile)));
      }
      node = parent;
    }
    expect(guards).toContain(CONSENT_GUARD);
  });
});

// ---------------------------------------------------------------------------
// Invariant 3 - a refresh never re-decides consent
// ---------------------------------------------------------------------------

const refresh = allNodes.find(
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) &&
    node.name?.text === "refreshIdentityAssertion",
);

describe("invariant 3: refreshIdentityAssertion never assigns `allowed`", () => {
  it("exists as a function declaration with a body", () => {
    // If it is renamed or reshaped, the rules below stop applying SILENTLY.
    // Failing here sends whoever did that to this file to say why.
    expect(refresh?.body).toBeDefined();
  });

  it("assigns no property other than `token`", () => {
    // The consent decision is made once, by `setIdentityAssertion`, out of the
    // login flow. A refresh only ever learns a NEW TOKEN. A refresh that could
    // also flip `allowed` to `true` would send an identity assertion for a user
    // who declined — a consent bypass that reads like a one-word tidy-up.
    //
    // Stated as an allowlist rather than as "no property named `allowed`": a
    // computed key (`{ ["allow" + "ed"]: true }`) has no legitimate use in this
    // three-line function, and an allowlist rejects it without having to guess
    // at what it evaluates to.
    const offenders = [...walk(refresh?.body as ts.Node)]
      .filter((node) => {
        if (
          ts.isPropertyAssignment(node) ||
          ts.isShorthandPropertyAssignment(node)
        ) {
          return staticName(node.name) !== "token";
        }
        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isPropertyAccessExpression(node.left)
        ) {
          return node.left.name.text === "allowed";
        }
        return false;
      })
      .map((node) => `${where(node)}: ${normalize(node.getText(sourceFile))}`);

    expect(offenders).toEqual([]);
  });

  it("carries the previous state forward by spreading it", () => {
    // The positive half of the rule above. Not spreading would be fail-CLOSED
    // today (`allowed` would be absent, and absent is falsy), so this is not a
    // security assertion standing on its own — it pins the MECHANISM, so the
    // next person here reads "carry forward" rather than "re-derive".
    const spreads = [...walk(refresh?.body as ts.Node)]
      .filter(ts.isSpreadAssignment)
      .map((node) => normalize(node.expression.getText(sourceFile)));
    expect(spreads).toContain("identityAssertion");
  });
});

// ---------------------------------------------------------------------------
// Invariant 4 - the closed set of header names
// ---------------------------------------------------------------------------

/**
 * EVERY header name `src/api.ts` may attach via `headers.set`, and what each one
 * carries. This list is the point of the whole file: it fails by DEFAULT on
 * anything new, so a header nobody anticipated cannot be added quietly.
 *
 * To add a header: add it here, in the same pull request, with a line saying
 * what it carries. That edit is in `scripts/`, so it needs a release signer —
 * which is the review a new outbound header deserves.
 */
const ALLOWED_SET_HEADERS: Record<string, string> = {
  "user-agent": "build identification; carries no user data",
  "x-wego-session-id": "analytics uuid, pushed in per invocation",
  "x-wego-client-id": "analytics uuid, pushed in per invocation",
  "x-wego-app-version": "build version",
  "x-wego-os-type": "machine fact, not stored telemetry",
  "x-wego-os-version": "machine fact, not stored telemetry",
  "x-wego-timezone": "utc offset, computed per request",
  "x-wego-id-token": "THE identity assertion - gated by invariant 2",
};

/** The same closed set, for headers written inline into a `fetch` init object.
 *  Separate list because it is a separate mechanism: a new credential added
 *  there would never touch a `headers.set` call. */
const ALLOWED_LITERAL_HEADERS: Record<string, string> = {
  authorization: "THE access token - shaped by invariant 1",
  "content-type": "request body encoding, JSON on the POST path",
};

describe("invariant 4: no header leaves this file without being listed here", () => {
  it("names every headers.set(...) with a static string", () => {
    // `headers.set(name, value)` with a variable name would make the allowlist
    // below unenforceable, so the allowlist starts by requiring names it can read.
    const dynamic = headerSetCalls
      .filter((call) => staticName(call.arguments[0]) === undefined)
      .map((call) => `${where(call)}: ${normalize(call.getText(sourceFile))}`);
    expect(dynamic).toEqual([]);
  });

  it("sets only allowlisted header names", () => {
    const names = headerSetCalls.map((call) =>
      headerKey(staticName(call.arguments[0]) as string),
    );
    expect([...new Set(names)].sort()).toEqual(
      Object.keys(ALLOWED_SET_HEADERS).sort(),
    );
  });

  it("writes only allowlisted names into inline header objects", () => {
    const names = headerLiteralProps
      .map((prop) => staticName(prop.name))
      // A computed key inside a header bag is the same hole as a dynamic
      // `headers.set` name. Surface it as an unlistable name rather than skip it.
      .map((name) => (name === undefined ? "<computed>" : headerKey(name)));
    expect([...new Set(names)].sort()).toEqual(
      Object.keys(ALLOWED_LITERAL_HEADERS).sort(),
    );
  });
});
