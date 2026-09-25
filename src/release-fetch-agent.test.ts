import { describe, expect, it } from "bun:test";
import { USER_AGENT } from "./api";

/**
 * The binary must identify itself to the release route.
 *
 * `apps/api`'s legacy bridge pin (wego/foundations#132) treats a `?dl=` request
 * for ring `stable` whose user agent starts with `Bun/` as a pre-relay 1.0.x
 * binary (which never set an agent, so Bun's default went out) and redirects it
 * to the frozen bridge `cli/cli-v1.1.0/`. Any request that fails to identify
 * itself is treated as legacy, so a wego/cli build that forgets the header is
 * served 1.1.0 instead of the ring it asked for.
 *
 * Since wego/cli#29 the bridge's record verifies, so an agent-less build installs
 * 1.1.0 over itself. 1.1.0 does send `Wego-CLI/1.1.0` (`git show
 * cli-v1.1.0:apps/cli/src/update.ts` carries the header on both fetches) and
 * carries `CLI_RELEASE_TAG_IDENTITY`, since it is the relay release. It is pinned
 * by nothing, reads the live `cli/stable`, and accepts whatever wego/cli signed
 * there. If that is the agent-less build, every `wego update` flips between the
 * two forever.
 *
 * What prevents the loop is that an agent-less build cannot reach a ring:
 * `release-cli.yml` refuses to publish one and `promote-cli.yml` refuses to
 * promote one, both by checking this header on the compiled binary.
 */
describe("the release route can tell this binary from a pre-relay one", () => {
  it("identifies itself", () => {
    expect(USER_AGENT).toStartWith("Wego-CLI/");
  });

  it("is NOT matched by the legacy bridge pin's predicate", () => {
    // The exact test `apps/api`'s `legacyBridgeTag` applies. If it matched, every
    // install built from this tree would be pinned to the frozen bridge.
    expect(/^bun\//i.test(USER_AGENT)).toBe(false);
  });

  /**
   * A source scan rather than a behavioural test: the failure mode is someone
   * adding a fetch and forgetting the header, which only a check over every call
   * site catches. v1.2.0 had passing behavioural tests for both modules.
   *
   * `telemetry-send.ts` is excluded: it posts to the telemetry host, never to
   * `?dl=`, so the pin cannot see it.
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
