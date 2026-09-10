/**
 * Loopback redirect listener (RFC 8252 §7.3): a tiny HTTP server on
 * `127.0.0.1` at an ephemeral port. The AS redirects the browser here with the
 * authorization `code`; we validate `state` (CSRF), hand the code back to the
 * login flow, and show the user a "you may close this window" page.
 */

export interface LoopbackListener {
  /** `http://127.0.0.1:<port><path>` — pass as the OAuth `redirect_uri`. */
  redirectUri: string;
  /** Resolve with the `code` once the AS redirects with a matching `state`. */
  waitForCode(expectedState: string, timeoutMs?: number): Promise<string>;
  close(): void;
}

export type CallbackOutcome =
  | { kind: "code"; code: string }
  | { kind: "error"; error: Error }
  /** Not for us — `state` didn't match. Must NOT settle/cancel the login. */
  | { kind: "ignore" };

/** The hosts a loopback redirect can legitimately arrive on (RFC 8252 §7.3).
 *  `URL.hostname` always brackets an IPv6 host, so `[::1]` is the only shape
 *  the v6 loopback can reach this set as. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Pure interpreter for a callback URL. **Origin, then state, are checked before
 * anything else**: a request from a non-loopback host, or one that doesn't
 * carry our CSRF `state` (e.g. another page on the machine hitting the loopback
 * with `?error=...`), returns `ignore` so it cannot cancel an in-progress
 * login. Only a loopback request bearing our `state` can yield a `code` or an
 * `error`. Separated from the server so it is unit-testable.
 */
export function interpretCallback(
  rawUrl: string,
  expectedState: string,
): CallbackOutcome {
  const url = new URL(rawUrl, "http://127.0.0.1");
  // Loopback origins only. The server path can't be anything else, and the
  // paste path is told to hand over a `127.0.0.1` address — so a URL from any
  // other host is not the redirect we are waiting for. Defence in depth rather
  // than a live hole: the exchange always uses the listener's own redirect_uri
  // and this process's PKCE verifier, so a foreign code cannot be redeemed.
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    return { kind: "ignore" };
  }
  if (url.searchParams.get("state") !== expectedState) {
    return { kind: "ignore" };
  }
  const error = url.searchParams.get("error");
  if (error) {
    const desc = url.searchParams.get("error_description");
    return {
      kind: "error",
      error: new Error(
        `authorization error: ${error}${desc ? ` (${desc})` : ""}`,
      ),
    };
  }
  const code = url.searchParams.get("code");
  if (!code) {
    return {
      kind: "error",
      error: new Error("authorization callback carried no code"),
    };
  }
  return { kind: "code", code };
}

const DONE_HTML =
  "<!doctype html><meta charset=utf-8><title>wego</title><body style='font-family:system-ui;padding:2rem'>Login complete – you may close this window and return to the terminal.</body>";

// `port` defaults to 0 (ephemeral) — RFC 8252 any-port. Pass a fixed port for
// clients that register a specific loopback port rather than relying on the
// AS's port override. An empty `redirectPath` means a BARE-origin redirect_uri
// (`http://127.0.0.1:<port>`); the server then matches the root path `/` that
// the browser lands on.
export function startLoopback(
  redirectPath = "/callback",
  port = 0,
): LoopbackListener {
  // The path the loopback server matches incoming callbacks against. A bare
  // (empty) redirect_uri lands the browser on `/`, so match `/` in that case.
  const matchPath = redirectPath === "" ? "/" : redirectPath;
  let expectedState = "";
  let settle: {
    resolve: (c: string) => void;
    reject: (e: Error) => void;
  } | null = null;
  // Callbacks that arrive before `waitForCode` arms the waiter (or before the
  // expected state is known) are queued here and flushed in order once the
  // waiter attaches — so a fast valid redirect is never dropped, even if a
  // later unsolicited/wrong-state request also hits the loopback first.
  const bufferedUrls: string[] = [];
  // The live `waitForCode` deadline, so `close()` can clear it.
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;

  /** Interpret a callback URL and, if it's for us, settle the waiter. */
  function deliver(rawUrl: string): CallbackOutcome {
    const outcome = interpretCallback(rawUrl, expectedState);
    if (outcome.kind !== "ignore" && settle) {
      const s = settle;
      settle = null;
      if (outcome.kind === "code") s.resolve(outcome.code);
      else s.reject(outcome.error);
    }
    return outcome;
  }

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== matchPath) {
        return new Response("Not found", { status: 404 });
      }
      // No waiter yet (and the expected state may not be set) — hold the raw
      // callback and let `waitForCode` interpret it once state is known.
      if (!settle) {
        bufferedUrls.push(req.url);
        return new Response(DONE_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      const outcome = deliver(req.url);
      if (outcome.kind === "ignore") {
        return new Response("Unexpected request.", { status: 400 });
      }
      if (outcome.kind === "error") {
        return new Response("Login failed – see the terminal.", {
          status: 400,
        });
      }
      return new Response(DONE_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    },
  });

  return {
    // Bare (`http://127.0.0.1:<port>`) when redirectPath is ""; else host+path.
    redirectUri: `http://127.0.0.1:${server.port}${redirectPath}`,
    waitForCode(state, timeoutMs = 300_000) {
      expectedState = state;
      return new Promise<string>((resolve, reject) => {
        // The deadline tears the waiter down before it rejects: leaving
        // `settle` armed would let a late callback "complete" a login the
        // caller already gave up on, and would swallow the redirect that a
        // retry (a second `waitForCode`) should receive.
        const timer = setTimeout(() => {
          settle = null;
          pendingTimer = undefined;
          reject(new Error("login timed out"));
        }, timeoutMs);
        // `close()` clears this even when the waiter never settles — another
        // path (a pasted callback) can win the login, and a live timer holds
        // the event loop open long after the caller is done with us.
        pendingTimer = timer;
        settle = {
          resolve: (c) => {
            clearTimeout(timer);
            pendingTimer = undefined;
            resolve(c);
          },
          reject: (e) => {
            clearTimeout(timer);
            pendingTimer = undefined;
            reject(e);
          },
        };
        // Flush callbacks that arrived before the waiter was armed, in order,
        // until one settles. Unsolicited (wrong-state) ones are ignored and we
        // keep draining — so an early valid redirect isn't lost behind them.
        while (bufferedUrls.length > 0 && settle) {
          const url = bufferedUrls.shift();
          if (url) deliver(url);
        }
      });
    },
    close() {
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = undefined;
      settle = null;
      server.stop(true);
    },
  };
}
