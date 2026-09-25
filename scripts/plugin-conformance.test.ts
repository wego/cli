/**
 * Conformance for `plugin/plugin.json`, the manifest the publisher ships to
 * `wego/skills` verbatim (foundations#101).
 *
 * The permitted field set is checked by hand against the ten fields Agent
 * Plugins spec §5.2 lists, not against a fetched or vendored schema: the spec is
 * normative prose, a vendored schema would be a second source of truth, and a
 * fetch would need the network. The cost is the `1.0.0` URL appearing in three
 * places (the manifest, this test, and the probe) to update on a version bump.
 *
 * No client we ship to reads a root `plugin.json` yet, so this test stands in
 * for that future consumer: an unvalidated manifest is wrong the first time
 * anybody checks it.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const cliRoot = join(import.meta.dir, "..");
const manifestPath = join(cliRoot, "plugin/plugin.json");
const readmePath = join(cliRoot, "plugin/README.md");
const licensePath = join(cliRoot, "plugin/LICENSE");

/** The ten fields Agent Plugins §5.2 permits. Closed: no consumer is required
 *  to understand anything else. */
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
    // A hand-written version drifts from what actually shipped, undetectably,
    // because the file reads as authoritative (wego/wego-ai#1751). The plugin
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
    // §5.2 does not constrain `license`, so the constraint is ours: an SPDX id
    // is the only spelling a consumer can match mechanically. "Apache 2.0" looks
    // right to a human but is not one.
    expect(manifest.license).toBe("Apache-2.0");
  });
});

/**
 * SHA-256 of the canonical Apache 2.0 text, over LF line endings.
 *
 * Re-derive it with:
 *   curl -fsSL https://www.apache.org/licenses/LICENSE-2.0.txt | shasum -a 256
 *
 * This is the integrity check. Landmarks and a length floor are not enough:
 * every structural landmark sits outside the clauses that grant anything, so a
 * file with an edited patent or trademark clause would pass them and publish as
 * "Apache 2.0".
 */
const CANONICAL_APACHE_2_SHA256 =
  "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30";

function licenseDigest(text: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(text.replaceAll("\r\n", "\n"));
  return h.digest("hex");
}

describe("LICENSE is the Apache 2.0 text, verbatim", () => {
  // Published to `wego/skills` byte for byte. Any diff against apache.org's
  // text would be a different licence under the same name.
  const license = readFileSync(licensePath, "utf8");

  it("matches the canonical text by digest", () => {
    expect(licenseDigest(license)).toBe(CANONICAL_APACHE_2_SHA256);
  });

  // Not a test of SHA-256: it guards this file's comparison. A `licenseDigest`
  // that returned the pinned constant, a read of the wrong path, or a
  // normalisation that flattened everything would each make the assertion
  // above pass on any bytes. Same vacuity guard as `pinDrift` refusing an empty
  // bundle and `workflow-lanes` refusing an empty CODEOWNERS parse.
  it("rejects an altered licence", () => {
    // One word inside the patent grant. It keeps every landmark the test below
    // checks, so only the digest can catch it.
    const tampered = license.replace(
      "royalty-free, irrevocable",
      "royalty-free, revocable",
    );
    expect(tampered).not.toBe(license);
    expect(licenseDigest(tampered)).not.toBe(CANONICAL_APACHE_2_SHA256);
  });

  it("carries the title, the version line and the appendix", () => {
    // For diagnosis, not integrity: when the digest fails these say which part
    // drifted.
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
  // The most public files the plugin ships, and the repo rule is no em-dash in
  // user-facing writing.
  //
  // `LICENSE` is deliberately excluded: it is verbatim third-party text we
  // cannot edit, and the house style governs only writing we author.
  it.each([
    ["plugin.json", raw],
    ["README.md", readFileSync(readmePath, "utf8")],
  ])("%s carries no em-dash", (_name, body) => {
    expect(body).not.toContain("—");
  });
});

// Known gap: `wego/skills` is a projection, so an edit there is silently
// overwritten by the next promote, and nothing in the published tree says so.
// The README deliberately leaves out build plumbing. The intended fix is repo
// configuration (Issues disabled on `wego/skills`, the fact stated in the repo
// description), which reaches readers who never open the README.
describe("README.md's claims about the plugin", () => {
  const readme = readFileSync(readmePath, "utf8");

  it("names the licence and links the file beside it", () => {
    expect(readme).toContain("Apache License, Version 2.0");
    expect(readme).toContain("(LICENSE)");
  });

  it("does not claim the skill books anything", () => {
    // The skill must never claim a booking (SKILL.md operating contract item
    // 11), and a README is tempted to. Asserted so the boundary survives a
    // rewrite of the prose.
    expect(readme).toMatch(/Nothing is ever booked/i);
  });
});
