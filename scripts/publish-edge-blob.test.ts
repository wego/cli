import { describe, expect, it } from "bun:test";
import { resolveEdgeTarget } from "./publish-edge-blob";

/**
 * The Blob I/O lives behind `import.meta.main`; only the version-to-target
 * resolution is unit-tested.
 */
describe("resolveEdgeTarget", () => {
  it("accepts an X.Y.Z-edge.<sha> build and routes it to cli/edge", () => {
    const r = resolveEdgeTarget("0.6.6-edge.abc1234");
    expect(r).toEqual({
      version: "0.6.6-edge.abc1234",
      versionPrefix: "cli/0.6.6-edge.abc1234",
      ringPrefix: "cli/edge",
    });
  });

  it("strips a v tag prefix before resolving", () => {
    const r = resolveEdgeTarget("v0.6.6-edge.abc1234");
    expect(r).toMatchObject({ version: "0.6.6-edge.abc1234" });
  });

  // A plain X.Y.Z routes to `next`, so accepting it on edge would ship a
  // stable-shaped build to the dogfood pointer.
  it("refuses a plain X.Y.Z release on edge (that is the next/stable line)", () => {
    const r = resolveEdgeTarget("0.6.6");
    expect(r).toHaveProperty("error");
    expect((r as { error: string }).error).toContain("edge serves only");
  });

  it("refuses an -rc.* prerelease on edge", () => {
    const r = resolveEdgeTarget("0.6.6-rc.1");
    expect(r).toHaveProperty("error");
  });

  it("refuses an edge version the binary comparator would reject", () => {
    expect(resolveEdgeTarget("1.2.3-edge.")).toHaveProperty("error");
    expect(resolveEdgeTarget("01.2.3-edge.abc")).toHaveProperty("error");
  });

  it("carries the version verbatim into the immutable prefix", () => {
    const r = resolveEdgeTarget("2.0.0-edge.deadbee");
    expect(r).toMatchObject({ versionPrefix: "cli/2.0.0-edge.deadbee" });
  });
});
