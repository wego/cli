/**
 * `wego skill`: the agent skill embedded in the binary, installed into a throwaway
 * home. The installer's branches (ownership markers, edit protection, agent paths)
 * are `src/skill.test.ts`; here is proof the compiled binary carries the skill this
 * checkout ships, byte for byte.
 */

import { describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SKILLS } from "../src/skill-embed";
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

  it("installs every embedded skill file byte for byte", async () => {
    const result = await s.run(["skill", "install", "-y", "--embedded"]);
    expect(result.code).toBe(0);
    const installedDir = join(s.home.dir, ".claude/skills/wego");
    expect(
      readdirSync(installedDir, { recursive: true, encoding: "utf8" })
        .filter((path) => statSync(join(installedDir, path)).isFile())
        .sort(),
    ).toEqual(
      [".wego-skill-owner", ...SKILLS[0].files.map(({ path }) => path)].sort(),
    );
    expect(
      readFileSync(
        join(s.home.dir, ".claude", "skills", "wego", "SKILL.md"),
        "utf8",
      ),
    ).toBe(readFileSync(SHIPPED, "utf8"));
    for (const { path } of SKILLS[0].files) {
      expect(
        readFileSync(join(s.home.dir, ".claude/skills/wego", path)),
      ).toEqual(
        readFileSync(new URL(`../skills/wego/${path}`, import.meta.url)),
      );
    }
  });

  it.each(
    SKILLS[0].files.map(({ path }) => [path]),
  )("names an edited %s when skipping and replacing it", async (path) => {
    await s.run(["skill", "install", "-y"]);
    const file = join(s.home.dir, ".claude/skills/wego", path);
    writeFileSync(file, "local edit\n");

    const skipped = await s.run([
      "skill",
      "install",
      "--keep-local-edits",
      "-y",
    ]);
    expect(skipped.code).toBe(0);
    expect(skipped.out).toContain(`${path} has local modifications`);
    expect(skipped.out).toContain("replace it with the copy in this binary.");
    if (path !== "SKILL.md")
      expect(skipped.out).not.toContain("SKILL.md has local modifications");
    expect(readFileSync(file, "utf8")).toBe("local edit\n");

    const replaced = await s.run(["skill", "install", "-y"]);
    expect(replaced.code).toBe(0);
    expect(replaced.out).toContain(`Changed files: ${path}.`);
    expect(readFileSync(file)).toEqual(
      readFileSync(new URL(`../skills/wego/${path}`, import.meta.url)),
    );
  });

  it("adopts identical orphan references left by an old uninstall", async () => {
    const dir = join(s.home.dir, ".claude/skills/wego");
    for (const { path } of SKILLS[0].files.slice(1)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(
        join(dir, path),
        readFileSync(new URL(`../skills/wego/${path}`, import.meta.url)),
      );
    }
    const installed = await s.run(["skill", "install", "-y"]);
    expect(installed.code).toBe(0);
    const marker = readFileSync(join(dir, ".wego-skill-owner"), "utf8");
    for (const { path } of SKILLS[0].files) {
      expect(readFileSync(join(dir, path))).toEqual(
        readFileSync(new URL(`../skills/wego/${path}`, import.meta.url)),
      );
      expect(marker).toContain(` ${path}\n`);
    }
  });

  it.each([
    "install",
    "uninstall",
  ])("names the existing foreign reference on %s", async (operation) => {
    const dir = join(s.home.dir, ".claude/skills/wego");
    const path = SKILLS[0].files[2].path;
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), "mine\n");
    const refused = await s.run(["skill", operation, "-y"]);
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain(`${join(dir, path)} exists`);
    expect(refused.err).not.toContain(`${join(dir, "SKILL.md")} exists`);
    expect(readFileSync(join(dir, path), "utf8")).toBe("mine\n");
    expect(existsSync(join(dir, ".wego-skill-owner"))).toBe(false);
  });

  it("lists every written file in every target in the confirmation prompt", async () => {
    const result = await s.run([
      "skill",
      "install",
      "--agent",
      "claude",
      "--agent",
      "codex",
    ]);
    expect(result.code).toBe(0);
    for (const agent of ["claude", "codex"]) {
      for (const { path } of SKILLS[0].files)
        expect(result.err).toContain(
          join(s.home.dir, `.${agent}/skills/wego`, path),
        );
    }
    expect(result.out).toContain("Skipped.");
    expect(existsSync(join(s.home.dir, ".claude/skills/wego"))).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)(
    "uninstalls when the ownership marker is unreadable",
    async () => {
      await s.run(["skill", "install", "-y"]);
      const dir = join(s.home.dir, ".claude/skills/wego");
      chmodSync(join(dir, ".wego-skill-owner"), 0o000);
      const result = await s.run(["skill", "uninstall", "-y"]);
      expect(result.code).toBe(0);
      expect(existsSync(dir)).toBe(false);
    },
  );

  it("documents the embedded compatibility flag", async () => {
    const result = await s.run(["skill", "--help"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("Accepted for compatibility");
    expect(result.out.replace(/\s+/g, " ")).toContain(
      "install always writes the copy embedded in this binary",
    );
    expect(result.out).not.toContain("no download");
  });

  it("names multiple modified files with plural embedded-copy wording", async () => {
    await s.run(["skill", "install", "-y"]);
    const dir = join(s.home.dir, ".claude/skills/wego");
    const paths = SKILLS[0].files.slice(1).map(({ path }) => join(dir, path));
    for (const path of paths) writeFileSync(path, "mine\n");
    const result = await s.run([
      "skill",
      "install",
      "--keep-local-edits",
      "-y",
    ]);
    expect(result.code).toBe(0);
    for (const path of paths) expect(result.out).toContain(path);
    expect(result.out).toContain("have local modifications");
    expect(result.out).toContain("replace them with the copy in this binary.");
    expect(result.out).not.toContain("published copy");
  });

  it("rejects an unknown skill id and names `wego skill list`", async () => {
    const result = await s.run(["skill", "install", "ghost", "-y"]);
    expect(result.code).not.toBe(0);
    expect(result.err).toMatch(/wego skill list/);
  });
});
