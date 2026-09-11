import { describe, expect, it } from "bun:test";
import {
  commitSidecarPath,
  EDGE_SIGNING_IDENTITY,
  identitiesForRing,
  MANIFEST_ASSET,
  manifestCoversAll,
  manifestEntries,
  SIGNATURE_ASSET,
  SIGNING_IDENTITY,
  SIGNING_OIDC_ISSUER,
  signedRecordRefusal,
  sigPrefixForRing,
  sigPrefixForTag,
} from "./release-signing";
import { prefixForRing, RINGS } from "./ring-rules";

// The mutations this suite kills (foundations#74 rung 9):
//   - the record prefix moved inside the download prefix -> "outside" fails.
//   - manifestCoversAll made vacuous on an empty manifest -> "lists nothing" fails.
//   - an unlisted object allowed through -> "refuses an object no record covers".
//   - the pinned identity or issuer loosened -> the pinning cases fail.
//   - edge and release lanes collapsed onto one identity -> "cannot pass as" fails.

describe("the signed record's name", () => {
  it("is one well-known Sigstore bundle beside the manifest it signs", () => {
    expect(MANIFEST_ASSET).toBe("SHA256SUMS.txt");
    expect(SIGNATURE_ASSET).toBe("SHA256SUMS.txt.sigstore.json");
  });
});

describe("where a record is stored", () => {
  // The whole rung: a record that shares a prefix with the downloads falls to the
  // same store write it is supposed to detect.
  it("is outside every ring's download prefix", () => {
    for (const ring of RINGS) {
      const download = prefixForRing(ring);
      const record = sigPrefixForRing(ring);
      expect(record).not.toBe(download);
      expect(record.startsWith(`${download}/`)).toBe(false);
      expect(download.startsWith(`${record}/`)).toBe(false);
    }
  });

  it("mirrors the download prefix's shape, ring for ring and tag for tag", () => {
    expect(sigPrefixForRing("next")).toBe("cli-sig/next");
    expect(sigPrefixForRing("stable")).toBe("cli-sig/stable");
    expect(sigPrefixForRing("edge")).toBe("cli-sig/edge");
    expect(sigPrefixForTag("v1.2.3")).toBe("cli-sig/v1.2.3");
  });
});

describe("manifestEntries", () => {
  it("reads the names sha256sum writes, in either binary or text form", () => {
    const body = [
      `${"a".repeat(64)}  wego-darwin-arm64`,
      `${"b".repeat(64)} *wego-linux-x64`,
      "",
      "not a manifest line",
    ].join("\n");
    expect(manifestEntries(body)).toEqual([
      "wego-darwin-arm64",
      "wego-linux-x64",
    ]);
  });

  it("skips a line whose hash is not a sha256 rather than guessing at it", () => {
    expect(manifestEntries("deadbeef  wego-darwin-arm64")).toEqual([]);
  });
});

describe("manifestCoversAll", () => {
  const sums = [
    `${"a".repeat(64)}  wego-darwin-arm64`,
    `${"b".repeat(64)}  wego-linux-x64`,
    `${"c".repeat(64)}  VERSION`,
  ].join("\n");

  it("accepts a publish whose every object the manifest lists", () => {
    expect(
      manifestCoversAll(sums, [
        "wego-darwin-arm64",
        "wego-linux-x64",
        "VERSION",
      ]),
    ).toBeNull();
  });

  // The manifest cannot list its own hash, and the record lives on another prefix
  // entirely — neither is evidence of an unsigned file.
  it("does not require the manifest or the record to list themselves", () => {
    expect(
      manifestCoversAll(sums, [
        "wego-darwin-arm64",
        "wego-linux-x64",
        "VERSION",
        MANIFEST_ASSET,
        SIGNATURE_ASSET,
      ]),
    ).toBeNull();
  });

  it("refuses an object no record covers, naming it", () => {
    const reason = manifestCoversAll(sums, [
      "wego-darwin-arm64",
      "wego-linux-arm64",
    ]);
    expect(reason).toContain("wego-linux-arm64");
    expect(reason).toContain("not listed in the signed SHA256SUMS.txt");
  });

  // Vacuous truth is the failure mode worth naming: an empty manifest "covers"
  // nothing, so a bug that emptied it would otherwise wave every object through.
  it("refuses a manifest that lists nothing at all", () => {
    expect(manifestCoversAll("", ["wego-darwin-arm64"])).toContain(
      "lists no files",
    );
    expect(manifestCoversAll("", [])).toContain("lists no files");
  });
});

describe("the pinned signing identity", () => {
  it("names this repo's release workflow on main, and GitHub as the issuer", () => {
    expect(SIGNING_IDENTITY).toBe(
      "https://github.com/wego/wego-ai/.github/workflows/release-cli.yml@refs/heads/main",
    );
    expect(SIGNING_OIDC_ISSUER).toBe(
      "https://token.actions.githubusercontent.com",
    );
  });

  // A dogfood record must never pass as a release record: cli/edge's publish gate
  // is far looser, so collapsing the two identities would let an edge build reach
  // the ring everyone installs from.
  it("cannot pass as the edge lane's, or the other way round", () => {
    expect(EDGE_SIGNING_IDENTITY).not.toBe(SIGNING_IDENTITY);
    // The edge lane accepts exactly ONE identity: it triggers only on main, so it
    // has no second entry to allow for.
    expect(identitiesForRing("edge")).toEqual([EDGE_SIGNING_IDENTITY]);
    expect(identitiesForRing("edge")).not.toContain(SIGNING_IDENTITY);
    // The release rings accept the release workflow on main AND on a `v*` tag,
    // its two documented entries — never the edge lane's.
    expect(identitiesForRing("next")).toContain(SIGNING_IDENTITY);
    expect(identitiesForRing("next")).not.toContain(EDGE_SIGNING_IDENTITY);
    // stable carries the release lane's identities: a promote copies the record it
    // was given, it never re-signs.
    expect(identitiesForRing("stable")).toEqual(identitiesForRing("next"));
  });
});

// The refusal an operator actually reads. A parse failure is a SIGNER fault, but the
// bare verdict names the ring, which sends them to the publisher instead - how
// `v0.7.0` (run 32977203696) and edge run 32930712877 were both misdiagnosed.
//
// Mutations this kills: dropping the hint entirely; attaching it to every reason so
// it stops meaning anything; matching on cosign's exact wording, which a reworded
// parser message would slip past.
describe("signedRecordRefusal", () => {
  const path = "cli/v0.7.0/SHA256SUMS.txt";

  it("always states the manifest, the ring and the reason", () => {
    const out = signedRecordRefusal(path, "next", "some reason");
    expect(out).toContain(path);
    expect(out).toContain("ring next");
    expect(out).toContain("some reason");
  });

  it.each([
    // The exact string the first real release died on.
    "unreadable signed build record: malformed DER: bundle is not an object",
    "bundle is not an object",
    "record is not JSON",
    "failed to parse bundle",
  ])("names the legacy-bundle cause for an unreadable record: %s", (reason) => {
    const out = signedRecordRefusal(path, "next", reason);
    expect(out).toContain("--new-bundle-format");
    // Says which END of the lane to look at, which is the whole point.
    expect(out).toContain("signer fault");
  });

  it.each([
    "certificate identity does not match",
    "signature does not verify over the payload",
    "issuer mismatch",
  ])("stays quiet when the record parsed and failed verification: %s", (reason) => {
    const out = signedRecordRefusal(path, "stable", reason);
    expect(out).not.toContain("--new-bundle-format");
    // A hint on every refusal is a hint on none.
    expect(out).toBe(`${path} is not vouched for on ring stable: ${reason}`);
  });
});

// THE CONFLICT THAT BURNED v0.7.1 (run 33036257401).
//
// `manifestCoversAll` requires every object under the tag's DOWNLOAD prefix to be
// listed in the signed manifest. The commit-binding sidecar cannot be: the
// publisher writes it after the manifest was hashed and signed. Both rules are
// right; nothing ran them together until a real release published 13 objects,
// verified all of them, and then refused its own pointer move.
//
// The sidecar now lives on the RECORD prefix, so coverage never sees it. These
// cases pin that, and would fail if it were moved back beside the downloads.
describe("commitSidecarPath", () => {
  const tag = "v0.7.1";

  it("puts the sidecar on the record prefix, not the download prefix", () => {
    const path = commitSidecarPath(tag);
    expect(path).toBe(`${sigPrefixForTag(tag)}/COMMIT`);
    // The load-bearing half: outside `cli/<tag>/`, which is what coverage scans.
    expect(path.startsWith(`cli/${tag}/`)).toBe(false);
  });

  it("keeps a tag's sidecar and its downloads on separate prefixes", () => {
    expect(commitSidecarPath(tag)).not.toBe(`cli/${tag}/COMMIT`);
  });

  // The regression itself, stated as the two sets coverage compares.
  it("coverage passes for the deliverables and fails if the sidecar rejoins them", () => {
    const manifest = [
      `${"a".repeat(64)}  wego-linux-x64`,
      `${"b".repeat(64)}  VERSION`,
    ].join("\n");
    const deliverables = ["wego-linux-x64", "VERSION", MANIFEST_ASSET];
    expect(manifestCoversAll(manifest, deliverables)).toBeNull();
    // Exactly what v0.7.1 hit: an unlisted COMMIT under the tag prefix.
    const withSidecar = [...deliverables, "COMMIT"];
    expect(manifestCoversAll(manifest, withSidecar)).toContain("COMMIT");
  });
});
