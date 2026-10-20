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
  it("reports a hotel-search edge challenge without asking a signed-in caller to log in", async () => {
    signIn(s.home);
    const requests: { method: string; path: string; token: string | null }[] =
      [];
    const edge = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        requests.push({
          method: req.method,
          path: new URL(req.url).pathname,
          token: req.headers.get("authorization"),
        });
        return new Response("<html><title>Just a moment...</title></html>", {
          status: 403,
          headers: {
            "content-type": "text/html",
            "cf-mitigated": "challenge",
            "cf-ray": "a4d0830ba9d11e2d-SIN",
          },
        });
      },
    });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await s.run(
          [
            "hotels",
            "search",
            "AUH",
            "2027-01-17",
            "2027-01-22",
            "--adults",
            "2",
            "--children",
            "1",
            "--children-ages",
            "10",
            "--rooms",
            "1",
          ],
          { env: { WEGO_API_URL: String(edge.url) } },
        );
        expect(result.code).toBe(6);
        expect(result.out).toBe("");
        expect(result.err).toContain("Cloudflare challenged");
        expect(result.err).toContain("cf_ray=a4d0830ba9d11e2d-SIN");
        expect(result.err).toContain("feedback");
        expect(result.err).not.toContain("wego login");
        expect(result.err).not.toContain("trace_id=");
        expect(result.err).not.toContain("<html>");
      }
      expect(requests).toEqual(
        Array.from({ length: 2 }, () => ({
          method: "POST",
          path: "/v1/hotels/searches",
          token: "Bearer access-1",
        })),
      );
    } finally {
      edge.stop(true);
    }
  });

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
      problem(400, "validation_failed", "query is too short", {
        "cf-ray": "api-ray-SIN",
      }),
    );
    expect(result.code).toBe(6);
    expect(result.out).toBe("");
    expect(result.err).toContain("query is too short");
    expect(result.err).toContain("trace-400");
    expect(result.err).toContain("cf_ray=api-ray-SIN");
    expect(result.err).not.toContain("Cloudflare challenged");
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

  it("a non-json body exits non-zero and prints nothing on stdout", async () => {
    const { result } = await placesAnswering({ fault: "non-json" });
    expect(result.code).not.toBe(0);
    expect(result.out).toBe("");
    expect(result.err).not.toBe("");
  });

  it("a body cut off mid-read exits non-zero and prints nothing on stdout", async () => {
    signIn(s.home);
    const dropper = startDropper({ partial: true });
    try {
      const result = await s.run(["places", "London"], {
        env: { WEGO_API_URL: dropper.url },
      });
      expect(result.code).not.toBe(0);
      expect(result.out).toBe("");
      expect(result.err).not.toBe("");
    } finally {
      dropper.stop();
    }
  });

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
