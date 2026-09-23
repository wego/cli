import { describe, expect, it } from "bun:test";
import { ApiHttpError, NotFoundError, UnauthorizedError } from "./api";
import {
  EXIT,
  exitCodeForError,
  formatCliError,
  isTimeoutError,
} from "./error-report";
import { TokenEndpointUnreachableError } from "./oauth";

/** Every published code with the status `apps/api` pairs it with (`CODE_META` in
 *  `apps/api/src/errors.ts`) and the exit class it owes. Two arms have to agree
 *  on each row: the machine `code`, and the bare status a body-less or
 *  unparseable response leaves behind. */
const CODE_TAXONOMY: Record<string, { status: number; exit: number }> = {
  validation_failed: { status: 400, exit: EXIT.PERMANENT },
  invalid_token: { status: 401, exit: EXIT.AUTH },
  insufficient_scope: { status: 403, exit: EXIT.AUTH },
  not_found: { status: 404, exit: EXIT.NOT_FOUND },
  rates_require_hotel_search: { status: 409, exit: EXIT.PERMANENT },
  rate_limited: { status: 429, exit: EXIT.RETRYABLE },
  bad_gateway: { status: 502, exit: EXIT.PERMANENT },
  upstream_unavailable: { status: 503, exit: EXIT.RETRYABLE },
  upstream_rate_limited: { status: 503, exit: EXIT.RETRYABLE },
  internal_error: { status: 500, exit: EXIT.PERMANENT },
};

/** A status whose fallback class differs from `exit`, so a row passes only if
 *  the CODE decided it. Without this a dead `case` looks correct: every code
 *  here shares a status the fallback already classifies the same way. */
const decoyStatus = (exit: number) => (exit === EXIT.NOT_FOUND ? 500 : 404);

describe("exitCodeForError (issue #1110 taxonomy)", () => {
  it("maps typed auth/not-found errors", () => {
    expect(exitCodeForError(new UnauthorizedError())).toBe(EXIT.AUTH);
    expect(exitCodeForError(new NotFoundError("GET /x"))).toBe(EXIT.NOT_FOUND);
  });

  // In wego-ai this suite also cross-checked `CODE_TAXONOMY` below against the
  // API's closed `Problem.code` enum, read from `apps/api/contract/openapi.json`
  // in the same tree. That file is not in this repository, so the cross-check
  // cannot run here; it is the job of the contract-drift lane, which #127 defers
  // to a later phase. Everything below still pins the taxonomy this binary
  // ships - what each code and each bare status maps to - against the table.

  for (const [code, { status, exit }] of Object.entries(CODE_TAXONOMY)) {
    it(`maps ${code} by its machine code, over the status`, () => {
      const decoy = decoyStatus(exit);
      expect(
        exitCodeForError(new ApiHttpError(decoy, "GET /x", { code })),
      ).toBe(exit);
      // Sanity: the decoy really would have produced a different class.
      expect(exitCodeForError(new ApiHttpError(decoy, "GET /x"))).not.toBe(
        exit,
      );
    });

    it(`maps a bare ${status} (no code) to the same class as ${code}`, () => {
      expect(exitCodeForError(new ApiHttpError(status, "GET /x"))).toBe(exit);
    });
  }

  it("falls back to status for a code this binary does not know", () => {
    // A code a NEWER api emits, and the two the switch used to name but this
    // API never emitted: all three must ride the status, not a stale `case`.
    const unknown = (c: string, status: number) =>
      exitCodeForError(new ApiHttpError(status, "GET /x", { code: c }));
    expect(unknown("some_future_code", 404)).toBe(EXIT.NOT_FOUND);
    expect(unknown("unauthorized", 404)).toBe(EXIT.NOT_FOUND);
    expect(unknown("forbidden", 429)).toBe(EXIT.RETRYABLE);
  });

  it("falls back to status when the code is absent/unknown", () => {
    const status = (s: number) =>
      exitCodeForError(new ApiHttpError(s, "GET /x"));
    expect(status(401)).toBe(EXIT.AUTH);
    expect(status(403)).toBe(EXIT.AUTH);
    expect(status(404)).toBe(EXIT.NOT_FOUND);
    expect(status(429)).toBe(EXIT.RETRYABLE);
    expect(status(503)).toBe(EXIT.RETRYABLE);
    expect(status(502)).toBe(EXIT.PERMANENT);
    expect(status(400)).toBe(EXIT.PERMANENT);
  });

  it("maps timeout and network errors to the timeout class", () => {
    expect(
      exitCodeForError(new DOMException("timed out", "TimeoutError")),
    ).toBe(EXIT.TIMEOUT);
    expect(exitCodeForError(new TypeError("fetch failed"))).toBe(EXIT.TIMEOUT);
    // Whatever the platform's fetch threw, an unreached token endpoint is the
    // network class, not a generic error (Bun on Linux throws a plain Error).
    expect(
      exitCodeForError(
        new TokenEndpointUnreachableError(
          "http://127.0.0.1:9/token",
          new Error("ECONNREFUSED"),
        ),
      ),
    ).toBe(EXIT.TIMEOUT);
  });

  it("falls back to generic error for anything else", () => {
    expect(exitCodeForError(new Error("boom"))).toBe(EXIT.ERROR);
    expect(exitCodeForError("weird")).toBe(EXIT.ERROR);
  });
});

describe("isTimeoutError", () => {
  it("recognizes the AbortSignal.timeout abort", () => {
    expect(isTimeoutError(new DOMException("t", "TimeoutError"))).toBe(true);
    expect(isTimeoutError(new DOMException("a", "AbortError"))).toBe(true);
    expect(isTimeoutError(new Error("other"))).toBe(false);
  });
});

describe("formatCliError (actionable stderr line)", () => {
  it("includes code, detail, trace_id, and Retry-After for an API error", () => {
    const msg = formatCliError(
      new ApiHttpError(503, "GET /v1/flights/searches/:id/results", {
        code: "upstream_unavailable",
        detail: "The flights service is temporarily unavailable.",
        traceId: "abc123trace",
        retryAfterSeconds: 7,
      }),
      "wego",
    );
    expect(msg).toContain("upstream_unavailable");
    expect(msg).toContain("temporarily unavailable");
    expect(msg).toContain("trace_id=abc123trace");
    expect(msg).toContain("retry after 7s");
  });

  it("adds the research-preview + feedback hint for a per-user quota rejection", () => {
    const msg = formatCliError(
      new ApiHttpError(429, "POST /v1/flights/searches", {
        code: "rate_limited",
        detail: "Too many requests.",
        retryAfterSeconds: 60,
      }),
      "wego",
    );
    expect(msg).toContain("research preview");
    expect(msg).toContain('wego feedback --message "..."');
    expect(msg).toContain("retry after 60s");
  });

  // The provider throttling Wego, which asking for a bigger allowance cannot fix.
  it("omits the feedback hint for upstream_rate_limited", () => {
    const msg = formatCliError(
      new ApiHttpError(503, "POST /v1/flights/searches", {
        code: "upstream_rate_limited",
        retryAfterSeconds: 60,
      }),
      "wego",
    );
    expect(msg).not.toContain("research preview");
    expect(msg).not.toContain("feedback");
  });

  it("names the invoked binary in the feedback hint", () => {
    const msg = formatCliError(
      new ApiHttpError(429, "POST /v1/hotels/searches", {
        code: "rate_limited",
      }),
      "wegostaging",
    );
    expect(msg).toContain('wegostaging feedback --message "..."');
  });

  it("adds a `login` hint for auth failures", () => {
    const msg = formatCliError(
      new ApiHttpError(401, "GET /v1/user", { code: "invalid_token" }),
      "wego",
    );
    expect(msg).toContain("wego login");
  });

  it("does not offer `login` as the remedy for a scope shortfall", () => {
    // Same exit class as an expired token, different fix: the session is valid,
    // so re-logging in re-requests the same scopes and 403s again.
    const msg = formatCliError(
      new ApiHttpError(403, "GET /v1/user", {
        code: "insufficient_scope",
        detail: "This token lacks the required scope.",
      }),
      "wego",
    );
    expect(msg).toContain("not authorized for this operation");
    expect(msg).toContain("would re-request the same scopes");
    expect(msg).not.toMatch(/run `wego login`/);
    expect(msg).not.toContain("—");
  });

  it("flags an unparseable error body", () => {
    const msg = formatCliError(
      new ApiHttpError(500, "GET /v1/user", { bodyParseError: true }),
      "wego",
    );
    expect(msg).toContain("unparseable error body");
  });

  it("gives a recovery hint on timeout", () => {
    const msg = formatCliError(
      new DOMException("The operation timed out.", "TimeoutError"),
      "wego",
    );
    expect(msg.toLowerCase()).toContain("timed out");
    expect(msg).toContain("retry");
  });
});
