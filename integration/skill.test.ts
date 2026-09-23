/**
 * `wego skill`: the agent skill embedded in the binary, installed into a throwaway
 * home. The installer's branches (ownership markers, remote bodies, agent paths)
 * are `src/skill.test.ts`; here is proof the compiled binary carries the skill this
 * checkout ships, byte for byte.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { useScenario } from "./harness/scenario";
import { json } from "./harness/wego";

const s = useScenario();

const SHIPPED = fileURLToPath(
  new URL("../skills/wego/SKILL.md", import.meta.url),
);

describe("skill", () => {
  it("lists the embedded skill as JSON", async () => {
    const result = await s.run(["skill", "list", "--json"]);
    expect(result.code).toBe(0);
    expect(json<{ id: string }[]>(result).map((e) => e.id)).toEqual(["wego"]);
  });

  it("installs the embedded skill, identical to skills/wego/SKILL.md", async () => {
    const result = await s.run(["skill", "install", "-y", "--embedded"]);
    expect(result.code).toBe(0);
    expect(
      readFileSync(
        join(s.home.dir, ".claude", "skills", "wego", "SKILL.md"),
        "utf8",
      ),
    ).toBe(readFileSync(SHIPPED, "utf8"));
  });

  it("rejects an unknown skill id and names `wego skill list`", async () => {
    const result = await s.run(["skill", "install", "ghost", "-y"]);
    expect(result.code).not.toBe(0);
    expect(result.err).toMatch(/wego skill list/);
  });
});
