/**
 * Conformance for `plugin/plugin.json`, the manifest the publisher ships to
 * `wego/skills` verbatim (foundations#101 rung 3).
 *
 * The permitted field set is checked BY HAND against the ten fields the Agent
 * Plugins spec §5.2 lists normatively, not against a fetched or vendored schema:
 * the spec is normative prose, so a copy of the schema would be a second source
 * of truth that rots on its own, and a fetch would make this test need a network.
 * The cost of that choice is the `1.0.0` URL appearing in three places - the
 * manifest, this test, and the rung's probe - which is the whole price of a
 * future version bump, paid once and visibly.
 *
 * Nothing we ship reads this file today. No client we ship to consumes a root
 * `plugin.json`, so this test is a proxy for a consumer that does not exist yet -
 * which is exactly why it is here: a manifest nobody validates is a manifest that
 * is wrong the first time anybody does.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const cliRoot = join(import.meta.dir, "..");
const manifestPath = join(cliRoot, "plugin/plugin.json");
const readmePath = join(cliRoot, "plugin/README.md");
const licensePath = join(cliRoot, "plugin/LICENSE");

/** The ten fields Agent Plugins §5.2 permits. The set is CLOSED: anything else
 *  is a field no consumer is required to understand. */
const PERMITTED = [
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
] as const;

const raw = readFileSync(manifestPath, "utf8");
const manifest = JSON.parse(raw) as Record<string, unknown>;

describe("plugin.json conformance (Agent Plugins §5.2)", () => {
  it("declares the 1.0.0 schema", () => {
    expect(manifest.$schema).toBe(
      "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    );
  });

  it("carries no field outside the permitted set", () => {
    const extra = Object.keys(manifest).filter(
      (k) => !(PERMITTED as readonly string[]).includes(k),
    );
    expect(extra).toEqual([]);
  });

  it("omits `version`", () => {
    // A hand-written version in a published artifact is the wego/wego-ai#1751
    // shape: a value that drifts from what actually shipped, and that nothing
    // downstream can detect because the file reads as authoritative. The plugin
    // moves with a promote, so the ring pointer is the version.
    expect(Object.hasOwn(manifest, "version")).toBe(false);
  });

  it("names the plugin `wego`, matching the skill id", () => {
    expect(manifest.name).toBe("wego");
  });

  it("points at the docs site and the published repo", () => {
    expect(manifest.homepage).toBe("https://docs.wego.com");
    expect(manifest.repository).toBe("https://github.com/wego/skills");
  });

  it("describes the plugin in one sentence", () => {
    expect(typeof manifest.description).toBe("string");
    expect(manifest.description as string).toMatch(
      /^Search and compare flights and hotels/,
    );
  });

  it("declares Apache-2.0 as an SPDX identifier", () => {
    // §5.2 types `license` as a string and does not constrain it, so the
    // constraint is ours: an SPDX id is the only spelling a consumer can match
    // without reading prose, and "Apache 2.0" or "Apache License, Version 2.0"
    // are both wrong for that purpose while looking right to a human.
    expect(manifest.license).toBe("Apache-2.0");
  });
});

/**
 * SHA-256 of the canonical Apache 2.0 text, over LF line endings.
 *
 * Re-derive it with:
 *   curl -fsSL https://www.apache.org/licenses/LICENSE-2.0.txt | shasum -a 256
 *
 * This is the whole integrity check. Landmarks and a length floor were the
 * previous test and they are not sufficient: every structural landmark of the
 * licence sits OUTSIDE the clauses that grant anything, so a file with an edited
 * patent or trademark clause carries all of them, clears any length floor, and
 * publishes as "Apache 2.0". A licence is the one file where "looks right" and
 * "is right" have to be the same question.
 */
const CANONICAL_APACHE_2_SHA256 =
  "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30";

/** SHA-256 of `text` with CRLF folded to LF, hex. */
function licenseDigest(text: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(text.replaceAll("\r\n", "\n"));
  return h.digest("hex");
}

describe("LICENSE is the Apache 2.0 text, verbatim", () => {
  // The file is published to `wego/skills` byte for byte, and it is the whole
  // grant: a paraphrase, a truncation, or any diff against apache.org's text
  // would be a different licence wearing the name.
  const license = readFileSync(licensePath, "utf8");

  it("matches the canonical text by digest", () => {
    expect(licenseDigest(license)).toBe(CANONICAL_APACHE_2_SHA256);
  });

  // THIS CASE WAS ONCE DELETED as "asserting that SHA-256 is injective". That
  // reading was wrong, and the correction is the reason to keep it: the subject
  // is not the hash, it is THIS FILE'S comparison. A `licenseDigest` that
  // returned the pinned constant, a `readFileSync` that read the wrong path, a
  // normalisation that flattened everything - each one makes the assertion above
  // pass on any bytes at all, and nothing else here would notice.
  //
  // It is the same vacuity guard this repository already keeps in two other
  // places: `pinDrift` refusing to read an empty bundle as agreement, and
  // `workflow-lanes` refusing to compare PROMOTERS against a CODEOWNERS it
  // parsed nothing out of. A claim needs an input that could have failed.
  it("rejects an altered licence", () => {
    // ONE word, inside the patent grant. The result keeps every landmark the
    // test below checks and stays the same length, so it is exactly the file
    // that test would have waved through.
    const tampered = license.replace(
      "royalty-free, irrevocable",
      "royalty-free, revocable",
    );
    expect(tampered).not.toBe(license);
    expect(licenseDigest(tampered)).not.toBe(CANONICAL_APACHE_2_SHA256);
  });

  it("carries the title, the version line and the appendix", () => {
    // Kept for DIAGNOSIS, not for integrity. When the digest fails these say
    // which part drifted, which a bare hash mismatch never does.
    expect(license).toContain("Apache License");
    expect(license).toContain("Version 2.0, January 2004");
    expect(license).toContain("http://www.apache.org/licenses/");
    expect(license).toContain(
      "APPENDIX: How to apply the Apache License to your work",
    );
    expect(license).toContain("END OF TERMS AND CONDITIONS");
  });
});

describe("the published files are en-dash only", () => {
  // These two are the most public things this ladder ships, and the repo rule is
  // that user-facing writing takes an en-dash. An em-dash here would be read by
  // every third party who finds the plugin, and by nobody who could fix it.
  //
  // `LICENSE` is deliberately NOT in this list. It is a verbatim third-party
  // text we do not get to edit, so a rule we could only satisfy by rewriting it
  // is the wrong rule - the house style governs writing we author.
  it.each([
    ["plugin.json", raw],
    ["README.md", readFileSync(readmePath, "utf8")],
  ])("%s carries no em-dash", (_name, body) => {
    expect(body).not.toContain("—");
  });
});

// Two tests here asserted a "This repository is generated" section: that the
// README told a reader hand edits are overwritten, and that it carried a table
// mapping each published path back to its source. #1828 removed that section
// deliberately - it is build plumbing in a README whose job is to introduce the
// plugin - so the assertions went with it rather than the section coming back to
// satisfy them.
//
// The CONCERN those tests carried is real and did not go away: `wego/skills` is
// a projection, an edit there is silently overwritten by the next promote, and
// once the repo is public strangers will arrive at files they cannot usefully
// change. Nothing in the published tree says so any more, and nothing here
// asserts it, so this is a known gap rather than a solved problem. The fix that
// suits it is repo configuration rather than prose - Issues disabled on
// `wego/skills`, and the fact stated in the repo description - because both bind
// on a reader who never opens the README, and neither costs a published path.
describe("README.md's claims about the plugin", () => {
  const readme = readFileSync(readmePath, "utf8");

  it("names the licence and links the file beside it", () => {
    expect(readme).toContain("Apache License, Version 2.0");
    expect(readme).toContain("(LICENSE)");
  });

  it("does not claim the skill books anything", () => {
    // The one claim the skill is forbidden to make (SKILL.md operating contract
    // item 11) is also the one a README is most tempted to make, because
    // "booking" is the word that sells it. Asserted here so the boundary
    // survives a rewrite of the prose around it.
    expect(readme).toMatch(/Nothing is ever booked/i);
  });
});
