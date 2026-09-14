import { describe, expect, it } from "bun:test";
import {
  CLI_EDGE_SIGNING_IDENTITY,
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
 * THE FAILURE CLASS, which is what a consumer branches on.
 *
 * `reason` is prose for a human; `kind` is the contract. `update.ts` maps it to
 * an exit code and to whether reinstalling is worth suggesting, so a refusal
 * filed under the wrong class is a wrong instruction to a machine - the shape
 * that let a mid-promote window report itself as permanent and tell a wrapper to
 * stop retrying something that clears in seconds.
 *
 * The mid-promote window is the reason `inconsistent` exists: the publisher
 * copies the signed record and the manifest as two adjacent writes, so a reader
 * landing between them sees one new and one old, and a cache can straddle the
 * pair for its whole TTL.
 */
describe("the class a refusal is filed under", () => {
  const refusalFor = async (
    over: Partial<Parameters<typeof verifySignedManifest>[0]>,
  ) => {
    const r = await verifySignedManifest(input(over));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected a refusal");
    return r;
  };

  it("files a record over OTHER bytes as inconsistent - the promote window", async () => {
    const r = await refusalFor({
      payload: new TextEncoder().encode("a different manifest\n"),
    });
    expect(r.kind).toBe("inconsistent");
  });

  it("files an unreadable record as inconsistent, not invalid", async () => {
    // A bundle we cannot parse is more often a truncated or straddled read than
    // a forged record, and the two are indistinguishable here. The install is
    // refused either way, so the asymmetry favours the self-resolving class: a
    // wasted retry costs nothing, a wrapper that gives up costs recovery.
    const r = await refusalFor({
      bundle: {
        verificationMaterial: { certificate: { rawBytes: "not base64!!" } },
        messageSignature: { signature: "AA==" },
      },
    });
    expect(r.kind).toBe("inconsistent");
  });

  it("files a wrong signing identity as identity - the only reinstallable class", async () => {
    const r = await refusalFor({
      bundle: bundle({ certDer: OTHER_IDENTITY_CERT_DER }),
    });
    expect(r.kind).toBe("identity");
  });

  it("files a record that reaches no pinned root as invalid", async () => {
    const r = await refusalFor({ rootsPem: ROGUE_ROOT_PEM });
    expect(r.kind).toBe("invalid");
  });
});

/**
 * The RULE SET, on its own. `release-cli.yml` has two documented entries — a
 * `workflow_call` from release-please (which runs on main) and a tag push (the
 * recovery release) — so the release rings accept two identities per repository
 * that has both. Asserted through the exported rules rather than through a minted
 * certificate, because what is under test here is the matching, not the X.509
 * reading that the cases above already cover end to end.
 *
 * THE TWO REPOSITORIES CUT DIFFERENT TAG SHAPES, and these cases exist mostly to
 * pin that (wego/cli#29). wego-ai's release-please sets `include-component-in-tag:
 * true` with `component: "cli"`, so it only ever cut `cli-vX.Y.Z`; this repository
 * sets it false and cuts a bare `vX.Y.Z`. The shipped v1.2.0 rule had wego-ai's
 * repo path with THIS repository's tag shape, which matches no record that has
 * ever existed — and the suite here agreed with it, because it asserted the
 * invented `v1.2.3` rather than a release anyone published. So each direction is
 * now pinned against a REAL tag, and the other repository's shape is asserted to
 * be refused on the same path.
 */
describe("the identities a ring accepts", () => {
  const accepts = (ring: string, uri: string): boolean =>
    identitiesForRing(ring).some((rule) =>
      typeof rule === "string" ? uri === rule : rule.test(uri),
    );

  /** A SAN for wego-ai's release workflow on `ref`. */
  const tag = (ref: string) =>
    `https://github.com/wego/wego-ai/.github/workflows/release-cli.yml@refs/tags/${ref}`;

  /** The same, for this repository's release workflow. */
  const cliTag = (ref: string) =>
    `https://github.com/wego/cli/.github/workflows/release-cli.yml@refs/tags/${ref}`;

  it("accepts the release workflow on main, for next and stable", () => {
    expect(accepts("next", SIGNING_IDENTITY)).toBe(true);
    expect(accepts("stable", SIGNING_IDENTITY)).toBe(true);
  });

  it("accepts wego-ai's LAST REAL RELEASE, cli-v1.1.0", () => {
    // Not a hypothetical. This is the record `cli/stable` served through the
    // rollback of 2026-09-14, and the one a rollback to the pre-cutover release
    // puts back. A binary that refuses it cannot update off that ring at all:
    // exit 6, EXIT.PERMANENT, with no way forward. That is what v1.2.0 did.
    expect(accepts("stable", tag("cli-v1.1.0"))).toBe(true);
    expect(accepts("next", tag("cli-v1.1.0"))).toBe(true);
  });

  it("accepts wego-ai's tag shape generally - the recovery release", () => {
    expect(accepts("next", tag("cli-v1.0.1"))).toBe(true);
    expect(accepts("next", tag("cli-v10.0.11"))).toBe(true);
  });

  it("accepts THIS repository's tag shape, which carries no component", () => {
    expect(accepts("next", cliTag("v1.2.1"))).toBe(true);
    expect(accepts("stable", cliTag("v1.2.1"))).toBe(true);
    expect(accepts("next", cliTag("v10.0.11"))).toBe(true);
  });

  it("does not accept either repository under the OTHER's tag shape", () => {
    // The whole of wego/cli#29 in two lines. wego-ai never cut a bare `vX.Y.Z`
    // and this repository never cut a `cli-vX.Y.Z`, so a rule that accepted the
    // swapped shape would be trusting a ref neither repo can produce - and,
    // as shipped, refusing the one it does.
    expect(accepts("next", tag("v1.1.0"))).toBe(false);
    expect(accepts("next", cliTag("cli-v1.2.1"))).toBe(false);
  });

  it("refuses a prerelease tag: the -rc.N line is gone", () => {
    expect(accepts("next", tag("cli-v1.2.3-rc.1"))).toBe(false);
    expect(accepts("next", cliTag("v1.2.3-rc.1"))).toBe(false);
  });

  it("refuses a tag that is not a bare version", () => {
    expect(accepts("next", tag("cli-v1.2"))).toBe(false);
    expect(accepts("next", tag("cli-vnext"))).toBe(false);
    expect(accepts("next", tag("cli-v1.2.3/../evil"))).toBe(false);
    expect(accepts("next", cliTag("v1.2"))).toBe(false);
  });

  it("refuses the pattern as a SUBSTRING of a longer SAN", () => {
    // What the anchors buy: a SAN the signer chose that merely CONTAINS an
    // acceptable one must not pass.
    expect(accepts("next", `${tag("cli-v1.2.3")}@refs/heads/attacker`)).toBe(
      false,
    );
    expect(accepts("next", `https://evil.example/${tag("cli-v1.2.3")}`)).toBe(
      false,
    );
    expect(accepts("next", `${cliTag("v1.2.3")}@refs/heads/attacker`)).toBe(
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
        "https://github.com/evil/wego-ai/.github/workflows/release-cli.yml@refs/tags/cli-v1.2.3",
      ),
    ).toBe(false);
    expect(
      accepts(
        "next",
        "https://github.com/evil/cli/.github/workflows/release-cli.yml@refs/tags/v1.2.3",
      ),
    ).toBe(false);
  });

  it("keeps the edge lane to its own identities", () => {
    // The edge lanes trigger only on main, so they get no tag rule — a dogfood
    // record must never be able to pass as a release record.
    expect(accepts("edge", EDGE_SIGNING_IDENTITY)).toBe(true);
    expect(accepts("edge", CLI_EDGE_SIGNING_IDENTITY)).toBe(true);
    expect(accepts("edge", SIGNING_IDENTITY)).toBe(false);
    expect(accepts("edge", tag("cli-v1.2.3"))).toBe(false);
    expect(accepts("edge", cliTag("v1.2.3"))).toBe(false);
  });
});
