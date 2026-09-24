/**
 * The fake the binary talks to: one `Bun.serve` on a free loopback port, serving
 * the API (`/v1/…`) and the auth server's token endpoint.
 *
 * Every request is matched to a scenario route by `operationId`, checked against
 * the contract, and answered from that route's queue (the last answer repeats, so a
 * settle loop that re-reads is served without the scenario counting reads). Every
 * answer is checked against the contract too. A request no route expects, or any
 * contract violation in either direction, is recorded, and `expectClean` fails the
 * test with all of them. The fake itself never throws into the binary: it answers a
 * 500 the contract does not declare, so the violation is visible from both sides.
 */

import {
  matchOperation,
  operationById,
  validateRequest,
  validateResponse,
} from "./contract";

/** What a route answers with. A JSON body is sent as `application/json` below 400
 *  and `application/problem+json` from 400, which is what the API does. */
export type Answer =
  | { status: number; body?: unknown; headers?: Record<string, string> }
  /** A 200 whose body is not JSON: what a proxy's error page looks like. A body
   *  cut off mid-read is `startDropper({ partial: true })`. */
  | { fault: "non-json" };

export interface Route {
  /** The contract's `operationId`, e.g. `getCurrentUser`. */
  op: string;
  answers: Answer[];
  /** Match only requests this accepts; lets two routes share an operation. */
  when?: (seen: Seen) => boolean;
}

/** One request, as the binary sent it. */
export interface Seen {
  op: string;
  method: string;
  path: string;
  query: URLSearchParams;
  pathParams: Record<string, string>;
  headers: Headers;
  body: unknown;
  /** The bearer token, if one was sent. */
  token?: string;
}

/** One request to the auth server's token endpoint. */
export interface TokenRequest {
  grantType: string;
  form: URLSearchParams;
}

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  token_type?: string;
}

export interface FakeOptions {
  routes?: Route[];
  /** Bearer tokens the API accepts; any other token is answered 401. A refresh
   *  adds the token it issues. */
  accept?: string[];
  /** Answers for `grant_type=refresh_token`, in order, the last repeating. A
   *  `TokenSet` is a 200; an `Answer` is sent as is. */
  refresh?: (TokenSet | Answer)[];
}

export interface Fake {
  url: string;
  /** The auth server's authorize and token endpoints, served by the same fake. */
  authorizeUrl: string;
  tokenUrl: string;
  seen: Seen[];
  tokenRequests: TokenRequest[];
  violations: string[];
  /** Arm the authorization-code grant: what `authorize()` in `login.ts` issued. */
  armCode: (grant: {
    code: string;
    codeChallenge: string;
    redirectUri: string;
    tokens: TokenSet;
  }) => void;
  /** The requests one operation received, in order. */
  requests: (op: string) => Seen[];
  stop: () => void;
}

export const TEST_CLIENT_ID = "integration-client";

const TOKEN_PATH = "/oauth/token";
const AUTHORIZE_PATH = "/oauth/authorize";

export function problem(
  status: number,
  code: string,
  detail = code,
  headers: Record<string, string> = {},
): Answer {
  return {
    status,
    headers: { "x-trace-id": `trace-${status}`, ...headers },
    body: {
      type: "about:blank",
      title: code,
      status,
      detail,
      instance: "/v1",
      code,
      trace_id: `trace-${status}`,
    },
  };
}

async function sha256Base64Url(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Buffer.from(digest).toString("base64url");
}

function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type":
        status >= 400 ? "application/problem+json" : "application/json",
      ...headers,
    },
  });
}

function oauthError(error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

/** The start of an answer whose length promises far more body than is sent. */
const PARTIAL_ANSWER =
  "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 4096\r\n\r\n{";

/** A port that accepts a connection and closes it, either before any answer (a
 *  reset) or, with `partial`, one byte into a 4096-byte body. A `Bun.serve` handler
 *  can produce neither: it rewrites the length to match the body it is given. Point
 *  `WEGO_API_URL` at it. */
export function startDropper(opts: { partial?: boolean } = {}): {
  url: string;
  stop: () => void;
} {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket) {
        if (opts.partial) socket.write(PARTIAL_ANSWER);
        socket.end();
      },
    },
  });
  return {
    url: `http://127.0.0.1:${listener.port}`,
    stop: () => listener.stop(true),
  };
}

export function startFake(options: FakeOptions = {}): Fake {
  const routes = (options.routes ?? []).map((route) => {
    operationById(route.op); // a typo in a scenario fails here, by name
    return { ...route, served: 0 };
  });
  const accepted = new Set(options.accept ?? ["access-1"]);
  const refreshAnswers = options.refresh ?? [];
  let refreshServed = 0;
  let armed:
    | {
        code: string;
        codeChallenge: string;
        redirectUri: string;
        tokens: TokenSet;
      }
    | undefined;
  const seen: Seen[] = [];
  const tokenRequests: TokenRequest[] = [];
  const violations: string[] = [];

  async function token(req: Request): Promise<Response> {
    const form = new URLSearchParams(await req.text());
    const grantType = form.get("grant_type") ?? "";
    tokenRequests.push({ grantType, form });
    if (form.get("client_id") !== TEST_CLIENT_ID) {
      violations.push(`token: client_id ${form.get("client_id")}`);
      return oauthError("invalid_client");
    }
    if (grantType === "authorization_code") {
      if (!armed || form.get("code") !== armed.code) {
        return oauthError("invalid_grant");
      }
      const verifier = form.get("code_verifier") ?? "";
      if ((await sha256Base64Url(verifier)) !== armed.codeChallenge) {
        violations.push(
          "token: code_verifier does not match the S256 challenge",
        );
        return oauthError("invalid_grant");
      }
      if (form.get("redirect_uri") !== armed.redirectUri) {
        violations.push(`token: redirect_uri ${form.get("redirect_uri")}`);
        return oauthError("invalid_grant");
      }
      accepted.add(armed.tokens.access_token);
      return json(200, { token_type: "Bearer", ...armed.tokens });
    }
    if (grantType === "refresh_token") {
      const answer =
        refreshAnswers[Math.min(refreshServed, refreshAnswers.length - 1)];
      refreshServed += 1;
      if (!answer) return oauthError("invalid_grant");
      if ("access_token" in answer) {
        accepted.add(answer.access_token);
        return json(200, { token_type: "Bearer", ...answer });
      }
      return send(answer);
    }
    return oauthError("unsupported_grant_type");
  }

  function send(answer: Answer): Response {
    if ("fault" in answer) {
      return new Response("<html>Bad gateway</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }
    return json(answer.status, answer.body ?? {}, answer.headers);
  }

  async function api(req: Request, url: URL): Promise<Response> {
    const match = matchOperation(req.method, url.pathname);
    if (!match) {
      violations.push(
        `${req.method} ${url.pathname}: not an operation in the contract`,
      );
      return new Response("not in contract", { status: 500 });
    }
    const { op, pathParams } = match;
    const text = await req.text();
    let body: unknown;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        violations.push(`${op.operationId}: request body is not JSON`);
      }
    }
    const token = /^Bearer (.+)$/.exec(
      req.headers.get("authorization") ?? "",
    )?.[1];
    const s: Seen = {
      op: op.operationId,
      method: req.method,
      path: url.pathname,
      query: url.searchParams,
      pathParams,
      headers: req.headers,
      body,
      token,
    };
    seen.push(s);
    for (const v of validateRequest(op, url, pathParams, body)) {
      violations.push(`${op.operationId} request ${v}`);
    }
    if (op.operationId !== "getHealth" && (!token || !accepted.has(token))) {
      return send(problem(401, "invalid_token", "Missing or invalid token"));
    }
    const route = routes.find(
      (r) => r.op === op.operationId && (r.when?.(s) ?? true),
    );
    if (!route || route.answers.length === 0) {
      violations.push(
        `${op.operationId} ${url.pathname}${url.search}: no route expects it`,
      );
      return new Response("unexpected", { status: 500 });
    }
    const answer =
      route.answers[Math.min(route.served, route.answers.length - 1)] ??
      route.answers[0];
    route.served += 1;
    if (answer && !("fault" in answer)) {
      for (const v of validateResponse(
        op,
        answer.status,
        answer.status >= 400 ? "application/problem+json" : "application/json",
        answer.body ?? {},
      )) {
        violations.push(`${op.operationId} fixture ${v}`);
      }
    }
    return send(answer as Answer);
  }

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === TOKEN_PATH && req.method === "POST") {
        return token(req);
      }
      if (url.pathname === AUTHORIZE_PATH) {
        violations.push("authorize: the binary fetched the authorize page");
        return new Response("browser only", { status: 400 });
      }
      return api(req, url);
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  return {
    url,
    authorizeUrl: `${url}${AUTHORIZE_PATH}`,
    tokenUrl: `${url}${TOKEN_PATH}`,
    seen,
    tokenRequests,
    violations,
    armCode: (grant) => {
      armed = grant;
    },
    requests: (op) => seen.filter((s) => s.op === op),
    stop: () => server.stop(true),
  };
}
