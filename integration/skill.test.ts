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
  rmSync,
  statSync,
  utimesSync,
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

const digest = (body: string) =>
  new Bun.CryptoHasher("sha256").update(body).digest("hex");

describe("third-review skill regressions", () => {
  const dir = () => join(s.home.dir, ".claude", "skills", "wego");
  const marker = () => join(dir(), ".wego-skill-owner");

  for (const flag of ["--owned-only", "--keep-local-edits"]) {
    it(`refreshes changed references after a digest-only rollback with ${flag}`, async () => {
      await s.run(["skill", "install", "-y"]);
      const old = "# v1.4.1 entry\n";
      writeFileSync(join(dir(), "SKILL.md"), old);
      writeFileSync(marker(), digest(old));
      writeFileSync(
        join(dir(), "references/cli.md"),
        "previous split release reference\n",
      );
      const result = await s.run(["skill", "install", flag, "-y"]);
      expect(result.code).toBe(0);
      expect(result.out).not.toContain("local modifications");
      for (const file of SKILLS[0].files)
        expect(readFileSync(join(dir(), file.path), "utf8")).toBe(
          await file.read(),
        );
      expect(readFileSync(marker(), "utf8")).toContain("file=");
    });
  }

  it("does not touch a markerless directory containing only abandoned temps", async () => {
    mkdirSync(dir(), { recursive: true });
    const child = Bun.spawn([process.execPath, "-e", ""], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await child.exited;
    const temp = join(dir(), `SKILL.md.tmp.${child.pid}`);
    writeFileSync(temp, "mine\n");
    const result = await s.run(["skill", "uninstall", "-y"]);
    expect(result.code).toBe(0);
    expect(readFileSync(temp, "utf8")).toBe("mine\n");
    expect(existsSync(dir())).toBe(true);
  });

  for (const operation of ["install", "uninstall"]) {
    it(`names the differing reference rather than the identical entry on ${operation}`, async () => {
      mkdirSync(join(dir(), "references"), { recursive: true });
      writeFileSync(join(dir(), "SKILL.md"), await SKILLS[0].files[0].read());
      const reference = join(dir(), "references/cli.md");
      writeFileSync(reference, "mine\n");
      const result = await s.run(["skill", operation, "-y"]);
      expect(result.code).toBe(1);
      expect(result.err).toContain(`${reference} exists`);
      expect(result.err).not.toContain(`${join(dir(), "SKILL.md")} exists`);
      expect(readFileSync(reference, "utf8")).toBe("mine\n");
    });
  }

  for (const mode of ["unreadable", "truncated"]) {
    for (const flag of ["--owned-only", "--keep-local-edits"]) {
      it(
        mode === "unreadable"
          ? `names a ${mode} marker on ${flag} and leaves differing files alone`
          : `handles a readable pre-baseline marker on ${flag} like main`,
        async () => {
          if (mode === "unreadable" && process.getuid?.() === 0) return;
          await s.run(["skill", "install", "-y"]);
          const reference = join(dir(), "references/cli.md");
          writeFileSync(reference, "older reference\n");
          if (mode === "unreadable") chmodSync(marker(), 0o000);
          else writeFileSync(marker(), "1234\n");
          const result = await s.run(["skill", "install", flag, "-y"]);
          expect(result.code).toBe(0);
          if (mode === "unreadable") {
            expect(result.out).toContain(`${marker()} could not be read`);
            expect(result.out).toContain("skill install --force");
            expect(result.out).not.toContain("predates the content baseline");
            expect(readFileSync(reference, "utf8")).toBe("older reference\n");
          } else if (flag === "--owned-only") {
            expect(result.out).toContain("predates the content baseline");
            expect(readFileSync(reference, "utf8")).toBe("older reference\n");
          } else {
            expect(result.out).not.toContain("left alone");
            expect(readFileSync(reference, "utf8")).toBe(
              await SKILLS[0].files[1].read(),
            );
            expect(readFileSync(marker(), "utf8")).toStartWith(
              `${digest(await SKILLS[0].files[0].read())}\n`,
            );
          }
          chmodSync(marker(), 0o600);
        },
      );
    }
    it(`restamps a ${mode} marker when all files already match`, async () => {
      if (mode === "unreadable" && process.getuid?.() === 0) return;
      await s.run(["skill", "install", "-y"]);
      if (mode === "unreadable") chmodSync(marker(), 0o000);
      else writeFileSync(marker(), "1234\n");
      const result = await s.run(["skill", "install", "--owned-only", "-y"]);
      expect(result.code).toBe(0);
      expect(result.out).toContain("up to date");
      const installed = readFileSync(marker(), "utf8");
      expect(installed).toStartWith(
        `${digest(await SKILLS[0].files[0].read())}\n`,
      );
      for (const file of SKILLS[0].files)
        expect(installed).toContain(
          `file=${digest(await file.read())} ${file.path}`,
        );
    });
  }

  it("repairs a missing file with the installer when a readable marker has no baseline", async () => {
    await s.run(["skill", "install", "-y"]);
    rmSync(join(dir(), "SKILL.md"));
    writeFileSync(marker(), "1234\n");
    const result = await s.run([
      "skill",
      "install",
      "--keep-local-edits",
      "-y",
    ]);
    expect(result.code).toBe(0);
    for (const file of SKILLS[0].files)
      expect(readFileSync(join(dir(), file.path), "utf8")).toBe(
        await file.read(),
      );
    expect(readFileSync(marker(), "utf8")).toStartWith(
      `${digest(await SKILLS[0].files[0].read())}\n`,
    );
  });

  for (const flag of ["--keep-local-edits", "--owned-only"]) {
    it(`handles an empty pre-baseline marker with an old entry on ${flag}`, async () => {
      mkdirSync(dir(), { recursive: true });
      writeFileSync(join(dir(), "SKILL.md"), "# stale\n");
      writeFileSync(marker(), "");
      const result = await s.run(["skill", "install", "-y", flag]);
      expect(result.code).toBe(0);
      if (flag === "--owned-only") {
        expect(result.out).toContain("predates the content baseline");
        expect(readFileSync(join(dir(), "SKILL.md"), "utf8")).toBe("# stale\n");
        expect(readFileSync(marker(), "utf8")).toBe("");
      } else {
        expect(result.out).not.toContain("left alone");
        for (const file of SKILLS[0].files)
          expect(readFileSync(join(dir(), file.path), "utf8")).toBe(
            await file.read(),
          );
        expect(readFileSync(marker(), "utf8")).toStartWith(
          `${digest(await SKILLS[0].files[0].read())}\n`,
        );
      }
    });
  }

  it("replaces a read-only marker atomically along with the skill files", async () => {
    if (process.getuid?.() === 0) return;
    await s.run(["skill", "install", "-y"]);
    const old = "# old entry\n";
    writeFileSync(join(dir(), "SKILL.md"), old);
    writeFileSync(marker(), digest(old));
    chmodSync(marker(), 0o400);
    const result = await s.run(["skill", "install", "-y"]);
    expect(result.code).toBe(0);
    for (const file of SKILLS[0].files)
      expect(readFileSync(join(dir(), file.path), "utf8")).toBe(
        await file.read(),
      );
    expect(readFileSync(marker(), "utf8")).toContain("file=");
  });

  for (const operation of ["install", "uninstall"]) {
    it(`reclaims old live-pid and invalid-pid temps on ${operation}, keeping fresh live-pid temps`, async () => {
      await s.run(["skill", "install", "-y"]);
      const stale = [
        join(dir(), `SKILL.md.tmp.${process.pid}`),
        join(dir(), ".wego-skill-owner.tmp.999999999999999999999999"),
      ];
      const fresh = join(dir(), `references/cli.md.tmp.${process.pid}`);
      for (const path of [...stale, fresh])
        writeFileSync(path, "interrupted\n");
      const before = new Date(Date.now() - 11 * 60 * 1000);
      utimesSync(stale[0], before, before);
      const result = await s.run(["skill", operation, "-y"]);
      expect(result.code).toBe(0);
      for (const path of stale) expect(existsSync(path)).toBe(false);
      expect(readFileSync(fresh, "utf8")).toBe("interrupted\n");
    });
  }
});

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
