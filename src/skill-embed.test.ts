import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyFlavor } from "./skill";
import { readEmbeddedSkill, SKILLS } from "./skill-embed";

const cliRoot = join(import.meta.dir, "..");
const skillMd = join(cliRoot, ".claude/skills/wego/SKILL.md");
const stagingOverlayMd = join(
  cliRoot,
  ".claude/skills/wego/staging-overlay.md",
);

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
    // Anchors from .claude/skills/wego/SKILL.md — proves the embed resolved to
    // the actual skill, not an empty/placeholder file.
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

// The flavor rewrite walks the WHOLE canonical body, frontmatter included, so a
// new frontmatter field is a new surface for it to cross. `skill.test.ts`
// already asserts the install-URL rewrite, but against a SYNTHETIC body, and the
// staging install below already ran without checking the URL it produced. What
// nothing did until now is compose the overlay over the REAL `SKILL.md` and
// re-check the install URL, which is what catches a frontmatter edit breaking
// the staging seam.
describe("the staging overlay over the real SKILL.md", () => {
  const flavored = (): string =>
    applyFlavor(
      readFileSync(skillMd, "utf8"),
      "wegostaging",
      readFileSync(stagingOverlayMd, "utf8"),
    );

  it("still rewrites the install URL after a frontmatter edit", () => {
    const body = flavored();
    expect(body).toContain("https://api.wegostaging.com/install");
    expect(body).not.toContain("api.wego.com/install");
  });

  it("carries compatibility through the rewrite, endpoint included", () => {
    // The field names both the binary and the API host, and `applyFlavor`
    // reaches them by two different passes - `"wego "` and `"api.wego.com"`.
    // Asserting only the first would miss a staging body still pointing at prod.
    const compatibility = frontmatterField(flavored(), "compatibility");
    expect(compatibility).toContain("wegostaging CLI on PATH");
    expect(compatibility).toContain("api.wegostaging.com");
    expect(compatibility).not.toContain("api.wego.com");
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

  // The overlay is composed INTO the installed body, so it reaches the same user.
  it("holds for the staging overlay too", () => {
    const body = readFileSync(stagingOverlayMd, "utf8").toLowerCase();
    const leaked = DEV_ONLY_TOKENS.filter((t) =>
      body.includes(t.toLowerCase()),
    );
    expect(leaked).toEqual([]);
  });

  // Emitted as an unquoted YAML scalar, so a `: ` here breaks the frontmatter.
  it("the real overlay description is safe as an unquoted YAML scalar", () => {
    const overlay = readFileSync(stagingOverlayMd, "utf8");
    const value = overlay.match(/^description:\s*(.+)$/m)?.[1];
    if (!value) throw new Error("staging overlay has no `description:`");
    expect(value).not.toContain(": ");
    expect(value).not.toContain('"');
    expect(value).not.toContain("'");
    expect(value.trimStart()).toBe(value);
    expect(value).not.toMatch(/^[[{&*!|>%@`]/);
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

      // The installed leaf is the flavor; a from-source/unbaked build is `wego`.
      const installed = readFileSync(
        join(skillsRoot, "wego", "SKILL.md"),
        "utf8",
      );
      // `applyFlavor` is a no-op for `wego`, so the written body is byte-identical
      // to the on-disk source of truth.
      expect(installed.trimEnd()).toBe(readFileSync(skillMd, "utf8").trimEnd());
      expect(installed).toContain("# Wego CLI");

      // The overlay is a SECOND baked asset, so a staging install off the same
      // repo-free binary is what proves it was embedded rather than read.
      const stagingRun = Bun.spawnSync(
        [bin, "skill", "install", "--embedded", "--dir", skillsRoot, "-y"],
        {
          cwd: work,
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, WEGO_BUILD_FLAVOR: "wegostaging" },
        },
      );
      expect(stagingRun.exitCode).toBe(0);
      const staging = readFileSync(
        join(skillsRoot, "wegostaging", "SKILL.md"),
        "utf8",
      );
      expect(staging).toContain("name: wegostaging");
      expect(staging).toContain("Nothing here is a production quote");
      expect(staging).not.toContain("{{flavor}}");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 120_000);
});
