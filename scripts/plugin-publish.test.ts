/**
 * The plugin publisher, driven against a real git repository over `file://`
 * (foundations#101).
 *
 * A bare repo rather than a mock, because these cases are about what git
 * actually does (what a clone of an empty repo contains, what `ls-files`
 * reports, whether a second run commits), and a stub would answer whatever the
 * test wants.
 *
 * `file://` keeps it hermetic: no network, no credential, no `wego/skills`.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cleanupWorkspaces, git, workspaces } from "./plugin-fixtures";
import {
  nonRegularTrackedFiles,
  pluginPublishPlan,
  unexpectedPluginFiles,
} from "./plugin-publish";

const cliRoot = join(import.meta.dir, "..");
const PLAN = pluginPublishPlan(["wego"]);

afterEach(cleanupWorkspaces);

/** Empty unless `seed` writes into the work tree it is handed. */
function bareRepo(seed?: (checkout: string) => void): {
  url: string;
  root: string;
  tracked: () => string[];
  read: (path: string) => string;
  headCount: () => number;
} {
  const root = mkdtempSync(join(tmpdir(), "wego-plugin-remote-"));
  workspaces.push(root);
  const bare = join(root, "skills.git");
  git(root, "init", "--bare", "--initial-branch=main", bare);

  if (seed) {
    const checkout = join(root, "seed");
    git(root, "clone", bare, checkout);
    seed(checkout);
    git(checkout, "add", "-A");
    git(
      checkout,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-m",
      "seed",
    );
    git(checkout, "push", "origin", "HEAD:main");
    rmSync(checkout, { recursive: true, force: true });
  }

  const inspect = () => {
    const c = join(root, `inspect-${Math.random().toString(36).slice(2)}`);
    git(root, "clone", bare, c);
    return c;
  };

  return {
    url: `file://${bare}`,
    root,
    tracked: () => {
      const c = inspect();
      const out = git(c, "ls-files").split("\n").filter(Boolean).sort();
      rmSync(c, { recursive: true, force: true });
      return out;
    },
    read: (path: string) => {
      const c = inspect();
      const body = readFileSync(join(c, path), "utf8");
      rmSync(c, { recursive: true, force: true });
      return body;
    },
    headCount: () => {
      const c = inspect();
      const n = git(c, "rev-list", "--count", "HEAD").trim();
      rmSync(c, { recursive: true, force: true });
      return Number(n);
    },
  };
}

function publish(url: string): { code: number; out: string; err: string } {
  const r = spawnSync(
    process.execPath,
    ["run", join(cliRoot, "scripts/publish-plugin.ts")],
    {
      cwd: cliRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        SKILLS_PLUGIN_REPO: url,
        // `file://` needs no credential; the gate only checks that one is set.
        SKILLS_PUBLISH_TOKEN: "file-transport-needs-no-key",
        REQUIRE_PUBLISH: "true",
      },
    },
  );
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

const EXPECTED = PLAN.map((p) => p.to).sort();

describe("publish-plugin against a file:// bare repo", () => {
  it("case 1 - empty repo: writes the whole plan", () => {
    const remote = bareRepo();
    const r = publish(remote.url);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(remote.tracked()).toEqual(EXPECTED);
    expect(remote.read("plugin.json")).toBe(
      readFileSync(join(cliRoot, "plugin/plugin.json"), "utf8"),
    );
    expect(remote.read("skills/wego/SKILL.md")).toBe(
      readFileSync(join(cliRoot, "skills/wego/SKILL.md"), "utf8"),
    );
  });

  it("case 2 - steady state: a second run makes no commit", () => {
    const remote = bareRepo();
    expect(publish(remote.url).code).toBe(0);
    const after = remote.headCount();

    const second = publish(remote.url);
    expect(second.code).toBe(0);
    expect(second.out).toContain("already up to date");
    // An unchanged source must not produce a commit, or every promote would add
    // an empty one to the repo's history.
    expect(remote.headCount()).toBe(after);
    expect(remote.tracked()).toEqual(EXPECTED);
  });

  it("case 3 - modified tracked file: the publish corrects it", () => {
    const remote = bareRepo((checkout) => {
      const dest = join(checkout, "skills/wego/SKILL.md");
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(
        dest,
        "---\nname: wego\n---\n\nstale body somebody pushed\n",
      );
      writeFileSync(join(checkout, "plugin.json"), "{}\n");
      writeFileSync(join(checkout, "README.md"), "stale\n");
    });

    const r = publish(remote.url);
    expect(r.code).toBe(0);
    expect(remote.read("skills/wego/SKILL.md")).toBe(
      readFileSync(join(cliRoot, "skills/wego/SKILL.md"), "utf8"),
    );
    expect(remote.tracked()).toEqual(EXPECTED);
  });

  it("case 4 - stray file: refuses, names it, and changes nothing", () => {
    const remote = bareRepo((checkout) => {
      writeFileSync(
        join(checkout, "hand-written-note.md"),
        "somebody edited the repo\n",
      );
    });
    const before = remote.headCount();

    const r = publish(remote.url);
    expect(r.code).toBe(1);
    expect(r.err).toContain("REFUSED");
    expect(r.err).toContain("hand-written-note.md");
    expect(r.err).toContain("git rm");
    // The pasteable clone must name its destination directory. Without it the
    // directory is the repo URL's basename, so the `cd skills` that follows
    // only works while SKILLS_PLUGIN_REPO happens to end in `skills.git`.
    expect(r.err).toContain(`git clone '${remote.url}' skills && cd skills`);
    expect(remote.headCount()).toBe(before);
    expect(remote.tracked()).toEqual(["hand-written-note.md"]);
  });
});

describe("a clone that holds something we did not write", () => {
  it("case 5 - a SYMLINK at an expected path is refused, not followed", () => {
    // `git ls-files` lists a symlink like a file, so the pathname predicate
    // alone cannot see it. The copy currently replaces the link rather than
    // writing through it, but that is a property of the copy call, so the mode
    // is checked explicitly.
    const remote = bareRepo((checkout) => {
      mkdirSync(join(checkout, "skills/wego"), { recursive: true });
      symlinkSync("/etc/hosts", join(checkout, "skills/wego/SKILL.md"));
    });
    const before = remote.headCount();

    const r = publish(remote.url);
    expect(r.code).toBe(1);
    expect(r.err).toContain("REFUSED");
    expect(r.err).toContain("skills/wego/SKILL.md");
    expect(remote.headCount()).toBe(before);
  });

  it("escapes an embedded single quote in the suggested command", () => {
    // A path holding a quote is the only case that distinguishes correct POSIX
    // quoting from naive wrapping.
    const remote = bareRepo((checkout) => {
      writeFileSync(join(checkout, "it's-a-stray.md"), "stray\\n");
    });
    const r = publish(remote.url);
    expect(r.code).toBe(1);
    expect(r.err).toContain(String.raw`git rm -- 'it'\''s-a-stray.md'`);
  });

  it("names a stray path safely even when it carries shell metacharacters", () => {
    // The refusal prints a `git rm` line a human is meant to paste. An
    // unquoted path would turn an odd filename into a different command.
    const remote = bareRepo((checkout) => {
      writeFileSync(join(checkout, "odd; touch pwned.md"), "stray\n");
    });
    const r = publish(remote.url);
    expect(r.code).toBe(1);
    expect(r.err).toContain("git rm -- 'odd; touch pwned.md'");
  });
});

describe("the temp clone is always cleaned up", () => {
  // `process.exit()` does not unwind, so an exit inside the work block would
  // skip the `finally` that removes the clone. The no-op path is the common
  // outcome of a repeat promote.
  const strays = () =>
    readdirSync(tmpdir()).filter((n) => n.startsWith("wego-plugin-publish-"));

  it("leaves nothing behind on the no-op path", () => {
    const remote = bareRepo();
    expect(publish(remote.url).code).toBe(0);
    const before = strays();
    expect(publish(remote.url).out).toContain("already up to date");
    expect(strays()).toEqual(before);
  });

  it("leaves nothing behind on the refusal path", () => {
    const remote = bareRepo((checkout) => {
      writeFileSync(join(checkout, "stray.md"), "x\n");
    });
    const before = strays();
    expect(publish(remote.url).code).toBe(1);
    expect(strays()).toEqual(before);
  });
});

describe("the paths that need no git", () => {
  // `--print-plan` and the graceful skip need no remote, no credential and no
  // git. Resolving the git binary at module load would make both exit 1 on a
  // host without git; a staged PATH holding only `bun` catches that.
  const bunOnlyPath = (): string => {
    const stage = mkdtempSync(join(tmpdir(), "wego-plugin-nogit-"));
    workspaces.push(stage);
    symlinkSync(process.execPath, join(stage, "bun"));
    return stage;
  };

  const runWithoutGit = (args: string[], env: Record<string, string> = {}) => {
    const stage = bunOnlyPath();
    const r = spawnSync(
      join(stage, "bun"),
      ["run", join(cliRoot, "scripts/publish-plugin.ts"), ...args],
      {
        cwd: cliRoot,
        encoding: "utf8",
        env: { PATH: stage, HOME: process.env.HOME ?? "", ...env },
      },
    );
    return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
  };

  it("--print-plan works with no git on PATH", () => {
    const r = runWithoutGit(["--print-plan"]);
    expect(r.code).toBe(0);
    expect(r.out.split("\n").filter((l) => l.includes(" -> "))).toHaveLength(
      PLAN.length,
    );
  });

  it("the graceful skip works with no git on PATH", () => {
    const r = runWithoutGit([], {
      SKILLS_PLUGIN_REPO: "file:///nonexistent.git",
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("SKILLS_PUBLISH_TOKEN is unset");
  });
});

describe("nonRegularTrackedFiles", () => {
  it("passes plain blobs and reports symlinks and gitlinks", () => {
    const staged = [
      "100644 aaa 0\tplugin.json",
      "100755 bbb 0\tscript.sh",
      "120000 ccc 0\tskills/wego/SKILL.md",
      "160000 ddd 0\tvendored",
    ].join("\n");
    expect(nonRegularTrackedFiles(staged)).toEqual([
      "skills/wego/SKILL.md",
      "vendored",
    ]);
  });

  it("is quiet on empty input", () => {
    expect(nonRegularTrackedFiles("")).toEqual([]);
  });
});

describe("the token gate", () => {
  it("skips gracefully (exit 0) when the deploy key is unset", () => {
    const remote = bareRepo();
    const { SKILLS_PUBLISH_TOKEN, REQUIRE_PUBLISH, ...clean } = process.env;
    const r = spawnSync(
      process.execPath,
      ["run", join(cliRoot, "scripts/publish-plugin.ts")],
      {
        cwd: cliRoot,
        encoding: "utf8",
        env: { ...clean, SKILLS_PLUGIN_REPO: remote.url },
      },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("SKILLS_PUBLISH_TOKEN is unset");
    expect(remote.tracked()).toEqual([]);
  });
});

describe("unexpectedPluginFiles", () => {
  it("is quiet on an empty repo and on the steady state", () => {
    expect(unexpectedPluginFiles([], PLAN)).toEqual([]);
    expect(unexpectedPluginFiles(EXPECTED, PLAN)).toEqual([]);
  });

  it("reports only the paths the plan does not write", () => {
    // Strays are paths nothing publishes: one at the root, one under `skills/`.
    expect(
      unexpectedPluginFiles(
        [...EXPECTED, "CONTRIBUTING.md", "skills/other/SKILL.md"],
        PLAN,
      ),
    ).toEqual(["CONTRIBUTING.md", "skills/other/SKILL.md"]);
  });
});

describe("pluginPublishPlan", () => {
  it("publishes the manifest, the readme, the licence, and one SKILL.md per skill", () => {
    expect(PLAN).toEqual([
      { from: "plugin/plugin.json", to: "plugin.json" },
      { from: "plugin/README.md", to: "README.md" },
      { from: "plugin/LICENSE", to: "LICENSE" },
      { from: "skills/wego/SKILL.md", to: "skills/wego/SKILL.md" },
    ]);
  });

  it("draws every source from the plugin dir or a skill dir, never the eval corpus", () => {
    // The publish must not sweep up eval fixtures, the persona app, or the
    // staging overlay (#98).
    for (const { from } of PLAN) {
      expect(from).toMatch(/^(plugin\/|skills\/)/);
    }
  });
});
