import { describe, expect, it } from "bun:test";
import { resolveEdgeTarget } from "./publish-edge-blob";

/**
 * The edge publisher's pure guards (foundations#74 rung 5). The Blob I/O lives
 * behind `import.meta.main`; only the version→target resolution is unit-tested,
 * mutation-first: an rc or plain build on edge must fail, and the target prefixes
 * must be the ring model's own (`cli/edge`, `cli/<version>`), never a flavor path.
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

  it("strips a cli-v tag prefix before resolving", () => {
    const r = resolveEdgeTarget("cli-v0.6.6-edge.abc1234");
    expect(r).toMatchObject({ version: "0.6.6-edge.abc1234" });
  });

  // Kill-the-mutation: edge must reject the plain line. A plain X.Y.Z routes to
  // `next` in the ring model, so accepting it on edge would ship a stable-shaped
  // build to the dogfood pointer. `ringForVersion(x) !== "edge"` is the guard.
  it("refuses a plain X.Y.Z release on edge (that is the next/stable line)", () => {
    const r = resolveEdgeTarget("0.6.6");
    expect(r).toHaveProperty("error");
    expect((r as { error: string }).error).toContain("edge serves only");
  });

  // Kill-the-mutation: an rc is a prerelease of a DIFFERENT shape; the edge
  // identifier is pinned to `-edge.`, so an `-rc.*` must never land on edge.
  it("refuses an -rc.* prerelease on edge", () => {
    const r = resolveEdgeTarget("0.6.6-rc.1");
    expect(r).toHaveProperty("error");
  });

  // Kill-the-mutation: the tag gate is the binary's own comparator, so an
  // unparseable edge id (empty, leading zero) is refused, not silently published.
  it("refuses an edge version the binary comparator would reject", () => {
    expect(resolveEdgeTarget("1.2.3-edge.")).toHaveProperty("error");
    expect(resolveEdgeTarget("01.2.3-edge.abc")).toHaveProperty("error");
  });

  it("carries the version verbatim into the immutable prefix", () => {
    const r = resolveEdgeTarget("2.0.0-edge.deadbee");
    expect(r).toMatchObject({ versionPrefix: "cli/2.0.0-edge.deadbee" });
  });
});
