import { describe, expect, it } from "bun:test";
import { USER_AGENT } from "./api";

/**
 * THE BINARY MUST NAME ITSELF WHEN IT TALKS TO THE RELEASE ROUTE.
 *
 * `apps/api`'s legacy bridge pin (wego/foundations#132) keys on ONE thing: a
 * `?dl=` request for ring `stable` whose user agent starts with `Bun/` is a
 * pre-relay 1.0.x binary, and is redirected to the frozen bridge
 * `cli/cli-v1.1.0/` instead of the live pointer. A 1.0.x binary sends `Bun/…`
 * because it never set an agent, so Bun's default went out.
 *
 * That rule is allow-by-default: ANY request that fails to identify itself is
 * treated as legacy. So a wego/cli build that forgets the header is served the
 * frozen 1.1.0 release instead of the ring it asked for.
 *
 * WHAT THAT COSTS CHANGED WITH wego/cli#29, and both answers are bad. As v1.2.0
 * shipped, the bridge's record was signed under wego-ai's `cli-v1.1.0` tag and
 * the identity list could not match that shape, so the binary refused the record
 * and could never self-update again - loudly, exit 6, with no way forward. Now
 * that the shape is accepted, the same binary VERIFIES the bridge and installs
 * 1.1.0 over itself: a silent downgrade rather than a dead end. It settles there
 * (1.1.0 sends no agent either, so it is pinned too, and its hashes match what
 * the bridge serves) rather than oscillating, which is the only reason this is
 * the lesser failure. Neither is acceptable, and the header is what prevents
 * both.
 *
 * These tests state the invariant in the terms of that failure rather than
 * checking a header for its own sake.
 */
describe("the release route can tell this binary from a pre-relay one", () => {
  it("identifies itself", () => {
    expect(USER_AGENT).toStartWith("Wego-CLI/");
  });

  it("is NOT matched by the legacy bridge pin's predicate", () => {
    // The exact test `apps/api`'s `legacyBridgeTag` applies. If this ever
    // passes, every install built from this tree is pinned to the frozen
    // bridge and stops being able to update.
    expect(/^bun\//i.test(USER_AGENT)).toBe(false);
  });

  /**
   * A source scan rather than a behavioural test, deliberately: the failure
   * mode is "someone adds a fetch and forgets", which only a check over ALL
   * call sites can catch. A behavioural test only ever covers the paths it
   * already knows about — and v1.2.0 had passing tests for both of these
   * modules.
   *
   * `telemetry-send.ts` is excluded on purpose: it posts to the telemetry
   * host, never to `?dl=`, so the pin cannot see it.
   */
  it("sends the agent from every release-following fetch", async () => {
    const modules = ["src/update.ts", "src/version-notice.ts"];
    const offenders: string[] = [];

    for (const path of modules) {
      const lines = (await Bun.file(path).text()).split("\n");
      lines.forEach((line, i) => {
        if (!line.includes("deps.fetch(")) return;
        const optionBlock = lines.slice(i, i + 6).join("\n");
        if (!optionBlock.includes('"user-agent": USER_AGENT')) {
          offenders.push(`${path}:${i + 1} — ${line.trim()}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});
