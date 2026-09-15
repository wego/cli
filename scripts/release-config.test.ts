import { describe, expect, it } from "bun:test";
import { readReleaseEnvSpec } from "./release-config";

// ONE bundle, not two (foundations#74 rung 7). The `wegostaging` flavor is gone:
// every release build bakes the PROD endpoints, and `--target staging` swaps
// the whole auth bundle at run time from `src/target.ts`. So there is no longer a
// build-time flavor label a bundle could contradict, and the two guards that
// enforced that label (flavor⟷host, and the channel path's flavor) went with it.
// What this file still pins is everything that is a property of the BUNDLE rather
// than of a flavor: required keys, HTTPS, no credentials, the Blob host pin on the
// baked bases, and the PostHog key shape.
const RELEASE_ENV: NodeJS.ProcessEnv = {
  WEGO_AUTH_AUTHORIZE_URL:
    "https://auth.wego.com/user-auth/v2/users/oauth/authorize",
  WEGO_AUTH_TOKEN_URL: "https://auth.wego.com/user-auth/v2/users/oauth/token",
  WEGO_API_URL: "https://api.wego.com",
  WEGO_CLI_CLIENT_ID: "production-public-client",
};

describe("readReleaseEnvSpec", () => {
  it("validates the complete public release bundle", () => {
    expect(readReleaseEnvSpec(RELEASE_ENV)).toMatchObject({
      authorizeUrl: "https://auth.wego.com/user-auth/v2/users/oauth/authorize",
      tokenUrl: "https://auth.wego.com/user-auth/v2/users/oauth/token",
      apiUrl: "https://api.wego.com",
      clientId: "production-public-client",
    });
  });

  it("rejects a malformed endpoint before the build starts", () => {
    expect(() =>
      readReleaseEnvSpec({ ...RELEASE_ENV, WEGO_API_URL: "not-a-url" }),
    ).toThrow(/WEGO_API_URL is not a valid URL/);
  });

  it("rejects plaintext loopback endpoints in published binaries", () => {
    expect(() =>
      readReleaseEnvSpec({
        ...RELEASE_ENV,
        WEGO_AUTH_TOKEN_URL: "http://localhost:4444/token",
      }),
    ).toThrow(/WEGO_AUTH_TOKEN_URL must use HTTPS/);
  });

  it("rejects credential-bearing URLs before they reach a public binary", () => {
    expect(() =>
      readReleaseEnvSpec({
        ...RELEASE_ENV,
        WEGO_API_URL: "https://user:password@api.wego.com",
      }),
    ).toThrow(/WEGO_API_URL must not contain URL credentials/);
  });

  it("rejects an incomplete bundle", () => {
    const source = { ...RELEASE_ENV };
    delete source.WEGO_CLI_CLIENT_ID;
    expect(() => readReleaseEnvSpec(source)).toThrow(
      /WEGO_CLI_CLIENT_ID is required/,
    );
  });

  // NO CHANNEL BASE IS BAKED, and that is the point rather than an omission.
  //
  // `wego update` reads the ring the installer recorded (foundations#74 rung 3), and
  // the new-version notice now reads the same record. A baked base made two sources
  // of truth for "which channel is this install on" and drifted exactly as that
  // invites: it still named `cli/latest` after rung 7 retired the prefix, so the
  // notice would have compared against something that never advances again while
  // `update` was correct.
  //
  // Asserted as ABSENCE, and against the env var being honoured at all - a spec that
  // silently grew the field back would otherwise ship a binary that looks at a
  // compiled-in URL again.
  it("bakes no channel base, even when the retired variable is set", () => {
    const spec = readReleaseEnvSpec({
      ...RELEASE_ENV,
      WEGO_CLI_DOWNLOAD_BASE_URL:
        "https://store123.public.blob.vercel-storage.com/cli/stable",
    });
    expect(Object.keys(spec)).not.toContain("downloadBaseUrl");
    // Nor under any other name: no value in the spec may be that URL.
    expect(Object.values(spec)).not.toContain(
      "https://store123.public.blob.vercel-storage.com/cli/stable",
    );
  });

  // The SKILL axis. The skill channel is gone from this repo - the body ships
  // embedded in the binary and `update` re-runs `skill install --owned-only` - so
  // no skill store address is baked under ANY name. A lingering
  // `WEGO_CLI_SKILL_URL` or `WEGO_CLI_SKILL_ORIGIN` in the Environment (the
  // likeliest thing to survive this change) must be inert rather than honoured.
  it("bakes no skill store address, even when a retired variable is set", () => {
    const spec = readReleaseEnvSpec({
      ...RELEASE_ENV,
      WEGO_CLI_SKILL_URL:
        "https://store123.public.blob.vercel-storage.com/skill/latest",
      WEGO_CLI_SKILL_ORIGIN: "https://store123.public.blob.vercel-storage.com",
    });
    expect(Object.keys(spec)).not.toContain("skillOrigin");
    expect(Object.values(spec)).not.toContain(
      "https://store123.public.blob.vercel-storage.com/skill/latest",
    );
    expect(Object.values(spec)).not.toContain(
      "https://store123.public.blob.vercel-storage.com",
    );
  });

  it("bakes an optional PostHog write key for telemetry when present", () => {
    const key = "phc_ABCdef0123456789ABCdef0123456789ABC";
    expect(
      readReleaseEnvSpec({
        ...RELEASE_ENV,
        WEGO_CLI_POSTHOG_PROJECT_KEY: key,
      }).posthogKey,
    ).toBe(key);
    // Absent → the built binary emits nothing; a pre-go-live release still builds.
    expect(readReleaseEnvSpec(RELEASE_ENV).posthogKey).toBe(undefined);
  });

  it("rejects a read-capable PostHog key before it is compiled into a public binary", () => {
    // `phc_` is write-only; a personal `phx_` can read the project's data.
    expect(() =>
      readReleaseEnvSpec({
        ...RELEASE_ENV,
        WEGO_CLI_POSTHOG_PROJECT_KEY: "phx_ABCdef0123456789ABCdef0123456789ABC",
      }),
    ).toThrow(/must be a PostHog write-only project key/);
  });

  it("rejects a malformed or truncated PostHog key", () => {
    for (const bad of [
      "phc_short",
      "not-a-key",
      "PHC_ABCdef0123456789ABCdef01",
    ]) {
      expect(() =>
        readReleaseEnvSpec({
          ...RELEASE_ENV,
          WEGO_CLI_POSTHOG_PROJECT_KEY: bad,
        }),
      ).toThrow(/must be a PostHog write-only project key/);
    }
  });

  describe("production-host pin (the baked auth/api endpoints)", () => {
    // The published binary DEFAULTS to the prod target, and prod imposes no
    // overrides - it uses these baked values verbatim. So a staging value here
    // ships an install that talks to staging forever, and with one build there is
    // no second flavor whose absence would make that visible.
    for (const key of [
      "WEGO_AUTH_AUTHORIZE_URL",
      "WEGO_AUTH_TOKEN_URL",
      "WEGO_API_URL",
    ]) {
      it(`rejects a staging host baked as ${key}`, () => {
        expect(() =>
          readReleaseEnvSpec({
            ...RELEASE_ENV,
            [key]: "https://api.wegostaging.com/x",
          }),
        ).toThrow(/must be a production Wego host/);
      });
    }

    it("rejects a lookalike host that merely CONTAINS wego.com", () => {
      // The suffix match is on the registrable domain with its leading dot, so
      // `wego.com.evil.test` and `notwego.com` are both outside it. A `includes()`
      // spelling would accept the first, which is the whole point of pinning.
      for (const host of [
        "https://api.wego.com.evil.test",
        "https://notwego.com",
      ]) {
        expect(() =>
          readReleaseEnvSpec({ ...RELEASE_ENV, WEGO_API_URL: host }),
        ).toThrow(/must be a production Wego host/);
      }
    });

    it("accepts the apex and any production subdomain", () => {
      // auth and api are different hosts, and a new subdomain is a routine change,
      // so the pin is the domain family rather than an exact-host allowlist.
      for (const host of [
        "https://wego.com",
        "https://api.wego.com",
        "https://auth.wego.com",
      ]) {
        expect(() =>
          readReleaseEnvSpec({ ...RELEASE_ENV, WEGO_API_URL: host }),
        ).not.toThrow();
      }
    });
  });

  it("does not accept environment-prefixed aliases", () => {
    expect(() =>
      readReleaseEnvSpec({
        PRODUCTION_WEGO_AUTH_AUTHORIZE_URL: RELEASE_ENV.WEGO_AUTH_AUTHORIZE_URL,
        PRODUCTION_WEGO_AUTH_TOKEN_URL: RELEASE_ENV.WEGO_AUTH_TOKEN_URL,
        PRODUCTION_WEGO_API_URL: RELEASE_ENV.WEGO_API_URL,
        PRODUCTION_WEGO_CLI_CLIENT_ID: RELEASE_ENV.WEGO_CLI_CLIENT_ID,
      }),
    ).toThrow(/WEGO_AUTH_AUTHORIZE_URL is required/);
  });
});
