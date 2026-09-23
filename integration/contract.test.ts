/**
 * The contract check can fail. A validator that passes everything would make every
 * scenario vacuous, so each way it rejects is pinned here once.
 */

import { describe, expect, it } from "bun:test";
import {
  matchOperation,
  operationById,
  validate,
  validateRequest,
  validateResponse,
} from "./harness/contract";
import { problem, startFake } from "./harness/fake";

describe("contract check", () => {
  it("matches a literal segment over a template", () => {
    expect(matchOperation("GET", "/v1/places/nearby")?.op.operationId).toBe(
      "getNearbyPlaces",
    );
    expect(matchOperation("GET", "/v1/flights/trips/T1")?.pathParams).toEqual({
      tripId: "T1",
    });
    expect(matchOperation("GET", "/v1/nowhere")).toBeUndefined();
  });

  it("rejects a body missing a required field", () => {
    const op = operationById("getNearbyPlaces");
    // The shape the retired in-process stub served: no totalCandidates, hasMore
    // or origin.resolvedFrom. The fake would have caught it.
    const errors = validateResponse(op, 200, "application/json", {
      results: [{ code: "LCY", name: "London City Airport", type: "airport" }],
      metadata: {
        resultCount: 1,
        origin: { latitude: 51.5, longitude: -0.12 },
      },
    });
    expect(errors).toContain("200 body.metadata.totalCandidates: required");
    expect(errors).toContain("200 body.metadata.origin.resolvedFrom: required");
  });

  it("rejects an undeclared status and an undeclared media type", () => {
    const op = operationById("getCurrentUser");
    expect(validateResponse(op, 410, "application/json", {})).toEqual([
      "status 410: not declared by getCurrentUser",
    ]);
    expect(validateResponse(op, 200, "text/html", {})[0]).toContain(
      "media type text/html",
    );
  });

  it("rejects an undeclared or out-of-range query parameter", () => {
    const op = operationById("getFlightSearchResults");
    const url = new URL(
      "http://x/v1/flights/searches/s1/results?pageSize=51&nope=1",
    );
    expect(validateRequest(op, url, { searchId: "s1" }, undefined)).toEqual([
      "query pageSize: above 50",
      "query nope: not declared by getFlightSearchResults",
    ]);
  });

  it("rejects a value outside an enum and a wrong type", () => {
    expect(validate("x", { type: "string", enum: ["a"] })).toEqual([
      '$: "x" not in enum',
    ]);
    expect(validate(1, { type: "string" })).toEqual([
      "$: expected string, got integer",
    ]);
  });

  it("fails loudly on a keyword it does not implement", () => {
    expect(validate({}, { type: "object", patternProperties: {} })).toEqual([
      '$: unsupported schema keyword "patternProperties"',
    ]);
  });

  it("records a request no route expects, and an invalid fixture", async () => {
    const fake = startFake({
      routes: [{ op: "getCurrentUser", answers: [{ status: 200, body: {} }] }],
    });
    try {
      const auth = { authorization: "Bearer access-1" };
      await fetch(`${fake.url}/v1/user`, { headers: auth });
      await fetch(`${fake.url}/v1/places?query=x`, { headers: auth });
      expect(fake.violations).toEqual([
        "getCurrentUser fixture 200 body.sub: required",
        "getPlaces /v1/places?query=x: no route expects it",
      ]);
    } finally {
      fake.stop();
    }
  });

  it("answers a token it does not accept with the contract's 401", async () => {
    const fake = startFake({
      routes: [{ op: "getCurrentUser", answers: [problem(401, "x")] }],
    });
    try {
      const res = await fetch(`${fake.url}/v1/user`, {
        headers: { authorization: "Bearer stolen" },
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toBe("application/problem+json");
      expect(fake.violations).toEqual([]);
    } finally {
      fake.stop();
    }
  });
});
