/**
 * `wego feedback`: the body it posts, the usage errors it refuses locally, and the
 * session it runs on. The flag rules themselves are `parseFeedbackArgs`'s unit
 * tests in `src/commands.test.ts`.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { route } from "./harness/fixtures";
import { useScenario } from "./harness/scenario";
import { signIn } from "./harness/wego";

const s = useScenario();

describe("feedback", () => {
  it("posts the submission stamped with the CLI version and confirms it", async () => {
    signIn(s.home);
    const fake = s.fake({ routes: [route("feedback-received")] });
    const result = await s.run([
      "feedback",
      "--rating",
      "5",
      "--category",
      "flights",
      "--message",
      "nice",
    ]);

    expect(result.code).toBe(0);
    expect(result.out).toContain("Thanks");
    const [sent] = fake.requests("submitFeedback");
    expect(sent?.token).toBe("access-1");
    // Stamped with the version the binary reports: 0.0.0-dev unbaked, the
    // release's own on a release build.
    const version = (await s.run(["version"])).out.trim();
    expect(sent?.body).toEqual({
      rating: 5,
      category: "flights",
      message: "nice",
      version,
    });
  });

  it("prints its usage on --help with exit 0", async () => {
    const result = await s.run(["feedback", "--help"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("feedback");
    expect(result.err).toBe("");
  });

  it("refuses a malformed submission with exit 2 and no request", async () => {
    signIn(s.home);
    const fake = s.fake();
    const result = await s.run(["feedback", "--rating", "9"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("--rating");
    expect(fake.seen).toEqual([]);
  });

  it("recovers from a 401 by refreshing once, keeping the refresh token", async () => {
    signIn(s.home, {
      accessToken: "access-revoked",
      refreshToken: "refresh-1",
    });
    const fake = s.fake({
      accept: [],
      routes: [route("feedback-received")],
      // No refresh_token in the answer: the stored one must survive.
      refresh: [{ access_token: "access-2" }],
    });
    const result = await s.run(["feedback", "--rating", "5"]);

    expect(result.code).toBe(0);
    const sent = fake.requests("submitFeedback");
    expect(sent.map((r) => r.token)).toEqual(["access-revoked", "access-2"]);
    expect(sent[1]?.body).toMatchObject({ rating: 5 });
    expect(
      JSON.parse(readFileSync(s.home.credentialsPath, "utf8")),
    ).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-1" });
  });

  it("exits 3 on a persistent 401 with no refresh token", async () => {
    signIn(s.home, { accessToken: "access-revoked" });
    s.fake({ accept: [] });
    const result = await s.run(["feedback", "--rating", "5"]);
    expect(result.code).toBe(3);
    expect(result.err).not.toBe("");
  });

  it("exits 3 and names login when logged out", async () => {
    const fake = s.fake();
    const result = await s.run(["feedback", "--rating", "5"]);
    expect(result.code).toBe(3);
    expect(result.err).toMatch(/login/);
    expect(fake.seen).toEqual([]);
  });

  it("exits 7 when the API cannot be reached", async () => {
    signIn(s.home);
    // No fake: the binary is pointed at a closed port.
    const result = await s.run(["feedback", "--rating", "5"]);
    expect(result.code).toBe(7);
    expect(result.err).toMatch(/reach/i);
  });
});
