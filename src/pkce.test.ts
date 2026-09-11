import { describe, expect, it } from "bun:test";
import { codeChallengeS256, generateCodeVerifier, generateState } from "./pkce";

describe("pkce", () => {
  it("generates a url-safe verifier within RFC 7636 length bounds", () => {
    const v = generateCodeVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v.length).toBeLessThanOrEqual(128);
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding
  });

  it("generates distinct verifiers", () => {
    expect(generateCodeVerifier()).not.toBe(generateCodeVerifier());
  });

  it("computes the RFC 7636 S256 challenge for the spec's example vector", async () => {
    // RFC 7636 Appendix B.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = await codeChallengeS256(verifier);
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("generates a non-empty url-safe state", () => {
    expect(generateState()).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
