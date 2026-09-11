import { describe, expect, it } from "bun:test";
import {
  EDGE_SIGNING_IDENTITY,
  identitiesForRing,
  SIGNING_IDENTITY,
  SIGNING_OIDC_ISSUER,
} from "./identity";
import { verifySignedManifest } from "./signature";
import {
  bundle,
  INTEGRATED_TIME,
  OTHER_IDENTITY_CERT_DER,
  PAYLOAD,
  ROGUE_ROOT_CERT_DER,
  ROGUE_ROOT_PEM,
  SIGNATURE_OVER_OTHER_BYTES,
  TEST_ROOT_PEM,
} from "./testing/fixture";

// The mutations this suite kills (foundations#74 rung 9). Each is a way the
// verifier could look like it works while accepting a forged record:
//   - the SAN identity check dropped        -> "a different workflow" passes.
//   - the OIDC issuer check dropped         -> "an issuer we do not pin" passes.
//   - the chain walk dropped or made lenient-> "a root we do not pin" passes.
//   - the payload signature check dropped   -> "signed over other bytes" passes.
//   - the digest claim ignored              -> "a record for another manifest" passes.
//   - the logged-time requirement relaxed   -> "no transparency-log time" passes.
//   - a throw allowed to escape             -> the malformed-input cases error out
//                                              instead of refusing.

const payload = () => new TextEncoder().encode(PAYLOAD);

/** The accept path, with only the named part swapped. */
function input(
  overrides: Partial<Parameters<typeof verifySignedManifest>[0]> = {},
) {
  return {
    bundle: bundle(),
    payload: payload(),
    identity: [SIGNING_IDENTITY],
    issuer: SIGNING_OIDC_ISSUER,
    rootsPem: TEST_ROOT_PEM,
    // Fixed, so the suite is not a clock race: the fixture's logged time sits
    // inside its certificate's ten-minute window, and "now" is a day later.
    now: new Date((INTEGRATED_TIME + 86_400) * 1000),
    ...overrides,
  };
}

describe("a well-formed record from the pinned identity", () => {
  it("verifies, and reports the identity it accepted", async () => {
    const result = await verifySignedManifest(input());
    expect(result).toEqual({
      ok: true,
      identity: SIGNING_IDENTITY,
      issuer: SIGNING_OIDC_ISSUER,
    });
  });
});

describe("who signed it", () => {
  // The rung's core claim: store write access buys nothing, because the attacker
  // cannot obtain a certificate for OUR workflow identity.
  it("refuses a record signed for a different workflow in the same repo", async () => {
    const result = await verifySignedManifest(
      input({ bundle: bundle({ certDer: OTHER_IDENTITY_CERT_DER }) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("edge-cli.yml");
      expect(result.reason).toContain("refusing it");
    }
  });

  it("refuses a record whose identity we simply do not expect", async () => {
    const result = await verifySignedManifest(
      input({
        identity: [
          "https://github.com/wego/wego-ai/.github/workflows/other.yml@refs/heads/main",
        ],
      }),
    );
    expect(result.ok).toBe(false);
  });

  // Without pinning the issuer, the SAN is a string the signer chose for itself:
  // any OIDC provider Fulcio trusts could assert it.
  it("refuses a record from an issuer we do not pin", async () => {
    const result = await verifySignedManifest(
      input({ issuer: "https://accounts.google.com" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("OIDC issuer");
  });
});

describe("whether Fulcio issued it", () => {
  // The identity check alone is worthless if anyone may mint the certificate
  // asserting it.
  it("refuses a certificate that chains to a root we do not pin", async () => {
    const result = await verifySignedManifest(
      input({ bundle: bundle({ certDer: ROGUE_ROOT_CERT_DER }) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.reason).toContain("does not chain to a pinned");
  });

  it("refuses when the pinned root is a different CA than the one that signed", async () => {
    const result = await verifySignedManifest(
      input({ rootsPem: ROGUE_ROOT_PEM }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.reason).toContain("does not chain to a pinned");
  });

  it("refuses when there is no pinned root at all, rather than skipping the check", async () => {
    const result = await verifySignedManifest(input({ rootsPem: "" }));
    expect(result.ok).toBe(false);
  });
});

describe("what it covers", () => {
  it("refuses a signature made over different bytes", async () => {
    const result = await verifySignedManifest(
      input({ bundle: bundle({ signature: SIGNATURE_OVER_OTHER_BYTES }) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("does not verify");
  });

  // A record for one manifest replayed over another is the attack the digest claim
  // closes; the signature check closes it too, so both are asserted.
  it("refuses a record whose claimed digest is for another manifest", async () => {
    const result = await verifySignedManifest(
      input({
        bundle: bundle({
          digest: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("different manifest");
  });

  it("refuses when the manifest bytes have been altered under a valid record", async () => {
    const tampered = new TextEncoder().encode(`${PAYLOAD}extra\n`);
    const result = await verifySignedManifest(input({ payload: tampered }));
    expect(result.ok).toBe(false);
  });
});

describe("when it was signed", () => {
  // A Fulcio certificate lives about ten minutes, so it has long expired by install
  // time. The logged time is the only thing that can place the signature inside its
  // validity — with none, there is nothing to check against.
  it("refuses a record carrying no transparency-log time", async () => {
    const result = await verifySignedManifest(
      input({ bundle: bundle({ integratedTime: null }) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("no transparency-log time");
  });

  // Before the certificate existed. (The fixture's certificate is deliberately
  // long-lived so the suite is not a time bomb; Fulcio's real ones last minutes.)
  it("refuses a record logged outside its certificate's validity", async () => {
    const result = await verifySignedManifest(
      input({
        bundle: bundle({ integratedTime: INTEGRATED_TIME - 400 * 86_400 }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("outside its certificate");
  });

  it("refuses a record dated in the future", async () => {
    const result = await verifySignedManifest(
      input({ now: new Date((INTEGRATED_TIME - 30 * 86_400) * 1000) }),
    );
    expect(result.ok).toBe(false);
  });
});

describe("malformed input", () => {
  // Every one of these would throw if the parse were not wrapped; a throw on this
  // path would surface as a crash rather than a refusal, and a caller catching
  // broadly could mistake it for a transport error and retry.
  const cases: [string, unknown][] = [
    ["not an object", 42],
    ["null", null],
    ["an empty object", {}],
    [
      "no certificate",
      { verificationMaterial: {}, messageSignature: { signature: "AA==" } },
    ],
    [
      "a certificate that is not base64",
      {
        verificationMaterial: { certificate: { rawBytes: "not base64!!" } },
        messageSignature: { signature: "AA==" },
      },
    ],
    [
      "a certificate that is not DER",
      {
        verificationMaterial: { certificate: { rawBytes: "AAAAAA==" } },
        messageSignature: { signature: "AA==" },
      },
    ],
    [
      "no signature",
      {
        verificationMaterial: { certificate: { rawBytes: "AAAAAA==" } },
        messageSignature: {},
      },
    ],
  ];

  for (const [name, value] of cases) {
    it(`refuses ${name} without throwing`, async () => {
      const result = await verifySignedManifest(input({ bundle: value }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
    });
  }
});

/**
 * The RULE SET, on its own. `release-cli.yml` has two documented entries — a
 * `workflow_call` from release-please (which runs on main) and a `v*` tag push
 * (the recovery release) — so the release rings accept two identities. These cases
 * pin BOTH directions: the tag path is accepted, and everything adjacent to it is
 * not. Asserted through the exported rules rather than through a minted certificate,
 * because what is under test here is the matching, not the X.509 reading that the
 * cases above already cover end to end.
 */
describe("the identities a ring accepts", () => {
  const accepts = (ring: string, uri: string): boolean =>
    identitiesForRing(ring).some((rule) =>
      typeof rule === "string" ? uri === rule : rule.test(uri),
    );

  const tag = (ref: string) =>
    `https://github.com/wego/wego-ai/.github/workflows/release-cli.yml@refs/tags/${ref}`;

  it("accepts the release workflow on main, for next and stable", () => {
    expect(accepts("next", SIGNING_IDENTITY)).toBe(true);
    expect(accepts("stable", SIGNING_IDENTITY)).toBe(true);
  });

  it("accepts the release workflow on a vX.Y.Z tag — the recovery release", () => {
    expect(accepts("next", tag("v1.2.3"))).toBe(true);
    expect(accepts("next", tag("v10.0.11"))).toBe(true);
  });

  it("refuses a prerelease tag: the -rc.N line is gone", () => {
    expect(accepts("next", tag("v1.2.3-rc.1"))).toBe(false);
  });

  it("refuses a tag that is not a bare version", () => {
    expect(accepts("next", tag("v1.2"))).toBe(false);
    expect(accepts("next", tag("vnext"))).toBe(false);
    expect(accepts("next", tag("v1.2.3/../evil"))).toBe(false);
  });

  it("refuses the pattern as a SUBSTRING of a longer SAN", () => {
    // What the anchors buy: a SAN the signer chose that merely CONTAINS an
    // acceptable one must not pass.
    expect(accepts("next", `${tag("v1.2.3")}@refs/heads/attacker`)).toBe(false);
    expect(accepts("next", `https://evil.example/${tag("v1.2.3")}`)).toBe(
      false,
    );
  });

  it("refuses another workflow, another repo and another branch", () => {
    expect(accepts("next", EDGE_SIGNING_IDENTITY)).toBe(false);
    expect(
      accepts(
        "next",
        "https://github.com/wego/wego-ai/.github/workflows/release-cli.yml@refs/heads/side",
      ),
    ).toBe(false);
    expect(
      accepts(
        "next",
        "https://github.com/evil/wego-ai/.github/workflows/release-cli.yml@refs/tags/v1.2.3",
      ),
    ).toBe(false);
  });

  it("keeps the edge lane to its own single identity", () => {
    // The edge lane triggers only on main, so it gets no tag rule — a dogfood
    // record must never be able to pass as a release record.
    expect(accepts("edge", EDGE_SIGNING_IDENTITY)).toBe(true);
    expect(accepts("edge", SIGNING_IDENTITY)).toBe(false);
    expect(accepts("edge", tag("v1.2.3"))).toBe(false);
  });
});
