import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENTS,
  markerRing,
  markerSource,
  parseSkillArgs,
  resolveSkill,
  type SkillDeps,
  skill,
} from "./skill";
import type { SkillEntry } from "./skill-embed";

const BODY =
  "---\nname: wego\ndescription: Drive the Wego funnels.\n---\n\n# Wego CLI\n\nDrive the funnels.\n\n## Operating contract\n\n1. Drive it.\n";

let home: string;
let cwd: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "wego-skill-home-"));
  cwd = await mkdtemp(join(tmpdir(), "wego-skill-cwd-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

/** `confirm` defaults to yes; `body` is a shortcut for the sole skill's
 *  embedded body. */
function makeDeps(overrides: Partial<SkillDeps> & { body?: string } = {}): {
  deps: SkillDeps;
  out: string[];
  err: string[];
  confirmCalls: string[];
  remoteCalls: Array<[string, string]>;
} {
  const { body, ...rest } = overrides;
  const out: string[] = [];
  const err: string[] = [];
  const confirmCalls: string[] = [];
  const remoteCalls: Array<[string, string]> = [];
  const skills: readonly SkillEntry[] = rest.skills ?? [
    {
      id: "wego",
      description: "Drive the Wego funnels.",
      read: () => Promise.resolve(body ?? BODY),
    },
  ];
  const deps: SkillDeps = {
    log: (m) => out.push(m),
    error: (m) => err.push(m),
    skills,
    version: "9.9.9",
    homedir: () => home,
    cwd: () => cwd,
    confirm: (q) => {
      confirmCalls.push(q);
      return Promise.resolve(true);
    },
    ...rest,
  };
  return { deps, out, err, confirmCalls, remoteCalls };
}

const userSkillFile = () => join(home, ".claude", "skills", "wego", "SKILL.md");
const ownerMarker = () =>
  join(home, ".claude", "skills", "wego", ".wego-skill-owner");

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch {
    return false;
  }
}

describe("parseSkillArgs", () => {
  it("defaults: user scope, no agents/yes/force/embedded/keep-local-edits/owned-only", () => {
    expect(parseSkillArgs([])).toEqual({
      scope: "user",
      agents: [],
      yes: false,
      force: false,
      embedded: false,
      // Default OFF: an interactive `wego skill install` still replaces a modified
      // body and prints that it did. Only unattended callers ask to preserve it.
      keepLocalEdits: false,
      // Default OFF: a typed `install` may create a new agent folder. Only the
      // post-update re-install asks to be confined to folders wego already owns.
      ownedOnly: false,
    });
  });

  it("parses --keep-local-edits", () => {
    expect(parseSkillArgs(["--keep-local-edits"]).keepLocalEdits).toBe(true);
  });

  it("parses --owned-only", () => {
    expect(parseSkillArgs(["--owned-only"]).ownedOnly).toBe(true);
  });

  it("parses scope, -y, --force, --dir, -g/--global, --embedded, agents, id", () => {
    expect(parseSkillArgs(["--scope", "project", "-y"])).toMatchObject({
      scope: "project",
      yes: true,
    });
    expect(parseSkillArgs(["--scope=project", "--force"])).toMatchObject({
      scope: "project",
      force: true,
    });
    expect(parseSkillArgs(["--dir", "/tmp/x"]).dir).toBe("/tmp/x");
    expect(parseSkillArgs(["-g"]).scope).toBe("user");
    expect(parseSkillArgs(["--global"]).scope).toBe("user");
    expect(parseSkillArgs(["--embedded"]).embedded).toBe(true);
    expect(parseSkillArgs(["-a", "claude", "--agent", "codex"]).agents).toEqual(
      ["claude", "codex"],
    );
    expect(parseSkillArgs(["--agent=*"]).agents).toEqual(["*"]);
    expect(parseSkillArgs(["wego"]).skillId).toBe("wego");
    expect(parseSkillArgs(["wego", "-y"]).skillId).toBe("wego");
  });

  it("rejects bad scope, unknown flag, unsupported agent, missing value, 2nd positional", () => {
    expect(() => parseSkillArgs(["--scope", "global"])).toThrow(/--scope must/);
    expect(() => parseSkillArgs(["--wat"])).toThrow(/Unknown option/);
    expect(() => parseSkillArgs(["--agent", "emacs"])).toThrow(/not supported/);
    expect(() => parseSkillArgs(["--dir"])).toThrow(/requires a value/);
    expect(() => parseSkillArgs(["--scope"])).toThrow(/requires a value/);
    expect(() => parseSkillArgs(["wego", "extra"])).toThrow(
      /Unexpected argument/,
    );
  });
});

describe("resolveSkill (registry resolution)", () => {
  const two: readonly SkillEntry[] = [
    {
      id: "wego",
      description: "a",
      read: () => Promise.resolve("a"),
    },
    {
      id: "other",
      description: "b",
      read: () => Promise.resolve("b"),
    },
  ];
  const one = [two[0]];

  it("no id + one entry → that entry", () => {
    expect(resolveSkill(one).id).toBe("wego");
  });
  it("explicit id resolves the named entry", () => {
    expect(resolveSkill(two, "other").id).toBe("other");
  });
  it("unknown id throws and names `skill list`", () => {
    expect(() => resolveSkill(two, "nope")).toThrow(/skill list/);
  });
  it("no id + more than one entry is a usage error (synthetic fixture)", () => {
    expect(() => resolveSkill(two)).toThrow(/More than one skill/);
  });
});

describe("skill list (discovery – offline, auth-free)", () => {
  it("prints the sole entry's id + description", async () => {
    const { deps, out } = makeDeps();
    expect(await skill(["list"], deps)).toBe(0);
    expect(out.join("\n")).toContain("wego");
    expect(out.join("\n")).toContain("Drive the Wego funnels.");
  });

  it("--json emits parseable JSON with id + description", async () => {
    const { deps, out } = makeDeps();
    expect(await skill(["list", "--json"], deps)).toBe(0);
    const parsed = JSON.parse(out[0]);
    expect(parsed).toEqual([
      { id: "wego", description: "Drive the Wego funnels." },
    ]);
  });

  it("rejects an unknown option instead of printing a successful list", async () => {
    const { deps, out, err } = makeDeps();
    expect(await skill(["list", "--typo"], deps)).toBe(1);
    expect(out).toEqual([]);
    expect(err.join("\n")).toMatch(/Unknown option: --typo/);
    expect(await skill(["list", "--json", "--typo"], deps)).toBe(1);
  });

  it("the id `list` prints is one `install` accepts", async () => {
    const { deps } = makeDeps();
    expect(await skill(["install", "wego", "-y"], deps)).toBe(0);
    expect(
      await exists(join(home, ".claude", "skills", "wego", "SKILL.md")),
    ).toBe(true);
  });
});

describe("skill install (Part A – id defaulting + registry)", () => {
  it("no id installs the sole skill to ~/.claude/skills/wego + marker", async () => {
    const { deps, out, confirmCalls } = makeDeps();
    expect(await skill(["install"], deps)).toBe(0);
    expect(await readFile(userSkillFile(), "utf8")).toBe(BODY);
    // Ownership is presence-only, so an empty marker from an older binary still
    // reads as ours. The contents are the SHA256 of the body just written (see
    // the local-modifications block below), not a version stamp.
    expect((await readFile(ownerMarker(), "utf8")).split("\n")[0]).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(confirmCalls.length).toBe(1);
    expect(out.join("\n")).toMatch(/Installed wego skill/);
  });

  it("an unknown <skill-id> exits non-zero and names `wego skill list`", async () => {
    const { deps, err } = makeDeps();
    expect(await skill(["install", "ghost", "-y"], deps)).toBe(1);
    expect(err.join("\n")).toMatch(/wego skill list/);
  });

  it("-y skips the confirm prompt", async () => {
    const { deps, confirmCalls } = makeDeps();
    expect(await skill(["install", "-y"], deps)).toBe(0);
    expect(confirmCalls.length).toBe(0);
  });

  it("is idempotent: a second identical install reports up-to-date", async () => {
    const { deps } = makeDeps();
    expect(await skill(["install", "-y"], deps)).toBe(0);
    const second = makeDeps();
    expect(await skill(["install", "-y"], second.deps)).toBe(0);
    expect(second.out.join("\n")).toMatch(/already up to date/);
  });

  it("upgrades a previously wego-installed skill when the body changed", async () => {
    const { deps } = makeDeps();
    await skill(["install", "-y"], deps);
    const upgraded = makeDeps({ body: "# Wego CLI\n\nNEW body.\n" });
    expect(await skill(["install", "-y"], upgraded.deps)).toBe(0);
    expect(await readFile(userSkillFile(), "utf8")).toBe(
      "# Wego CLI\n\nNEW body.\n",
    );
    expect(upgraded.out.join("\n")).toMatch(/Updated wego skill/);
  });

  it("skips (exit 0, no write) when the confirm is declined", async () => {
    const { deps, out } = makeDeps({ confirm: () => Promise.resolve(false) });
    expect(await skill(["install"], deps)).toBe(0);
    expect(out.join("\n")).toMatch(/Skipped/);
    expect(await exists(userSkillFile())).toBe(false);
  });

  it("returns 1 on a bad flag before touching the filesystem", async () => {
    const { deps, err } = makeDeps();
    expect(await skill(["install", "--nope"], deps)).toBe(1);
    expect(err.join("\n")).toMatch(/Unknown option/);
  });
});

describe("skill ownership marker (presence-only + legacy)", () => {
  it("refuses a foreign SKILL.md (no marker) without --force, then overwrites with it", async () => {
    const dir = join(home, ".claude", "skills", "wego");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "hand-authored, not ours\n");

    const { deps, err } = makeDeps();
    expect(await skill(["install", "-y"], deps)).toBe(1);
    expect(err.join("\n")).toMatch(/not installed by wego/);
    expect(await readFile(join(dir, "SKILL.md"), "utf8")).toBe(
      "hand-authored, not ours\n",
    );

    const forced = makeDeps();
    expect(await skill(["install", "-y", "--force"], forced.deps)).toBe(0);
    expect(await readFile(join(dir, "SKILL.md"), "utf8")).toBe(BODY);
  });

  it("honors a legacy .wego-skill-version marker on read (not seen as foreign)", async () => {
    const dir = join(home, ".claude", "skills", "wego");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "old body\n");
    await writeFile(join(dir, ".wego-skill-version"), "0.0.1\n");

    const { deps, out } = makeDeps({ body: "new body\n" });
    expect(await skill(["install", "-y"], deps)).toBe(0);
    expect(out.join("\n")).toMatch(/Updated wego skill/);
    expect(await readFile(join(dir, "SKILL.md"), "utf8")).toBe("new body\n");
  });

  describe("retiring the legacy marker", () => {
    // A refresh watches both names and takes the oldest mtime, so a legacy marker
    // that install never restamps stays stale forever and holds the throttle
    // window open.
    const dir = () => join(home, ".claude", "skills", "wego");
    const legacy = () => join(dir(), ".wego-skill-version");

    async function legacyInstall(body: string): Promise<void> {
      await mkdir(dir(), { recursive: true });
      await writeFile(join(dir(), "SKILL.md"), body);
      await writeFile(legacy(), "0.0.1\n");
    }

    it("removes the legacy marker when writing the current one", async () => {
      await legacyInstall("old body\n");
      expect(
        await skill(["install", "-y"], makeDeps({ body: "new\n" }).deps),
      ).toBe(0);

      expect(await exists(legacy())).toBe(false);
      expect((await readFile(ownerMarker(), "utf8")).split("\n")[0]).toMatch(
        /^[0-9a-f]{64}$/,
      );
    });

    it("removes it on the byte-identical branch too", async () => {
      // The branch that writes no body still restamps the marker, so it must
      // retire the legacy name too, or an already-current legacy dir keeps the
      // stale mtime.
      await legacyInstall(BODY);
      const { deps, out } = makeDeps();
      expect(await skill(["install", "-y"], deps)).toBe(0);

      expect(out.join("\n")).toMatch(/already up to date/);
      expect(await exists(legacy())).toBe(false);
    });

    it("leaves no marker the refresh would see as stale", async () => {
      // Exactly one recognized marker remains, so the oldest mtime cannot come
      // from a file nothing restamps.
      await legacyInstall("old body\n");
      await skill(["install", "-y"], makeDeps({ body: "new\n" }).deps);

      const markers = (await readdir(dir())).filter((f) =>
        [".wego-skill-owner", ".wego-skill-version"].includes(f),
      );
      expect(markers).toEqual([".wego-skill-owner"]);
    });
  });

  it("adopts a marker-less file whose bytes already match canonical (writes the marker)", async () => {
    // The accepted tradeoff: a coincidental byte-match grants ownership, so the
    // next body change upgrades in place instead of being refused as foreign.
    const dir = join(home, ".claude", "skills", "wego");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), BODY); // identical, but no marker

    const first = makeDeps();
    expect(await skill(["install", "-y"], first.deps)).toBe(0);
    expect(first.out.join("\n")).toMatch(/already up to date/);
    expect(await exists(join(dir, ".wego-skill-owner"))).toBe(true); // adopted
    expect(await readFile(join(dir, "SKILL.md"), "utf8")).toBe(BODY); // untouched

    const second = makeDeps({ body: "next body\n" });
    expect(await skill(["install", "-y"], second.deps)).toBe(0);
    expect(second.out.join("\n")).toMatch(/Updated wego skill/);
    expect(await readFile(join(dir, "SKILL.md"), "utf8")).toBe("next body\n");
  });
});

describe("skill install (Part B – remote body, fail-closed fallback)", () => {
  const EMBEDDED =
    "---\nname: wego\ndescription: Baked body.\n---\n\n# Wego CLI\n\nRun wego login.\n\n## Operating contract\n\n1. Drive it.\n";
  const REMOTE =
    "---\nname: wego\ndescription: Published body.\n---\n\n# Wego CLI\n\nRun wego whoami (remote).\n\n## Operating contract\n\n1. Drive it.\n";
  const URL = "https://blob.example/skill/stable";

  it("verifies + writes the fetched canonical body, byte for byte", async () => {
    const remote = makeDeps({
      body: EMBEDDED,
      skillUrl: URL,
      fetchRemoteSkill: (base, id) => {
        expect(base).toBe(URL);
        expect(id).toBe("wego");
        return Promise.resolve(REMOTE);
      },
    });
    expect(await skill(["install", "-y"], remote.deps)).toBe(0);
    const written = await readFile(userSkillFile(), "utf8");
    expect(written).toBe(REMOTE);
    expect(written).toContain("wego whoami (remote)");
  });

  it("falls back to the embedded copy on any fetch failure, exit 0", async () => {
    const fallback = makeDeps({
      body: EMBEDDED,
      skillUrl: URL,
      fetchRemoteSkill: () => Promise.resolve(null), // non-200/timeout/mismatch/…
    });
    expect(await skill(["install", "-y"], fallback.deps)).toBe(0);
    expect(await readFile(userSkillFile(), "utf8")).toBe(EMBEDDED);
  });

  describe("requireRemote (the background refresh's mode)", () => {
    // Unlike the foreground install, a refresh must not fall back to embedded:
    // the installed body can be newer than this binary's embed, so a fallback
    // would silently downgrade it.
    const NEWER = "# newer than this binary's embedded copy\n";

    it("leaves an existing, newer skill untouched when the remote is unverifiable", async () => {
      const { deps } = makeDeps({
        body: EMBEDDED,
        skillUrl: URL,
        fetchRemoteSkill: () => Promise.resolve(null),
        requireRemote: true,
      });
      await mkdir(join(home, ".claude", "skills", "wego"), { recursive: true });
      await writeFile(userSkillFile(), NEWER);
      await writeFile(
        join(home, ".claude", "skills", "wego", ".wego-skill-owner"),
        "",
      );

      expect(await skill(["install", "-y"], deps)).toBe(0);
      expect(await readFile(userSkillFile(), "utf8")).toBe(NEWER);
    });

    it("also declines on a REJECTING resolver, not just a null one", async () => {
      const { deps } = makeDeps({
        body: EMBEDDED,
        skillUrl: URL,
        fetchRemoteSkill: () => Promise.reject(new Error("DNS exploded")),
        requireRemote: true,
      });
      await mkdir(join(home, ".claude", "skills", "wego"), { recursive: true });
      await writeFile(userSkillFile(), NEWER);
      await writeFile(
        join(home, ".claude", "skills", "wego", ".wego-skill-owner"),
        "",
      );

      expect(await skill(["install", "-y"], deps)).toBe(0);
      expect(await readFile(userSkillFile(), "utf8")).toBe(NEWER);
    });

    it("refreshOnly leaves an unowned target alone but still exits 0", async () => {
      // Ownership gates whether the refresh runs, but the target list is a fresh
      // auto-detect, so an agent dir created after the original install would
      // otherwise gain a skill nobody asked for.
      const REMOTE = "# published\n";
      const { deps } = makeDeps({
        body: EMBEDDED,
        skillUrl: URL,
        fetchRemoteSkill: () => Promise.resolve(REMOTE),
        requireRemote: true,
        refreshOnly: true,
      });
      const unowned = join(home, ".claude", "skills", "wego");
      await mkdir(unowned, { recursive: true });

      expect(await skill(["install", "-y"], deps)).toBe(0);
      expect(await exists(join(unowned, "SKILL.md"))).toBe(false);
      expect(await exists(join(unowned, ".wego-skill-owner"))).toBe(false);
    });

    it("refreshOnly still updates a target that IS owned", async () => {
      // Scoping writes must not disable the feature on the dirs it exists for.
      const REMOTE = "# published\n";
      const { deps } = makeDeps({
        body: EMBEDDED,
        skillUrl: URL,
        fetchRemoteSkill: () => Promise.resolve(REMOTE),
        requireRemote: true,
        refreshOnly: true,
      });
      const owned = join(home, ".claude", "skills", "wego");
      await mkdir(owned, { recursive: true });
      const stale = "# stale\n";
      await writeFile(join(owned, "SKILL.md"), stale);
      // A real baseline, so this tests only the `refreshOnly` scoping. An empty
      // (pre-baseline) marker is a separate case the refresh preserves; see
      // "leaves a pre-baseline install alone" below.
      const h = new Bun.CryptoHasher("sha256");
      h.update(stale);
      await writeFile(join(owned, ".wego-skill-owner"), h.digest("hex"));

      expect(await skill(["install", "-y"], deps)).toBe(0);
      expect(await readFile(join(owned, "SKILL.md"), "utf8")).toBe(REMOTE);
    });

    it("still writes the verified remote body when the channel IS reachable", async () => {
      // Declining must be scoped to failure, or the refresh would never update
      // anything.
      const REMOTE = "# freshly published\n";
      const { deps } = makeDeps({
        body: EMBEDDED,
        skillUrl: URL,
        fetchRemoteSkill: () => Promise.resolve(REMOTE),
        requireRemote: true,
      });
      expect(await skill(["install", "-y"], deps)).toBe(0);
      expect(await readFile(userSkillFile(), "utf8")).toBe(REMOTE);
    });
  });

  describe("local modifications (the silent-overwrite guard)", () => {
    // Ownership answers "may we write here", not "are the bytes there ours to
    // discard". The silent refresh leaves no diff, backup or log line, so the
    // marker records the SHA256 of what wego last wrote to answer the second.
    const REMOTE = "# freshly published\n";
    const refreshDeps = () =>
      makeDeps({
        body: EMBEDDED,
        skillUrl: URL,
        fetchRemoteSkill: () => Promise.resolve(REMOTE),
        requireRemote: true,
        refreshOnly: true,
      });

    /** `wrote` is the baseline the marker records; it defaults to `body`, i.e.
     *  untouched since wego wrote it. */
    async function ownedDir(body: string, wrote = body): Promise<string> {
      const dir = join(home, ".claude", "skills", "wego");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), body);
      const h = new Bun.CryptoHasher("sha256");
      h.update(wrote);
      await writeFile(join(dir, ".wego-skill-owner"), h.digest("hex"));
      return dir;
    }

    it("the background refresh does NOT overwrite a locally modified body", async () => {
      const EDITED = "# published\n\nMy team's extra house rule.\n";
      await ownedDir(EDITED, "# published\n");
      const { deps } = refreshDeps();

      expect(await skill(["install", "-y"], deps)).toBe(0);
      expect(await readFile(userSkillFile(), "utf8")).toBe(EDITED);
    });

    it("says so on stdout rather than skipping mutely", async () => {
      // Exit 0 with no output would be indistinguishable from "refreshed".
      await ownedDir("# edited\n", "# published\n");
      const { deps, out } = refreshDeps();
      await skill(["install", "-y"], deps);
      expect(out.join("")).toContain("local modifications");
    });

    it("DOES refresh when the body still matches what wego wrote", async () => {
      // The guard must be scoped to real edits, or no install would ever be
      // refreshed.
      await ownedDir("# stale but pristine\n");
      const { deps } = refreshDeps();

      expect(await skill(["install", "-y"], deps)).toBe(0);
      expect(await readFile(userSkillFile(), "utf8")).toBe(REMOTE);
    });

    it("leaves a pre-baseline install alone (contentless/legacy marker)", async () => {
      // A marker from before the baseline is empty, so "modified" is unknowable.
      // The silent path must not resolve that by writing: the body may be hand
      // edited, and an overwrite would leave no diff, backup or log line.
      const dir = join(home, ".claude", "skills", "wego");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), "# hand edited\n");
      await writeFile(join(dir, ".wego-skill-owner"), ""); // pre-baseline
      const { deps } = refreshDeps();

      expect(await skill(["install", "-y"], deps)).toBe(0);
      expect(await readFile(userSkillFile(), "utf8")).toBe("# hand edited\n");
    });

    it("the INSTALLER rebaselines a pre-baseline install, so preserving it cannot be permanent", async () => {
      // Nothing else ever writes a baseline for a pre-marker install, so if the
      // installer (`--keep-local-edits` without refreshOnly) preserved it too,
      // the refresh would skip that machine forever.
      const dir = join(home, ".claude", "skills", "wego");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), "# stale\n");
      await writeFile(join(dir, ".wego-skill-owner"), ""); // pre-baseline
      const { deps } = makeDeps({
        body: EMBEDDED,
        skillUrl: URL,
        fetchRemoteSkill: () => Promise.resolve(REMOTE),
      });

      expect(await skill(["install", "-y", "--keep-local-edits"], deps)).toBe(
        0,
      );
      expect(await readFile(userSkillFile(), "utf8")).toBe(REMOTE);
      const h = new Bun.CryptoHasher("sha256");
      h.update(REMOTE);
      expect(
        (await readFile(join(dir, ".wego-skill-owner"), "utf8")).split("\n")[0],
      ).toBe(h.digest("hex"));
    });

    it("--force lets the refresh reclaim a pre-baseline dir", async () => {
      const dir = join(home, ".claude", "skills", "wego");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), "# hand edited\n");
      await writeFile(join(dir, ".wego-skill-owner"), ""); // pre-baseline
      const { deps } = refreshDeps();

      expect(await skill(["install", "-y", "--force"], deps)).toBe(0);
      expect(await readFile(userSkillFile(), "utf8")).toBe(REMOTE);
    });

    it("--force lets the refresh reclaim a modified dir", async () => {
      await ownedDir("# edited\n", "# published\n");
      const { deps } = refreshDeps();

      expect(await skill(["install", "-y", "--force"], deps)).toBe(0);
      expect(await readFile(userSkillFile(), "utf8")).toBe(REMOTE);
    });

    it("a FOREGROUND install still overwrites an edit – but reports it", async () => {
      // A user who typed the command asked for the overwrite, but it must not
      // happen silently.
      await ownedDir("# edited\n", "# published\n");
      const { deps, out } = makeDeps({
        body: EMBEDDED,
        skillUrl: URL,
        fetchRemoteSkill: () => Promise.resolve(REMOTE),
      });

      expect(await skill(["install", "-y"], deps)).toBe(0);
      expect(await readFile(userSkillFile(), "utf8")).toBe(REMOTE);
      expect(out.join("")).toContain("Replaced a locally modified copy.");
    });

    it("--keep-local-edits preserves an edit on the FOREGROUND path", async () => {
      // "Foreground" is not "attended": the curl | bash installer runs this path
      // with nobody reading stdout on every re-run, and uses this flag to keep an
      // operator's edit without refreshOnly's never-create rule.
      const EDITED = "# published\n\nMy team's extra house rule.\n";
      await ownedDir(EDITED, "# published\n");
      const { deps, out } = makeDeps({
        body: EMBEDDED,
        skillUrl: URL,
        fetchRemoteSkill: () => Promise.resolve(REMOTE),
      });

      expect(await skill(["install", "-y", "--keep-local-edits"], deps)).toBe(
        0,
      );
      expect(await readFile(userSkillFile(), "utf8")).toBe(EDITED);
      expect(out.join("")).toContain("local modifications");
    });

    it("--keep-local-edits still installs where there is nothing to preserve", async () => {
      // It must not act like refreshOnly: the installer's first run on a clean
      // machine has to create the skill.
      const { deps } = makeDeps({
        body: EMBEDDED,
        skillUrl: URL,
        fetchRemoteSkill: () => Promise.resolve(REMOTE),
      });

      expect(await skill(["install", "-y", "--keep-local-edits"], deps)).toBe(
        0,
      );
      expect(await readFile(userSkillFile(), "utf8")).toBe(REMOTE);
    });

    it("--force overrides --keep-local-edits", async () => {
      await ownedDir("# edited\n", "# published\n");
      const { deps } = makeDeps({
        body: EMBEDDED,
        skillUrl: URL,
        fetchRemoteSkill: () => Promise.resolve(REMOTE),
      });

      expect(
        await skill(["install", "-y", "--keep-local-edits", "--force"], deps),
      ).toBe(0);
      expect(await readFile(userSkillFile(), "utf8")).toBe(REMOTE);
    });

    it("an UNATTENDED re-run does not downgrade to embedded when the remote fails", async () => {
      // Not an edit (the body matches its baseline), but an earlier refresh may
      // have installed a published body newer than this binary's embed, so
      // writing the embedded copy over it would be an unseen downgrade.
      const NEWER = "# published later than this binary\n";
      await ownedDir(NEWER);
      const { deps } = makeDeps({
        body: EMBEDDED,
        skillUrl: URL,
        fetchRemoteSkill: () => Promise.resolve(null), // channel down
      });

      expect(await skill(["install", "-y", "--keep-local-edits"], deps)).toBe(
        0,
      );
      expect(await readFile(userSkillFile(), "utf8")).toBe(NEWER);
    });

    it("still CREATES from the embedded copy when the remote fails", async () => {
      // Guarding the downgrade must not leave a clean machine with a down channel
      // without any skill.
      const { deps } = makeDeps({
        body: EMBEDDED,
        skillUrl: URL,
        fetchRemoteSkill: () => Promise.resolve(null),
      });

      expect(await skill(["install", "-y", "--keep-local-edits"], deps)).toBe(
        0,
      );
      expect(await readFile(userSkillFile(), "utf8")).toBe(EMBEDDED);
    });

    it("an ATTENDED install still takes the embedded fallback", async () => {
      // A typed install never fails on a down remote.
      await ownedDir("# whatever was there\n");
      const { deps } = makeDeps({
        body: EMBEDDED,
        skillUrl: URL,
        fetchRemoteSkill: () => Promise.resolve(null),
      });

      expect(await skill(["install", "-y"], deps)).toBe(0);
      expect(await readFile(userSkillFile(), "utf8")).toBe(EMBEDDED);
    });

    it("records the written body's digest in the marker", async () => {
      // Every check above depends on this baseline. Without it they would all
      // degrade to "unknown" and still pass.
      const { deps } = makeDeps({
        body: EMBEDDED,
        skillUrl: URL,
        fetchRemoteSkill: () => Promise.resolve(REMOTE),
      });
      await skill(["install", "-y"], deps);

      const h = new Bun.CryptoHasher("sha256");
      h.update(REMOTE);
      const marker = await readFile(ownerMarker(), "utf8");
      expect(marker.split("\n")[0]).toBe(h.digest("hex"));
      // A fixture that injects `skillUrl` with no ring cannot name a channel, so
      // the source reads `remote`.
      expect(markerSource(marker)).toBe("remote");
    });

    it("leaves no temp file behind (the write is temp + rename)", async () => {
      const { deps } = makeDeps({ body: EMBEDDED });
      await skill(["install", "-y"], deps);
      const dir = join(home, ".claude", "skills", "wego");
      expect((await readdir(dir)).filter((f) => f.includes(".tmp."))).toEqual(
        [],
      );
    });

    it("refuses a pre-existing temp path instead of writing through it", async () => {
      // The pid-based temp name is guessable, and a plain write would follow a
      // planted symlink. A plain file exercises the same exclusive-create refusal
      // without needing a symlink target.
      const dir = join(home, ".claude", "skills", "wego");
      await mkdir(dir, { recursive: true });
      const planted = join(dir, `SKILL.md.tmp.${process.pid}`);
      await writeFile(planted, "squatted\n");

      const { deps, err } = makeDeps({ body: EMBEDDED });
      expect(await skill(["install", "-y"], deps)).toBe(1);
      expect(err.join("\n")).toMatch(/Failed to install to/);
      expect(await exists(join(dir, "SKILL.md"))).toBe(false);
    });

    it("fails loudly rather than silently replacing an unreadable SKILL.md", async () => {
      // `rename` needs only the directory writable, so treating an unreadable
      // file as absent would skip every overwrite protection and replace it.
      const dir = join(home, ".claude", "skills", "wego");
      await mkdir(dir, { recursive: true });
      const file = join(dir, "SKILL.md");
      await writeFile(file, "# unreadable\n");
      await chmod(file, 0o000);

      try {
        const { deps, err } = makeDeps({ body: EMBEDDED });
        expect(await skill(["install", "-y"], deps)).toBe(1);
        expect(err.join("\n")).toMatch(/Failed to install to/);
      } finally {
        // Restore before the harness's afterEach rm()'s the tmpdir tree.
        await chmod(file, 0o600).catch(() => {});
      }
      expect(await readFile(file, "utf8")).toBe("# unreadable\n");
    });
  });

  it("reports a filesystem write failure as a per-target failure", async () => {
    // A directory where SKILL.md belongs makes the rename fail for real, without
    // mocking fs.
    const { deps, err } = makeDeps({ body: EMBEDDED });
    await mkdir(join(home, ".claude", "skills", "wego", "SKILL.md"), {
      recursive: true,
    });

    expect(await skill(["install", "-y"], deps)).toBe(1);
    expect(err.join("")).toContain("Failed to install to");
  });

  it("falls back to embedded when the resolver REJECTS, not just resolves null", async () => {
    // "Install never fails on a down remote" must not depend on the resolver
    // returning null rather than throwing.
    const { deps } = makeDeps({
      body: EMBEDDED,
      skillUrl: URL,
      fetchRemoteSkill: () => Promise.reject(new Error("DNS exploded")),
    });
    expect(await skill(["install", "-y"], deps)).toBe(0);
    expect(await readFile(userSkillFile(), "utf8")).toBe(EMBEDDED);
  });

  it("--embedded performs no fetch", async () => {
    let called = false;
    const { deps } = makeDeps({
      body: EMBEDDED,
      skillUrl: URL,
      fetchRemoteSkill: () => {
        called = true;
        return Promise.resolve(REMOTE);
      },
    });
    expect(await skill(["install", "-y", "--embedded"], deps)).toBe(0);
    expect(called).toBe(false);
    expect(await readFile(userSkillFile(), "utf8")).toBe(EMBEDDED);
  });

  it("a from-source run (no baked URL) uses embedded and never fetches", async () => {
    let called = false;
    const { deps } = makeDeps({
      body: EMBEDDED,
      skillUrl: undefined,
      fetchRemoteSkill: () => {
        called = true;
        return Promise.resolve(REMOTE);
      },
    });
    expect(await skill(["install", "-y"], deps)).toBe(0);
    expect(called).toBe(false);
    expect(await readFile(userSkillFile(), "utf8")).toBe(EMBEDDED);
  });

  it("content-based idempotency makes a re-run a no-op", async () => {
    const mk = () =>
      makeDeps({
        body: EMBEDDED,
        skillUrl: URL,
        fetchRemoteSkill: () => Promise.resolve(REMOTE),
      });
    expect(await skill(["install", "-y"], mk().deps)).toBe(0);
    const second = mk();
    expect(await skill(["install", "-y"], second.deps)).toBe(0);
    expect(second.out.join("\n")).toMatch(/already up to date/);
  });

  it("path performs no remote fetch even when a skill URL is baked", async () => {
    let called = false;
    const { deps, out } = makeDeps({
      body: EMBEDDED,
      skillUrl: URL,
      fetchRemoteSkill: () => {
        called = true;
        return Promise.resolve(REMOTE);
      },
    });
    // `path` resolves a skill but must never touch the network.
    expect(await skill(["path"], deps)).toBe(0);
    expect(called).toBe(false);
    expect(out[0]).toBe(userSkillFile());
  });
});

describe("skill install (Part C – multi-agent path table)", () => {
  it("the vendored table resolves each (agent, scope) to the documented dir", () => {
    expect(AGENTS.claude).toEqual({
      project: ".claude/skills",
      global: ".claude/skills",
    });
    expect(AGENTS.codex.project).toBe(".agents/skills");
    expect(AGENTS.codex.global).toBe(".codex/skills");
    expect(AGENTS.cursor.global).toBe(".cursor/skills");
  });

  it("a project install writes BOTH .claude/skills/<id> and .agents/skills/<id>", async () => {
    const { deps } = makeDeps();
    expect(await skill(["install", "--scope", "project", "-y"], deps)).toBe(0);
    expect(
      await exists(join(cwd, ".claude", "skills", "wego", "SKILL.md")),
    ).toBe(true);
    expect(
      await exists(join(cwd, ".agents", "skills", "wego", "SKILL.md")),
    ).toBe(true);
  });

  it("auto-detect (global) skips agents whose home config dir is absent", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    await mkdir(join(home, ".cursor"), { recursive: true });
    const { deps } = makeDeps();
    expect(await skill(["install", "-y"], deps)).toBe(0);
    expect(
      await exists(join(home, ".claude", "skills", "wego", "SKILL.md")),
    ).toBe(true);
    expect(
      await exists(join(home, ".cursor", "skills", "wego", "SKILL.md")),
    ).toBe(true);
    expect(
      await exists(join(home, ".codex", "skills", "wego", "SKILL.md")),
    ).toBe(false);
  });

  it("--agent selects a specific agent; -g targets its global dir", async () => {
    const { deps } = makeDeps();
    expect(await skill(["install", "-a", "cursor", "-g", "-y"], deps)).toBe(0);
    expect(
      await exists(join(home, ".cursor", "skills", "wego", "SKILL.md")),
    ).toBe(true);
    expect(await exists(userSkillFile())).toBe(false); // claude untouched
  });

  it("--agent '*' targets every agent in the table", async () => {
    const { deps } = makeDeps();
    expect(await skill(["install", "--agent", "*", "-g", "-y"], deps)).toBe(0);
    expect(
      await exists(join(home, ".claude", "skills", "wego", "SKILL.md")),
    ).toBe(true);
    expect(
      await exists(join(home, ".codex", "skills", "wego", "SKILL.md")),
    ).toBe(true);
    expect(
      await exists(join(home, ".cursor", "skills", "wego", "SKILL.md")),
    ).toBe(true);
  });

  it("is best-effort: a foreign target is skipped, the rest install, exit 0", async () => {
    const claudeDir = join(cwd, ".claude", "skills", "wego");
    await mkdir(claudeDir, { recursive: true });
    await writeFile(join(claudeDir, "SKILL.md"), "hand-authored\n");

    const { deps, out, err } = makeDeps();
    expect(await skill(["install", "--scope", "project", "-y"], deps)).toBe(0);
    expect(err.join("\n")).toMatch(/not installed by wego/);
    expect(await readFile(join(claudeDir, "SKILL.md"), "utf8")).toBe(
      "hand-authored\n",
    );
    expect(
      await exists(join(cwd, ".agents", "skills", "wego", "SKILL.md")),
    ).toBe(true);
    expect(out.join("\n")).toMatch(/1\/2 target\(s\) succeeded/);
  });

  it("project uninstall mirrors project install – removes BOTH .claude and .agents", async () => {
    const install = makeDeps();
    expect(
      await skill(["install", "--scope", "project", "-y"], install.deps),
    ).toBe(0);
    expect(
      await exists(join(cwd, ".claude", "skills", "wego", "SKILL.md")),
    ).toBe(true);
    expect(
      await exists(join(cwd, ".agents", "skills", "wego", "SKILL.md")),
    ).toBe(true);

    const remove = makeDeps();
    expect(await skill(["uninstall", "--scope", "project"], remove.deps)).toBe(
      0,
    );
    expect(
      await exists(join(cwd, ".claude", "skills", "wego", "SKILL.md")),
    ).toBe(false);
    expect(
      await exists(join(cwd, ".agents", "skills", "wego", "SKILL.md")),
    ).toBe(false);
  });

  it("exits non-zero only when EVERY target failed", async () => {
    for (const root of [".claude", ".agents"]) {
      const dir = join(cwd, root, "skills", "wego");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), "hand-authored\n");
    }
    const { deps, out } = makeDeps();
    expect(await skill(["install", "--scope", "project", "-y"], deps)).toBe(1);
    expect(out.join("\n")).toMatch(/0\/2 target\(s\) succeeded/);
  });
});

describe("skill path / uninstall / dispatch", () => {
  for (const help of ["--help", "-h", "help"]) {
    it(`skill ${help}: prints usage to stdout, exit 0, empty stderr`, async () => {
      const { deps, out, err } = makeDeps();
      expect(await skill([help], deps)).toBe(0);
      expect(out.join("\n")).toMatch(
        /^Usage: wego skill <list\|install\|path\|uninstall>/,
      );
      expect(err.length).toBe(0);
    });
  }

  it("path prints the target file without writing anything", async () => {
    const { deps, out } = makeDeps();
    expect(await skill(["path"], deps)).toBe(0);
    expect(out[0]).toBe(userSkillFile());
    expect(await exists(userSkillFile())).toBe(false);
  });

  it("path reports where the skill ACTUALLY is on a non-Claude machine", async () => {
    // The API's agent-onboarding doc tells an agent to read this path, so naming
    // a Claude path that does not exist would make onboarding fail silently.
    await mkdir(join(home, ".codex"), { recursive: true });
    const installed = makeDeps();
    expect(await skill(["install", "-y"], installed.deps)).toBe(0);
    const codexFile = join(home, ".codex", "skills", "wego", "SKILL.md");
    expect(await exists(codexFile)).toBe(true);
    expect(await exists(userSkillFile())).toBe(false); // no ~/.claude here

    const { deps, out } = makeDeps();
    expect(await skill(["path"], deps)).toBe(0);
    expect(out).toContain(codexFile);
    expect(out).not.toContain(userSkillFile());
  });

  it("path ignores a FOREIGN SKILL.md in a detected dir", async () => {
    // Onboarding tells the agent to read this path, so reporting someone else's
    // file would load unrelated instructions while looking like it worked.
    await mkdir(join(home, ".codex"), { recursive: true });
    const { deps } = makeDeps();
    await skill(["install", "-y"], deps); // Codex-only home ⇒ lands in .codex

    const foreign = join(home, ".claude", "skills", "wego");
    await mkdir(foreign, { recursive: true });
    await writeFile(join(foreign, "SKILL.md"), "# someone else's skill\n");

    const { deps: pathDeps, out } = makeDeps();
    expect(await skill(["path"], pathDeps)).toBe(0);
    expect(out).toEqual([join(home, ".codex", "skills", "wego", "SKILL.md")]);
  });

  it("path reports NOTHING when only a foreign file occupies the location", async () => {
    // With no owned copy, the fallback must not name the foreign file either:
    // onboarding reads what this prints.
    const dir = join(home, ".claude", "skills", "wego");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "# not ours\n"); // no marker

    const { deps, out, err } = makeDeps();
    expect(await skill(["path"], deps)).toBe(0);
    expect(out).toEqual([]);
    expect(err.join("")).toContain("not installed by wego");
  });

  it("path keeps one deterministic answer when nothing is installed", async () => {
    // Pre-install "where would it land": one conservative target rather than
    // every detected agent's hypothetical dir.
    await mkdir(join(home, ".codex"), { recursive: true });
    const { deps, out } = makeDeps();
    expect(await skill(["path"], deps)).toBe(0);
    expect(out).toEqual([userSkillFile()]);
  });

  it("uninstall removes an installed skill, and no-ops when absent", async () => {
    const { deps, out } = makeDeps();
    expect(await skill(["uninstall"], deps)).toBe(0);
    expect(out.join("\n")).toMatch(/No wego skill installed/);

    const installed = makeDeps();
    await skill(["install", "-y"], installed.deps);
    const removed = makeDeps();
    expect(await skill(["uninstall"], removed.deps)).toBe(0);
    expect(removed.out.join("\n")).toMatch(/Removed wego skill/);
    expect(await exists(userSkillFile())).toBe(false);
  });

  it("uninstall refuses a foreign skill dir without --force, removes with it", async () => {
    const dir = join(home, ".claude", "skills", "wego");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "hand-authored, not ours\n");

    const { deps, err } = makeDeps();
    expect(await skill(["uninstall"], deps)).toBe(1);
    expect(err.join("\n")).toMatch(/not installed by wego/);
    expect(await readFile(join(dir, "SKILL.md"), "utf8")).toBe(
      "hand-authored, not ours\n",
    );

    const forced = makeDeps();
    expect(await skill(["uninstall", "--force"], forced.deps)).toBe(0);
    expect(await exists(join(dir, "SKILL.md"))).toBe(false);
  });

  it("uninstall preserves foreign files adopted by a --force install", async () => {
    const dir = join(home, ".claude", "skills", "wego");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "hand-authored, not ours\n");
    await writeFile(join(dir, "helper.md"), "user's own file\n");

    const adopted = makeDeps();
    expect(await skill(["install", "-y", "--force"], adopted.deps)).toBe(0);

    const removed = makeDeps();
    expect(await skill(["uninstall"], removed.deps)).toBe(0);
    expect(removed.out.join("\n")).toMatch(/left files wego did not create/);
    expect(await exists(join(dir, "SKILL.md"))).toBe(false);
    expect(await exists(join(dir, ".wego-skill-owner"))).toBe(false);
    expect(await readFile(join(dir, "helper.md"), "utf8")).toBe(
      "user's own file\n",
    );
  });

  it("errors on a missing/unknown sub-command", async () => {
    const missing = makeDeps();
    expect(await skill([], missing.deps)).toBe(1);
    expect(missing.err.join("\n")).toMatch(/Usage:/);

    const unknown = makeDeps();
    expect(await skill(["frobnicate"], unknown.deps)).toBe(1);
    expect(unknown.err.join("\n")).toMatch(/Unknown skill sub-command/);
  });
});

describe("markerRing", () => {
  const DIGEST = "a".repeat(64);

  it("reads the ring a ring-stamped marker names", () => {
    expect(markerRing(`${DIGEST}\nring=edge\n`)).toBe("edge");
  });

  it("names no ring for a pre-ring marker", () => {
    expect(markerRing(DIGEST)).toBeNull();
    expect(markerRing(null)).toBeNull();
  });

  it("treats an empty or whitespace ring as none, never as a ring named ''", () => {
    expect(markerRing(`${DIGEST}\nring=\n`)).toBeNull();
    expect(markerRing(`${DIGEST}\nring=   \n`)).toBeNull();
  });

  it("is not confused by a trailing newline or CRLF", () => {
    expect(markerRing(`${DIGEST}\nring=stable`)).toBe("stable");
    expect(markerRing(`${DIGEST}\r\nring=stable\r\n`)).toBe("stable");
  });
});

describe("the ring stamp and the edit baseline share one marker file", () => {
  // Matching the digest against the whole file would read a ring-stamped marker
  // as "no baseline" and silently disable local-edit detection.
  it("a ring-stamped install still detects a later local edit", async () => {
    const { deps } = makeDeps({ ring: "edge" });
    expect(await skill(["install", "-y"], deps)).toBe(0);

    const marker = await readFile(ownerMarker(), "utf8");
    expect(markerRing(marker)).toBe("edge");
    expect(marker.split("\n")[0]).toMatch(/^[0-9a-f]{64}$/);

    // Preserving the edit depends on the baseline, so it only works if the
    // digest survived the ring line.
    const edited = `${await readFile(userSkillFile(), "utf8")}\nhouse rule\n`;
    await writeFile(userSkillFile(), edited);
    const second = makeDeps({ ring: "edge" });
    expect(
      await skill(["install", "-y", "--keep-local-edits"], second.deps),
    ).toBe(0);
    expect(await readFile(userSkillFile(), "utf8")).toBe(edited);
    expect(second.out.join("")).toContain("local modifications");
  });

  it("keeps the digest on the FIRST line whatever else the marker grows", async () => {
    // The marker is a digest followed by optional `ring=` and `source=` lines.
    // Every baseline reader takes line one, so that is the invariant to pin.
    const { deps } = makeDeps();
    expect(await skill(["install", "-y"], deps)).toBe(0);
    const marker = await readFile(ownerMarker(), "utf8");
    expect(marker.split("\n")[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(markerRing(marker)).toBeNull();
  });

  it("records WHERE the body came from, separately from who owns the dir", async () => {
    // Source and ring are different questions, and the marker answers both.
    const embedded = makeDeps({ ring: "stable" });
    expect(await skill(["install", "-y"], embedded.deps)).toBe(0);
    const marker = await readFile(ownerMarker(), "utf8");
    expect(markerRing(marker)).toBe("stable");
    // No remote in this fixture, so the body is embedded even though a `stable`
    // install owns the dir.
    expect(markerSource(marker)).toBe("embedded");
  });
});

describe("skill install --owned-only with NO channel configured (the shipped wiring)", () => {
  // The post-update refresh: `update` spawns the new binary's
  // `skill install --owned-only -y`, and `index.ts` supplies neither `skillUrl`
  // nor `fetchRemoteSkill`. The tests above all inject a channel, so this covers
  // the wiring the binary ships with, where `verified` is always false.
  const STALE = "# stale\n";
  const FRESH = "# this binary's embed\n";

  /** `wrote` is the baseline the marker records; it defaults to `body`, i.e.
   *  untouched since wego wrote it. */
  async function ownedDir(body: string, wrote = body): Promise<string> {
    const dir = join(home, ".claude", "skills", "wego");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), body);
    const h = new Bun.CryptoHasher("sha256");
    h.update(wrote);
    await writeFile(join(dir, ".wego-skill-owner"), h.digest("hex"));
    return dir;
  }

  it("refreshes a stale, pristine body to this binary's embed", async () => {
    await ownedDir(STALE);
    const { deps } = makeDeps({ body: FRESH });

    expect(await skill(["install", "--owned-only", "-y"], deps)).toBe(0);
    expect(await readFile(userSkillFile(), "utf8")).toBe(FRESH);
  });

  it("says it updated rather than declining to verify", async () => {
    await ownedDir(STALE);
    const { deps, out } = makeDeps({ body: FRESH });

    await skill(["install", "--owned-only", "-y"], deps);
    expect(out.join("\n")).toMatch(/Updated wego skill/);
    expect(out.join("\n")).not.toMatch(/could not verify/);
  });

  it("still leaves a locally modified body alone (rule 1 is unaffected)", async () => {
    const EDITED = "# stale\n\nMy team's extra house rule.\n";
    await ownedDir(EDITED, STALE);
    const { deps, out } = makeDeps({ body: FRESH });

    expect(await skill(["install", "--owned-only", "-y"], deps)).toBe(0);
    expect(await readFile(userSkillFile(), "utf8")).toBe(EDITED);
    expect(out.join("\n")).toMatch(/local modifications/);
  });

  it("still leaves a pre-baseline install alone (rule 2 is unaffected)", async () => {
    const dir = join(home, ".claude", "skills", "wego");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "# hand edited\n");
    await writeFile(join(dir, ".wego-skill-owner"), ""); // pre-baseline
    const { deps } = makeDeps({ body: FRESH });

    expect(await skill(["install", "--owned-only", "-y"], deps)).toBe(0);
    expect(await readFile(userSkillFile(), "utf8")).toBe("# hand edited\n");
  });

  it("still creates nothing in a dir wego does not own", async () => {
    const unowned = join(home, ".claude", "skills", "wego");
    await mkdir(unowned, { recursive: true });
    const { deps } = makeDeps({ body: FRESH });

    expect(await skill(["install", "--owned-only", "-y"], deps)).toBe(0);
    expect(await exists(join(unowned, "SKILL.md"))).toBe(false);
    expect(await exists(join(unowned, ".wego-skill-owner"))).toBe(false);
  });

  it("a CONFIGURED but unreachable channel still declines (the guard is scoped, not deleted)", async () => {
    await ownedDir(STALE);
    const { deps, out } = makeDeps({
      body: FRESH,
      skillUrl: "https://blob.example/skill/stable",
      fetchRemoteSkill: () => Promise.resolve(null),
    });

    expect(await skill(["install", "--owned-only", "-y"], deps)).toBe(0);
    expect(await readFile(userSkillFile(), "utf8")).toBe(STALE);
    expect(out.join("\n")).toMatch(/could not verify/);
  });
});
