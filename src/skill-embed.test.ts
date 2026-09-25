import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEmbeddedSkill, SKILLS } from "./skill-embed";

const cliRoot = join(import.meta.dir, "..");
const skillMd = join(cliRoot, "skills/wego/SKILL.md");

/** The leading YAML frontmatter block, without its `---` fences. Scoped because
 *  the body can contain a line beginning `compatibility:`, which would otherwise
 *  stand in for a deleted frontmatter field and let the guard pass. */
function frontmatter(src: string): string {
  const block = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?(?:\n|$)/)?.[1];
  if (block === undefined) {
    throw new Error("SKILL.md has no YAML frontmatter block");
  }
  return block;
}

/** Throws rather than returning "" so a renamed or deleted field fails here
 *  instead of passing a zero-length check. */
function frontmatterField(src: string, name: string): string {
  const value = frontmatter(src)
    .match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1]
    ?.trim();
  if (!value) throw new Error(`SKILL.md frontmatter has no \`${name}:\``);
  return value;
}

describe("readEmbeddedSkill", () => {
  it("returns the real SKILL.md body baked from the skill directory", async () => {
    const body = await readEmbeddedSkill();
    // Anchors from skills/wego/SKILL.md, so an empty or placeholder file fails.
    expect(body).toContain("# Wego CLI");
    expect(body).toContain("Operating contract");
    expect(body.length).toBeGreaterThan(500);
  });
});

describe("SKILLS registry", () => {
  it("registers exactly one skill today, id `wego`", () => {
    expect(SKILLS.map((s) => s.id)).toEqual(["wego"]);
  });

  it("each entry's id equals its frontmatter `name` and its description matches", () => {
    // Drift guard: the registry copies the frontmatter, so an edit to one side
    // without the other fails here.
    const src = readFileSync(skillMd, "utf8");
    const fmName = frontmatterField(src, "name");
    const fmDesc = frontmatterField(src, "description");
    expect(fmName).toBe("wego");
    expect(SKILLS[0].id).toBe(fmName);
    expect(SKILLS[0].description).toBe(fmDesc);
  });
});

// Agent Skills caps these fields. An edit that overruns a cap is invisible on
// disk and in review and only shows up where the skill is consumed, so the
// limits are pinned here.
describe("SKILL.md frontmatter limits", () => {
  it("description stays within the 1024-character cap", () => {
    const value = frontmatterField(
      readFileSync(skillMd, "utf8"),
      "description",
    );
    expect(value.length).toBeLessThanOrEqual(1024);
  });

  it("compatibility stays within the 500-character cap", () => {
    const value = frontmatterField(
      readFileSync(skillMd, "utf8"),
      "compatibility",
    );
    expect(value.length).toBeLessThanOrEqual(500);
  });
});

// The skill ships to end users, whose binary has no repo, no `.envrc`, no local
// API and a baked API URL, so developer-local guidance (direnv, `bun dev`,
// `localhost:3001`) would be wrong there. It belongs in AGENTS.md, and this
// guard keeps an edit or a bot autofix from moving it into the skill.
describe("SKILL.md dev/prod boundary", () => {
  const DEV_ONLY_TOKENS = [
    "localhost:3001",
    "bun dev",
    "direnv",
    ".envrc",
    ".env.local",
    "WEGO_BUILD",
    "apps/api",
    "apps/cli",
  ];

  it("contains no developer-local tokens (dev setup belongs in AGENTS.md)", () => {
    const body = readFileSync(skillMd, "utf8").toLowerCase();
    const leaked = DEV_ONLY_TOKENS.filter((t) =>
      body.includes(t.toLowerCase()),
    );
    expect(leaked).toEqual([]);
  });
});

// The tests above prove the `with { type: "file" }` import resolves from source.
// This proves `bun build --compile` bakes SKILL.md into the executable so
// `skill install` works with no repo present. The compile is sub-second, so it
// runs in the normal suite.
describe("skill embed in a compiled binary", () => {
  it("bakes SKILL.md into `bun build --compile` output, served detached from source", () => {
    const work = mkdtempSync(join(tmpdir(), "wego-compile-"));
    const bin = join(work, "wego");
    try {
      // `process.execPath` is the bun running this test, so `bun` need not be on
      // PATH.
      const build = Bun.spawnSync(
        [
          process.execPath,
          "build",
          "--compile",
          join(cliRoot, "src/index.ts"),
          "--outfile",
          bin,
        ],
        // Compile from the throwaway dir because `bun build --compile` drops
        // `.bun-build` intermediates in its cwd, which must not land in the
        // repo. The asset import resolves relative to the module, so cwd does
        // not affect resolution.
        { cwd: work, stdout: "pipe", stderr: "pipe" },
      );
      if (!build.success) {
        throw new Error(
          `bun build --compile failed:\n${new TextDecoder().decode(build.stderr)}`,
        );
      }

      // Run from the throwaway dir so a pass can only mean the skill was baked
      // into the binary. `--dir` keeps the write inside the throwaway tree.
      const skillsRoot = join(work, "skills-root");
      const run = Bun.spawnSync(
        [bin, "skill", "install", "--embedded", "--dir", skillsRoot, "-y"],
        { cwd: work, stdout: "pipe", stderr: "pipe" },
      );
      expect(run.exitCode).toBe(0);

      const installed = readFileSync(
        join(skillsRoot, "wego", "SKILL.md"),
        "utf8",
      );
      expect(installed.trimEnd()).toBe(readFileSync(skillMd, "utf8").trimEnd());
      expect(installed).toContain("# Wego CLI");

      // A second install must land on the same leaf rather than derive one from
      // the environment.
      const again = Bun.spawnSync(
        [bin, "skill", "install", "--embedded", "--dir", skillsRoot, "-y"],
        { cwd: work, stdout: "pipe", stderr: "pipe" },
      );
      expect(again.exitCode).toBe(0);
      expect(
        readFileSync(join(skillsRoot, "wego", "SKILL.md"), "utf8").trimEnd(),
      ).toBe(readFileSync(skillMd, "utf8").trimEnd());
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 120_000);
});
