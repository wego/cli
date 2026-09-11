/**
 * The plugin read-back, driven against a REAL git repository over `file://`
 * (foundations#101 rung 4b).
 *
 * Same harness as `plugin-publish.test.ts` and for the same reason: every case
 * here is about what git actually does - what a clone of an empty repo
 * contains, which branch `push origin HEAD` resolved to - and none of it
 * survives being asked of a stub.
 *
 * The case that justifies this rung is "the push landed on another branch".
 * `publish-plugin.ts` exits 0 there, so only an independent fetch can tell.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SKILLS } from "../src/skill-embed";
import { cleanupWorkspaces, git, workspaces } from "./plugin-fixtures";
import { resolveGit } from "./plugin-git";
import {
  describeMismatch,
  missingPlanSources,
  pluginPublishPlan,
  redactRemote,
} from "./plugin-publish";

const cliRoot = join(import.meta.dir, "..");
// The SAME call the script makes. Hardcoding `["wego"]` would agree only
// while SKILLS has one entry, and would then under-seed the remote.
const PLAN = pluginPublishPlan(SKILLS.map((s) => s.id));

afterEach(cleanupWorkspaces);

/** A bare repo plus its `file://` URL. `initialBranch` is a knob because the
 *  branch a clone checks out is the subject of one of the cases. */
function bareRepo(initialBranch = "main"): {
  url: string;
  root: string;
  filesOn: (ref: string) => string[];
} {
  const root = mkdtempSync(join(tmpdir(), "wego-verify-remote-"));
  workspaces.push(root);
  const bare = join(root, "skills.git");
  git(root, "init", "--bare", `--initial-branch=${initialBranch}`, bare);
  return {
    url: `file://${bare}`,
    root,
    // What a given ref actually holds, read straight from the bare repo. Lets a
    // test assert the SETUP it claims rather than only the verifier's verdict.
    filesOn: (ref: string) => {
      const r = spawnSync(resolveGit(), ["ls-tree", "-r", "--name-only", ref], {
        cwd: bare,
        encoding: "utf8",
      });
      if (r.status !== 0) return []; // an unborn/absent ref holds nothing
      return (r.stdout ?? "").split("\n").filter(Boolean);
    },
  };
}

/** Commit `files` onto `branch` of the bare repo at `url`. */
function seed(
  url: string,
  root: string,
  files: Record<string, string>,
  branch = "main",
): void {
  const checkout = join(root, `seed-${Math.random().toString(36).slice(2)}`);
  git(root, "clone", url, checkout);
  for (const [path, body] of Object.entries(files)) {
    const full = join(checkout, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
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
  git(checkout, "push", "origin", `HEAD:${branch}`);
  rmSync(checkout, { recursive: true, force: true });
}

/** The plan's three files with their real source bytes - a correct publish. */
function sourceFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { from, to } of PLAN) {
    out[to] = readFileSync(join(cliRoot, from), "utf8");
  }
  return out;
}

/** Run the real verifier against `url`, with the gate satisfied. */
function verify(
  url: string,
  env: Record<string, string> = {},
): { code: number; out: string; err: string } {
  const r = spawnSync(
    process.execPath,
    ["run", join(cliRoot, "scripts/verify-plugin-published.ts")],
    {
      cwd: cliRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        SKILLS_PLUGIN_REPO: url,
        SKILLS_PUBLISH_TOKEN: "file-transport-needs-no-key",
        REQUIRE_PUBLISH: "true",
        ...env,
      },
    },
  );
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

describe("verify-plugin-published against a file:// bare repo", () => {
  it("passes when every published file matches source", () => {
    const remote = bareRepo();
    seed(remote.url, remote.root, sourceFiles());

    const r = verify(remote.url);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`${PLAN.length} file(s)`);
    for (const p of PLAN) expect(r.out).toContain(p.to);
  });

  it("fails and names every file when the repo is empty", () => {
    // A publish that wrote nothing at all still exits 0 today.
    const remote = bareRepo();

    const r = verify(remote.url);
    expect(r.code).toBe(1);
    expect(r.err).toContain("FAILED");
    for (const p of PLAN) expect(r.err).toContain(`${p.to} - MISSING`);
    // Same observable signature as the wrong-branch case, and honestly so: from
    // a clone the two are indistinguishable, and the message says "landed on a
    // ref this clone does not check out" rather than claiming to tell them apart.
    expect(r.err).toContain("EVERY published file is absent");
  });

  it("fails when the push landed on a different branch", () => {
    // THE case this rung exists for. `publish-plugin.ts` ends with
    // `git push origin HEAD`; against an empty remote the branch that resolves
    // to is not guaranteed to be the one a clone checks out.
    const remote = bareRepo("main");
    seed(remote.url, remote.root, sourceFiles(), "master");

    // PROVE THE PREMISE FIRST, or this test cannot tell itself apart from the
    // empty-repo case above: assert the content really is on `master`, and that
    // the ref a clone checks out really is unborn. Without these two lines the
    // scenario would degrade to "the repo is empty" the moment `seed()`'s push
    // stopped working, and the assertions below would still pass.
    expect(remote.filesOn("master").sort()).toEqual(
      PLAN.map((p) => p.to).sort(),
    );
    expect(remote.filesOn("main")).toEqual([]);

    const r = verify(remote.url);
    expect(r.code).toBe(1);
    expect(r.err).toContain("MISSING");
    // Earned, not boilerplate: the hint is printed only when EVERY planned file
    // is absent, so it is false for the tampered and one-missing cases below.
    expect(r.err).toContain("EVERY published file is absent");
  });

  it("fails on a tampered file and locates the first differing byte", () => {
    const files = sourceFiles();
    const skill = PLAN.find((p) => p.to.endsWith("SKILL.md"));
    if (!skill) throw new Error("the plan no longer publishes a SKILL.md");
    files[skill.to] = `${files[skill.to]}\nrm -rf /\n`;

    const remote = bareRepo();
    seed(remote.url, remote.root, files);

    const r = verify(remote.url);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`${skill.to} - differs at byte`);
    // Only the tampered file is named; the others are fine.
    expect(r.err).toContain(`1 of ${PLAN.length}`);
    // One wrong byte is not a branch problem, so the hint must stay silent.
    expect(r.err).not.toContain("EVERY published file is absent");
  });

  it("names only the file that is missing", () => {
    const files = sourceFiles();
    const dropped = PLAN[0].to;
    delete files[dropped];

    const remote = bareRepo();
    seed(remote.url, remote.root, files);

    const r = verify(remote.url);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`${dropped} - MISSING`);
    expect(r.err).toContain(`1 of ${PLAN.length}`);
    // One absent file among present ones is not the all-absent signature.
    expect(r.err).not.toContain("EVERY published file is absent");
  });
});

describe("missingPlanSources", () => {
  it("names every absent source, in plan order, not just the first", () => {
    // Measured before the fix: a missing source made the verifier exit 1 with a
    // raw stack trace, print no report at all, and abort on the FIRST offender.
    // `publish-plugin.ts` had always stat'd its sources up front; the verifier
    // had not, and this predicate is now the one rule both run.
    const present = new Set([PLAN[0].from]);
    const missing = missingPlanSources("/root", PLAN, (path) =>
      present.has(path.replace("/root/", "")),
    );
    expect(missing).toEqual(PLAN.slice(1).map((p) => p.from));
  });

  it("returns nothing when every source is present", () => {
    expect(missingPlanSources("/root", PLAN, () => true)).toEqual([]);
  });
});

describe("the token gate", () => {
  it("skips gracefully with no credential, and clones nothing", () => {
    const remote = bareRepo();
    const r = verify(remote.url, {
      SKILLS_PUBLISH_TOKEN: "",
      REQUIRE_PUBLISH: "",
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("SKILLS_PUBLISH_TOKEN is unset");
  });

  it("hard-fails with no credential when REQUIRE_PUBLISH is true", () => {
    const remote = bareRepo();
    const r = verify(remote.url, { SKILLS_PUBLISH_TOKEN: "" });
    expect(r.code).toBe(1);
    // Exit 1 alone would also be true of an unrelated crash, so name the gate.
    expect(r.err + r.out).toContain("SKILLS_PUBLISH_TOKEN");
  });
});

describe("the path that needs no git", () => {
  // The graceful skip returns before any git command runs. Resolving the binary
  // at module load would quietly make it depend on git being installed - the
  // exact regression that hit `publish-plugin.ts`, so it is pinned here too.
  it("skips gracefully with no git on PATH", () => {
    const stage = mkdtempSync(join(tmpdir(), "wego-verify-nogit-"));
    workspaces.push(stage);
    symlinkSync(process.execPath, join(stage, "bun"));

    const r = spawnSync(
      join(stage, "bun"),
      ["run", join(cliRoot, "scripts/verify-plugin-published.ts")],
      {
        cwd: cliRoot,
        encoding: "utf8",
        env: { PATH: stage, HOME: process.env.HOME ?? "" },
      },
    );
    expect(r.status).toBe(0);
    expect(r.stdout ?? "").toContain("SKILLS_PUBLISH_TOKEN is unset");
  });
});

describe("redactRemote", () => {
  it("masks a password anywhere in a message, not only at the start", () => {
    // The first version was anchored, so it redacted a bare URL and silently
    // did nothing to the same URL inside a sentence - which is where one
    // actually appears, in `git ... failed:` .
    const msg = redactRemote(
      "git clone https://x-access-token:SECRET@github.com/wego/skills.git repo failed",
    );
    expect(msg).not.toContain("SECRET");
    expect(msg).toContain("https://***@github.com/wego/skills.git");
  });

  it("leaves a passwordless remote alone", () => {
    // `ssh://git@host/repo` names an identity, not a secret. Masking it would
    // break the `git clone` line an operator is told to paste - the same
    // objection that keeps the token out of the URL in the first place.
    for (const url of [
      "ssh://git@github.com/wego/skills.git",
      "https://github.com/wego/skills.git",
      "git@github.com:wego/skills.git",
    ]) {
      expect(redactRemote(url)).toBe(url);
    }
  });
});

describe("a clone that fails against a credential-bearing remote", () => {
  it("keeps the credential out of the error", () => {
    // No such repo, so the clone fails and git echoes the remote back. The
    // whole rendered message goes through redaction, not just the parts we
    // wrote - `args` carries the remote verbatim.
    const root = mkdtempSync(join(tmpdir(), "wego-verify-nocred-"));
    workspaces.push(root);
    const r = verify(
      `file://${join(root, "does-not-exist.git")}`.replace(
        "file://",
        "https://x-access-token:SUPERSECRET@127.0.0.1:1/",
      ),
    );

    expect(r.code).not.toBe(0);
    expect(r.err + r.out).not.toContain("SUPERSECRET");
  });
});

describe("describeMismatch", () => {
  it("reports the first differing offset and both lengths", () => {
    const msg = describeMismatch(Buffer.from("abcdef"), Buffer.from("abcXef"));
    expect(msg).toContain("differs at byte 3");
    expect(msg).toContain("source 6 bytes");
    expect(msg).toContain("published 6 bytes");
  });

  it("keeps source and published the right way round when actual is longer", () => {
    // Asymmetric lengths on purpose: a swapped call at the one real callsite
    // would report `source 6 / published 3` here and go unnoticed against two
    // same-length buffers.
    const msg = describeMismatch(Buffer.from("abc"), Buffer.from("abcdef"));
    expect(msg).toContain("differs at byte 3");
    expect(msg).toContain("source 3 bytes");
    expect(msg).toContain("published 6 bytes");
  });

  it("reports the length boundary when one is a prefix of the other", () => {
    // No byte differs inside the overlap, so the offset IS the shorter length -
    // a truncated publish, which a naive first-difference scan would call equal.
    const msg = describeMismatch(Buffer.from("abcdef"), Buffer.from("abc"));
    expect(msg).toContain("differs at byte 3");
    expect(msg).toContain("published 3 bytes");
  });
});
