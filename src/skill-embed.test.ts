import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEmbeddedSkill, SKILLS } from "./skill-embed";

const cliRoot = join(import.meta.dir, "..");
const skillMd = join(cliRoot, "skills/wego/SKILL.md");

/** The leading YAML frontmatter block, without its `---` fences. Scoped on
 *  purpose: the body is prose that can legally contain a line beginning
 *  `compatibility:`, and matching the whole document would let such a line stand
 *  in for a frontmatter field that was deleted — the guard would then pass while
 *  the metadata it exists to check is gone. */
function frontmatter(src: string): string {
  const block = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?(?:\n|$)/)?.[1];
  if (block === undefined) {
    throw new Error("SKILL.md has no YAML frontmatter block");
  }
  return block;
}

/** One frontmatter scalar's value, trimmed. Throws rather than returning "" so a
 *  renamed or deleted field reds here instead of passing a zero-length check. */
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
    // Anchors from skills/wego/SKILL.md — proves the embed resolved to
    // the actual skill, not an empty/placeholder file.
    expect(body).toContain("# Wego CLI");
    expect(body).toContain("Operating contract");
    expect(body.length).toBeGreaterThan(500);
  });

  // Issue #105. The help text was the only surface describing `--stops`, and it
  // described it backwards; the skill named just `--stops 0`, the single value
  // where "exact set" and "maximum" agree, so it never contradicted the help.
  // The skill is what an agent reads, so it has to carry the enumerated form -
  // and unlike --alliances/--aircraft there is no metadata.filterOptions.stops
  // to fall back on, which leaves these two surfaces as the only sources.
  it("teaches the enumerated `at most N stops` form of --stops", async () => {
    const body = await readEmbeddedSkill();
    expect(body).toContain("`--stops 0,1`");
    expect(body).toMatch(/`--stops` selects an exact set/);
  });
});

describe("SKILLS registry", () => {
  it("registers exactly one skill today, id `wego`", () => {
    expect(SKILLS.map((s) => s.id)).toEqual(["wego"]);
  });

  it("each entry's id equals its frontmatter `name` and its description matches", () => {
    // Drift guard: the registry description is a copy of the frontmatter
    // `description:`, and the id must equal the frontmatter `name:` (the
    // id == name == dir tree invariant). Both are enforced here so an edit to
    // one without the other trips CI.
    const src = readFileSync(skillMd, "utf8");
    const fmName = frontmatterField(src, "name");
    const fmDesc = frontmatterField(src, "description");
    expect(fmName).toBe("wego");
    expect(SKILLS[0].id).toBe(fmName);
    expect(SKILLS[0].description).toBe(fmDesc);
  });
});

// Agent Skills caps the frontmatter fields, and each of ours is a single
// unquoted YAML scalar: an edit that overruns a cap is invisible on disk and on
// review, and only shows up wherever the skill is consumed. So the limits are
// pinned here rather than trusted to whoever edits the file next.
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

// The skill is baked into the shipped binary and installed for END USERS
// (`wego skill install`), whose prod/staging binary has no repo, no `.envrc`,
// no local `apps/api`, and a baked API URL. So developer-local workflow
// guidance (direnv / `bun dev` / `localhost:3001`) would be actively wrong
// there — it lives in apps/cli/AGENTS.md, never the skill. This guard enforces
// that boundary mechanically so it can't drift back in via an edit or a bot
// autofix (the rule was previously prose only in AGENTS.md).
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

// The from-source path above proves the `with { type: "file" }` import resolves
// on disk. This proves the leg shipped binaries actually use: `bun build
// --compile` must BAKE SKILL.md into the executable's virtual FS so `skill
// install`/`print` work with no repo present. Cheap (sub-second compile of this
// small CLI — Bun's bundler, not the heavy tsc), so it rides the normal suite.
describe("skill embed in a compiled binary", () => {
  it("bakes SKILL.md into `bun build --compile` output, served detached from source", () => {
    const work = mkdtempSync(join(tmpdir(), "wego-compile-"));
    const bin = join(work, "wego");
    try {
      // `process.execPath` is the bun runtime running this test — invoke its
      // `build` so we don't depend on `bun` being on PATH.
      const build = Bun.spawnSync(
        [
          process.execPath,
          "build",
          "--compile",
          join(cliRoot, "src/index.ts"),
          "--outfile",
          bin,
        ],
        // Compile from the throwaway dir, not the repo: `bun build --compile`
        // drops `.bun-build` intermediates in its CWD, which must never land
        // under apps/cli. The asset import resolves relative to the module, so
        // an absolute entry path keeps CWD irrelevant to resolution.
        { cwd: work, stdout: "pipe", stderr: "pipe" },
      );
      if (!build.success) {
        throw new Error(
          `bun build --compile failed:\n${new TextDecoder().decode(build.stderr)}`,
        );
      }

      // Install from the throwaway dir (no repo on disk) so a pass can only mean
      // the skill was baked into the binary, not read off the filesystem.
      // `--embedded` pins it to the baked copy (never a remote fetch), and
      // `--dir` keeps the write inside the throwaway tree.
      const skillsRoot = join(work, "skills-root");
      const run = Bun.spawnSync(
        [bin, "skill", "install", "--embedded", "--dir", skillsRoot, "-y"],
        { cwd: work, stdout: "pipe", stderr: "pipe" },
      );
      expect(run.exitCode).toBe(0);

      // One leaf, on every install: the skill id.
      const installed = readFileSync(
        join(skillsRoot, "wego", "SKILL.md"),
        "utf8",
      );
      // Nothing rewrites the body any more, so the written file is byte-identical
      // to the on-disk source of truth.
      expect(installed.trimEnd()).toBe(readFileSync(skillMd, "utf8").trimEnd());
      expect(installed).toContain("# Wego CLI");

      // A second install off the same repo-free binary must land on that same
      // leaf rather than minting one from the environment it was invoked in.
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
