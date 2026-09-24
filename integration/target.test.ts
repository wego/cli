/**
 * `wego info target`: a retargeted run says so, on stderr for a person and as one
 * JSON object on stdout for an agent. It reads nothing and calls nothing.
 */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { useScenario } from "./harness/scenario";
import { json } from "./harness/wego";

const s = useScenario();

const STAGING_AUTH_HOST = "auth.wegostaging.com";
const STAGING_API_URL = "https://api.wegostaging.com";

describe("info target", () => {
  it("names the target, its origin and the endpoints on stderr", async () => {
    const fake = s.fake();
    const result = await s.run(["--target", "staging", "info", "target"]);

    expect(result.code).toBe(0);
    expect(result.err).toContain("staging");
    expect(result.err).toContain("--target");
    expect(result.err).toContain(STAGING_API_URL);
    expect(result.err).toContain(STAGING_AUTH_HOST);
    expect(result.err).toContain("suppressed");
    expect(json<{ target: string }>(result).target).toBe("staging");
    expect(fake.seen).toEqual([]);
  });

  it("prints the same stdout with --json, and nothing on stderr", async () => {
    const plain = await s.run(["--target", "staging", "info", "target"]);
    const quiet = await s.run([
      "--target",
      "staging",
      "info",
      "target",
      "--json",
    ]);

    expect(quiet.code).toBe(0);
    expect(quiet.out).toBe(plain.out);
    expect(quiet.err).toBe("");
  });

  it("reports a target set by WEGO_TARGET, with a store keyed by its auth host", async () => {
    const result = await s.run(["info", "target", "--json"], {
      env: { WEGO_TARGET: "staging" },
    });

    expect(result.code).toBe(0);
    expect(json(result)).toEqual({
      target: "staging",
      source: "env",
      apiUrl: STAGING_API_URL,
      authorizeUrl: `https://${STAGING_AUTH_HOST}/user-auth/v2/users/oauth/authorize`,
      tokenUrl: `https://${STAGING_AUTH_HOST}/user-auth/v2/users/oauth/token`,
      credentialsPath: join(
        s.home.configDir,
        STAGING_AUTH_HOST,
        "credentials.json",
      ),
      telemetrySuppressed: true,
    });
  });

  it("prints its usage on --help and rejects an unknown argument", async () => {
    const help = await s.run(["info", "target", "--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("info target");

    const bad = await s.run(["info", "target", "--jsn"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("--jsn");
  });

  it("refuses a mistyped target instead of falling back to prod", async () => {
    const result = await s.run(["--target", "stagng", "info", "target"]);
    expect(result.code).toBe(2);
    expect(result.out).toBe("");
    expect(result.err).toContain("stagng");
  });
});
