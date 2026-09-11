import { describe, expect, it } from "bun:test";
import { bundle } from "../src/release-signing/testing/fixture";
import {
  EDGE_REF,
  EDGE_WORKFLOW,
  EXPECTED_REPO,
  identityRulesFrom,
  parseSan,
  RELEASE_WORKFLOW,
  renderRules,
  sanFromBundle,
} from "./extract-identities";

/** The two SANs the rehearsal lanes really sign, harvested from the records in the
 *  rehearsal store. Written here as literals ON PURPOSE and only here: these are
 *  the expectations the script is checked against, not the values it emits. */
const EDGE_SAN =
  "https://github.com/wego/cli/.github/workflows/edge-cli.yml@refs/heads/main";
const TAG_SAN =
  "https://github.com/wego/cli/.github/workflows/release-cli.yml@refs/tags/v1.0.2";

describe("parseSan", () => {
  it("splits a workflow identity into the parts that carry authority", () => {
    expect(parseSan(TAG_SAN)).toEqual({
      owner: "wego",
      repo: "cli",
      workflow: RELEASE_WORKFLOW,
      ref: "refs/tags/v1.0.2",
    });
  });

  it("takes the whole remainder as the ref, so an `@` in it cannot eat the workflow name", () => {
    expect(
      parseSan(
        "https://github.com/wego/cli/.github/workflows/edge-cli.yml@refs/heads/x@y",
      ),
    ).toMatchObject({ workflow: EDGE_WORKFLOW, ref: "refs/heads/x@y" });
  });

  it("refuses a string that merely contains an identity", () => {
    expect(() => parseSan(`https://evil.example/${TAG_SAN}`)).toThrow(
      /not a GitHub Actions workflow identity/,
    );
  });

  it("refuses a non-identity string", () => {
    expect(() => parseSan("nonsense")).toThrow(
      /not a GitHub Actions workflow identity/,
    );
  });
});

describe("identityRulesFrom", () => {
  it("emits the edge SAN verbatim and generalises only the tag's version", () => {
    const rules = identityRulesFrom(TAG_SAN, EDGE_SAN);
    expect(rules.edge).toBe(EDGE_SAN);
    expect(rules.tagSan).toBe(TAG_SAN);
    expect(rules.tagPattern).toBe(
      "^https:\\/\\/github\\.com\\/wego\\/cli\\/\\.github\\/workflows\\/release-cli\\.yml@refs\\/tags\\/v\\d+\\.\\d+\\.\\d+$",
    );
  });

  it("the emitted pattern matches the record it came from, and later versions", () => {
    const re = new RegExp(identityRulesFrom(TAG_SAN, EDGE_SAN).tagPattern);
    expect(re.test(TAG_SAN)).toBe(true);
    expect(re.test(TAG_SAN.replace("v1.0.2", "v1.0.4"))).toBe(true);
    expect(re.test(TAG_SAN.replace("v1.0.2", "v10.20.30"))).toBe(true);
  });

  it("the emitted pattern refuses another repo, another workflow and a branch ref", () => {
    const re = new RegExp(identityRulesFrom(TAG_SAN, EDGE_SAN).tagPattern);
    expect(re.test(TAG_SAN.replace("wego/cli", "wego/wego-ai"))).toBe(false);
    expect(re.test(TAG_SAN.replace(RELEASE_WORKFLOW, EDGE_WORKFLOW))).toBe(
      false,
    );
    expect(
      re.test(TAG_SAN.replace("refs/tags/v1.0.2", "refs/heads/main")),
    ).toBe(false);
  });

  it("is anchored, so a SAN that merely contains a good one is refused", () => {
    const re = new RegExp(identityRulesFrom(TAG_SAN, EDGE_SAN).tagPattern);
    expect(re.test(`${TAG_SAN}.evil.example`)).toBe(false);
    expect(re.test(`https://evil.example/${TAG_SAN}`)).toBe(false);
  });

  it("refuses a record from another repository", () => {
    const foreign = TAG_SAN.replace("wego/cli", "attacker/cli");
    expect(() => identityRulesFrom(foreign, EDGE_SAN)).toThrow(
      new RegExp(`names repository attacker/cli, expected ${EXPECTED_REPO}`),
    );
  });

  it("refuses a release record signed by the edge workflow, and vice versa", () => {
    expect(() =>
      identityRulesFrom(
        TAG_SAN.replace(RELEASE_WORKFLOW, EDGE_WORKFLOW),
        EDGE_SAN,
      ),
    ).toThrow(/names workflow edge-cli\.yml, expected release-cli\.yml/);
    expect(() =>
      identityRulesFrom(
        TAG_SAN,
        EDGE_SAN.replace(EDGE_WORKFLOW, RELEASE_WORKFLOW),
      ),
    ).toThrow(/names workflow release-cli\.yml, expected edge-cli\.yml/);
  });

  it("refuses an edge record from a branch other than main", () => {
    expect(() =>
      identityRulesFrom(TAG_SAN, EDGE_SAN.replace(EDGE_REF, "refs/heads/side")),
    ).toThrow(/names ref refs\/heads\/side, expected refs\/heads\/main/);
  });

  it("refuses a prerelease tag — the -rc.N line is gone", () => {
    expect(() =>
      identityRulesFrom(TAG_SAN.replace("v1.0.2", "v1.0.2-rc.1"), EDGE_SAN),
    ).toThrow(/expected refs\/tags\/vX\.Y\.Z/);
  });

  it("refuses a tag record pinned to a branch", () => {
    expect(() =>
      identityRulesFrom(
        TAG_SAN.replace("refs/tags/v1.0.2", "refs/heads/main"),
        EDGE_SAN,
      ),
    ).toThrow(/expected refs\/tags\/vX\.Y\.Z/);
  });
});

describe("renderRules", () => {
  it("emits a RegExp literal and a string literal that re-parse to the rules", () => {
    const out = renderRules(identityRulesFrom(TAG_SAN, EDGE_SAN));
    expect(out).toContain("export const CLI_RELEASE_TAG_IDENTITY =");
    expect(out).toContain("export const CLI_EDGE_SIGNING_IDENTITY =");
    expect(out).toContain(JSON.stringify(EDGE_SAN));
    // The emitted pattern is a usable RegExp body, not an escaped-once-too-many one.
    const body = out.match(/\/(\^https.*\$)\/;/)?.[1];
    expect(body).toBeDefined();
    expect(new RegExp(body as string).test(TAG_SAN)).toBe(true);
  });
});

describe("sanFromBundle", () => {
  it("reads the SAN out of a v0.3 bundle's single certificate", () => {
    expect(sanFromBundle(bundle())).toMatch(
      /^https:\/\/github\.com\/.+\/\.github\/workflows\/.+@.+$/,
    );
  });

  it("reads the leaf out of a pre-v0.3 x509CertificateChain", () => {
    const v03 = bundle() as {
      verificationMaterial: { certificate: { rawBytes: string } };
    };
    const chained = {
      verificationMaterial: {
        x509CertificateChain: {
          certificates: [
            { rawBytes: v03.verificationMaterial.certificate.rawBytes },
          ],
        },
      },
    };
    expect(sanFromBundle(chained)).toBe(sanFromBundle(v03));
  });

  it("refuses a bundle with no verification material", () => {
    expect(() => sanFromBundle({})).toThrow(/no verificationMaterial/);
  });

  it("refuses a bundle carrying no leaf certificate", () => {
    expect(() => sanFromBundle({ verificationMaterial: {} })).toThrow(
      /no leaf certificate/,
    );
  });
});
