/**
 * Each error class once, through one representative read: the exit code an agent
 * branches on, nothing on stdout, and the API's problem details on stderr. Which
 * class each status maps to is `error-report.ts`'s unit tests; here is proof the
 * binary carries it to the process boundary.
 */

import { describe, expect, it } from "bun:test";
import { type Answer, problem, startDropper } from "./harness/fake";
import { answer } from "./harness/fixtures";
import { useScenario } from "./harness/scenario";
import { signIn } from "./harness/wego";

const s = useScenario();

async function placesAnswering(...answers: Answer[]) {
  signIn(s.home);
  const fake = s.fake({ routes: [{ op: "getPlaces", answers }] });
  const result = await s.run(["places", "London"]);
  return { fake, result };
}

describe("error classes", () => {
  it("a persistent 401 with no refresh token exits 3 and names login", async () => {
    signIn(s.home, { accessToken: "access-revoked" });
    s.fake({ accept: [] });
    const result = await s.run(["places", "London"]);
    expect(result.code).toBe(3);
    expect(result.out).toBe("");
    expect(result.err).toMatch(/login/);
  });

  it("a 404 exits 4 with a hint to start again", async () => {
    signIn(s.home);
    s.fake({
      routes: [{ op: "getFlightTrip", answers: [problem(404, "not_found")] }],
    });
    const result = await s.run([
      "flights",
      "trip",
      "gone-trip",
      "--search",
      "gone-search",
    ]);
    expect(result.code).toBe(4);
    expect(result.out).toBe("");
    expect(result.err).not.toBe("");
  });

  it("a 400 exits 6 and prints the API's detail and trace id", async () => {
    const { result } = await placesAnswering(
      problem(400, "validation_failed", "query is too short"),
    );
    expect(result.code).toBe(6);
    expect(result.out).toBe("");
    expect(result.err).toContain("query is too short");
    expect(result.err).toContain("trace-400");
  });

  it("a 429 is retried after Retry-After, then succeeds", async () => {
    const { fake, result } = await placesAnswering(
      problem(429, "rate_limited", "slow down", { "retry-after": "1" }),
      answer("places"),
    );
    expect(result.code).toBe(0);
    expect(fake.requests("getPlaces")).toHaveLength(2);
  });

  it("a 503 that persists exits 5, retryable", async () => {
    const { fake, result } = await placesAnswering(
      problem(503, "upstream_unavailable", "try later", { "retry-after": "1" }),
    );
    expect(result.code).toBe(5);
    expect(result.out).toBe("");
    expect(fake.requests("getPlaces").length).toBeGreaterThanOrEqual(2);
  });

  it("a connection closed before any answer exits 7", async () => {
    signIn(s.home);
    const dropper = startDropper();
    try {
      const result = await s.run(["places", "London"], {
        env: { WEGO_API_URL: dropper.url },
      });
      expect(result.code).toBe(7);
      expect(result.out).toBe("");
    } finally {
      dropper.stop();
    }
  });

  for (const fault of ["non-json", "truncated"] as const) {
    it(`a ${fault} body exits non-zero and prints nothing on stdout`, async () => {
      const { result } = await placesAnswering({ fault });
      expect(result.code).not.toBe(0);
      expect(result.out).toBe("");
      expect(result.err).not.toBe("");
    });
  }

  it("reaches nothing outside this machine", async () => {
    // The suite's own guarantee, not the CLI's: a real host is refused before a
    // byte leaves, so no scenario can reach production by mistake.
    signIn(s.home);
    const result = await s.run(["places", "London"], {
      env: { WEGO_API_URL: "https://api.wego.com" },
    });
    expect(result.code).toBe(7);
    expect(result.out).toBe("");
  });

  it("an unreachable API exits 7", async () => {
    signIn(s.home);
    // No fake: the binary is pointed at a closed port.
    const result = await s.run(["places", "London"]);
    expect(result.code).toBe(7);
    expect(result.out).toBe("");
  });
});
