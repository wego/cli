import { describe, expect, it } from "bun:test";
import { parseSemver } from "../src/version-notice";
import { releaseTagError } from "./validate-release-tag";

describe("releaseTagError", () => {
  it("accepts the tag shapes the release workflow actually cuts", () => {
    for (const tag of [
      "v0.4.3",
      "v1.0.0",
      "v0.4.3-rc.1",
      "v10.20.30-alpha.0.beta",
    ]) {
      expect(releaseTagError(tag)).toBeNull();
    }
  });

  it("rejects a tag the installed binary's comparator cannot parse", () => {
    // Each of these passes the workflow's shape regex, and a binary stamped with
    // one would get `parseSemver(current) === null` against every future release
    // and never notice one.
    for (const version of ["0.4.3-rc.01", "01.2.3", "1.0.0-a..b", "1.2.3-"]) {
      expect(parseSemver(version)).toBeNull(); // the premise, asserted
      expect(releaseTagError(`v${version}`)).toContain(version);
    }
  });

  it("rejects a malformed shape before it reaches the parser", () => {
    // `V1.2.3` is the wrong-prefix case: the shape is anchored and
    // case-sensitive, so only a lowercase `v` starts a release tag.
    for (const tag of ["1.2.3", "V1.2.3", "v", "v1.2.3+build.5", ""]) {
      expect(releaseTagError(tag)).toContain("Malformed tag");
    }
  });
});
