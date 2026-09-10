import { describe, expect, it } from "bun:test";
import {
  assetName,
  DEFAULT_RING,
  isEdgeVersion,
  isPlainVersion,
  prefixForRing,
  RELEASE_ASSET_BASENAME,
  RINGS,
  resolveRing,
  ringAcceptsVersion,
  ringForVersion,
} from "./ring-rules";

// The mutations this suite kills (foundations#74 rung 4, mirroring rung 2's note):
//   - DEFAULT_RING flipped off `stable` -> "defaults to stable" fails.
//   - either half of the crossed-pair check removed -> a "refuses" case fails.
//   - the asset name made ring- or flavor-dependent -> "one filename" fails.

describe("the ring set", () => {
  it("is exactly edge, next, stable", () => {
    expect([...RINGS]).toEqual(["edge", "next", "stable"]);
  });
});

describe("resolveRing", () => {
  it("defaults an absent or empty ring to stable", () => {
    expect(DEFAULT_RING).toBe("stable");
    expect(resolveRing(undefined)).toBe("stable");
    expect(resolveRing(null)).toBe("stable");
    expect(resolveRing("")).toBe("stable");
  });

  it("resolves each known ring to itself", () => {
    expect(resolveRing("edge")).toBe("edge");
    expect(resolveRing("next")).toBe("next");
    expect(resolveRing("stable")).toBe("stable");
  });

  // Refuse, never fall back to the default: an unknown ring is a caller mistake,
  // and guessing one serves bytes from a pointer nobody asked for.
  it("refuses an unknown ring rather than guessing", () => {
    expect(resolveRing("latest")).toBeNull();
    expect(resolveRing("prod")).toBeNull();
    expect(resolveRing("EDGE")).toBeNull();
    expect(resolveRing("../edge")).toBeNull();
  });
});

describe("version shape", () => {
  it("reads a plain release version, tag or bare", () => {
    expect(isPlainVersion("0.6.5")).toBe(true);
    expect(isPlainVersion("cli-v0.6.5")).toBe(true);
    expect(isPlainVersion("10.20.30")).toBe(true);
  });

  it("rejects a prerelease as a plain version", () => {
    expect(isPlainVersion("0.6.5-edge.abc123")).toBe(false);
    expect(isPlainVersion("0.6.5-rc.1")).toBe(false);
  });

  it("reads an edge build by its -edge. marker", () => {
    expect(isEdgeVersion("0.6.6-edge.8bda9651e")).toBe(true);
    expect(isEdgeVersion("cli-v0.6.6-edge.8bda9651e")).toBe(true);
  });

  it("rejects a plain or rc version as an edge build", () => {
    expect(isEdgeVersion("0.6.5")).toBe(false);
    expect(isEdgeVersion("0.6.5-rc.1")).toBe(false);
    expect(isEdgeVersion("0.6.5-edge.")).toBe(false); // empty identifier
  });
});

describe("ringForVersion", () => {
  it("routes an edge build to edge and a plain version to next", () => {
    expect(ringForVersion("0.6.6-edge.8bda9651e")).toBe("edge");
    expect(ringForVersion("0.6.5")).toBe("next");
  });

  // stable is reached only by promoting a next build, never by version shape.
  it("gives an rc or other prerelease no ring", () => {
    expect(ringForVersion("0.6.5-rc.1")).toBeNull();
    expect(ringForVersion("0.6.5-beta.2")).toBeNull();
  });
});

describe("ringAcceptsVersion (the crossed-pair refusal)", () => {
  it("accepts each ring's own version shape", () => {
    expect(ringAcceptsVersion("edge", "0.6.6-edge.8bda9651e")).toBeNull();
    expect(ringAcceptsVersion("next", "0.6.5")).toBeNull();
    expect(ringAcceptsVersion("stable", "0.6.5")).toBeNull();
  });

  it("refuses a plain build on edge", () => {
    expect(ringAcceptsVersion("edge", "0.6.5")).toContain("X.Y.Z-edge.*");
  });

  it("refuses a prerelease on next and stable, both directions of the pair", () => {
    expect(ringAcceptsVersion("next", "0.6.5-edge.abc")).toContain(
      "plain X.Y.Z",
    );
    expect(ringAcceptsVersion("stable", "0.6.5-edge.abc")).toContain(
      "plain X.Y.Z",
    );
    expect(ringAcceptsVersion("next", "0.6.5-rc.1")).toContain("plain X.Y.Z");
  });

  it("refuses an rc on edge - edge is the -edge. line only", () => {
    expect(ringAcceptsVersion("edge", "0.6.5-rc.1")).toContain("X.Y.Z-edge.*");
  });
});

describe("one filename on every prefix", () => {
  it("names the same wego-* asset on every ring", () => {
    expect(RELEASE_ASSET_BASENAME).toBe("wego");
    for (const _ring of RINGS) {
      expect(assetName("linux-x64")).toBe("wego-linux-x64");
      expect(assetName("linux-x64")).not.toContain("wegostaging");
    }
  });

  it("puts each ring's pointer under cli/<ring>", () => {
    expect(prefixForRing("edge")).toBe("cli/edge");
    expect(prefixForRing("next")).toBe("cli/next");
    expect(prefixForRing("stable")).toBe("cli/stable");
  });
});
