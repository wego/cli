import { describe, expect, it } from "bun:test";
import { parseSemver } from "../src/version-notice";
import { releaseTagError } from "./validate-release-tag";

describe("releaseTagError", () => {
  it("accepts the tag shapes the release workflow actually cuts", () => {
    for (const tag of [
      "cli-v0.4.3",
      "cli-v1.0.0",
      "cli-v0.4.3-rc.1",
      "cli-v10.20.30-alpha.0.beta",
    ]) {
      expect(releaseTagError(tag)).toBeNull();
    }
  });

  it("rejects a tag the installed binary's comparator cannot parse", () => {
    // The whole reason this gate exists: each of these passed the old workflow
    // regex, so a binary stamped with one would compare `parseSemver(current) ===
    // null` against every future release and never notice one.
    for (const version of ["0.4.3-rc.01", "01.2.3", "1.0.0-a..b", "1.2.3-"]) {
      expect(parseSemver(version)).toBeNull(); // the premise, asserted
      expect(releaseTagError(`cli-v${version}`)).toContain(version);
    }
  });

  it("rejects a malformed shape before it reaches the parser", () => {
    for (const tag of ["1.2.3", "v1.2.3", "cli-v", "cli-v1.2.3+build.5", ""]) {
      expect(releaseTagError(tag)).toContain("Malformed tag");
    }
  });
});
