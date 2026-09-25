/**
 * The contract check can fail. A validator that passes everything would make every
 * scenario vacuous, so each way it rejects is pinned here once, with the manifest
 * check that stands before a provided binary runs.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAgainstManifest } from "./harness/binary";
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
    // Inside a branch too, where a passing sibling would otherwise hide it.
    const unread = { type: "object", patternProperties: {} };
    for (const branches of [
      { anyOf: [unread, { type: "object" }] },
      { oneOf: [unread, { type: "object" }] },
    ]) {
      expect(validate({}, branches)).toEqual([
        '$: unsupported schema keyword "patternProperties"',
      ]);
    }
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

describe("a provided binary is checked before it runs", () => {
  it("accepts matching bytes and refuses changed or unlisted ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "wego-manifest-"));
    try {
      const bin = join(dir, "wego-linux-x64");
      writeFileSync(bin, "the built bytes");
      const sum = new Bun.CryptoHasher("sha256")
        .update("the built bytes")
        .digest("hex");
      const manifest = join(dir, "SHA256SUMS.txt");
      writeFileSync(manifest, `${sum}  wego-linux-x64\n`);
      expect(() => checkAgainstManifest(bin, manifest)).not.toThrow();

      writeFileSync(bin, "other bytes");
      expect(() => checkAgainstManifest(bin, manifest)).toThrow(
        /does not match/,
      );
      writeFileSync(manifest, `${sum}  wego-darwin-arm64\n`);
      expect(() => checkAgainstManifest(bin, manifest)).toThrow(/lists no/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
