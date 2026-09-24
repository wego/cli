/**
 * Every fixture satisfies the contract. The fake checks each answer as it serves
 * it; this checks the ones no scenario happens to serve, and names the file when
 * a contract refresh invalidates one.
 */

import { describe, expect, it } from "bun:test";
import { operationById, validateResponse } from "./harness/contract";
import { allFixtures } from "./harness/fixtures";

describe("fixtures", () => {
  for (const [name, fixture] of allFixtures()) {
    it(`${name} is a valid ${fixture.op} ${fixture.status}`, () => {
      const op = operationById(fixture.op);
      const media =
        fixture.status >= 400 ? "application/problem+json" : "application/json";
      expect(validateResponse(op, fixture.status, media, fixture.body)).toEqual(
        [],
      );
    });
  }
});
