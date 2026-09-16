import { existsSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isHelpArg } from "./commands";
import { programName } from "./program-name";
import type { SkillEntry } from "./skill-embed";
import { usage } from "./usage";

/** SHA256 of a UTF-8 body as lowercase hex. Recorded in the ownership marker to
 *  tell "wego wrote this" from "the operator edited it". Lived in
 *  `skill-remote.ts` in wego-ai, which shared it with the remote resolver; that
 *  module went with the skill channel and this is now its only caller. */
async function sha256Hex(body: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(body);
  return hasher.digest("hex");
}

/**
 * `wego skill …` — discover, install, and manage the agent SKILL.md that teaches
 * a coding agent (e.g. Claude Code) to drive this CLI.
 *
 * Three shipping properties (issue #1171):
 *  - **Registry + discovery** — the installable skills live in a `SKILLS`
 *    registry (`skill-embed.ts`); `wego skill list` prints them (offline,
 *    auth-free). install/path/uninstall take an optional `<skill-id>`
 *    defaulting to the sole registered skill.
 *  - **Remote-updatable** — `install` fetches the canonical body from a
 *    build-pinned Blob URL and verifies it fail-closed (`skill-remote.ts`),
 *    falling back to the embedded copy on any failure. No other sub-command
 *    reads a body at all — `path` resolves a target file, offline.
 *  - **Multi-agent** — a vendored path table maps each agent to its skills dir,
 *    so a project install lands in `.claude/skills/<id>` **and** the shared
 *    `.agents/skills/<id>`; multi-target installs are best-effort.
 *
 * The dir leaf is the resolved skill `id` — `wego` for the shipped skill, on
 * every install. Written against injected deps so the flows are unit-testable without
 * touching the real home dir, network, or prompting; `index.ts` wires the
 * concrete implementations.
 */

export interface SkillIo {
  log: (message: string) => void;
  error: (message: string) => void;
}

export interface SkillDeps extends SkillIo {
  /** The installable skill registry (`SKILLS` from skill-embed.ts). Injected so
   *  a test can feed a synthetic multi-entry fixture (exercising `resolveSkill`'s
   *  no-id-with-many branch, which the single shipped skill can't reach). */
  skills: readonly SkillEntry[];
  /** CLI version — used only in the human log lines (matches `wego version`). */
  version: string;
  /** The release ring this install follows (`ring-follow.ts`), stamped into the
   *  ownership marker so a second channel's background refresh can tell that the
   *  skill is not its to maintain. `undefined` on a pre-ring install or from
   *  source — the marker then names no ring and every reader degrades to the
   *  behaviour it had before rings existed. */
  ring?: string;
  /** `~` — the base for user/global scope (`~/.claude/skills/wego`). */
  homedir: () => string;
  /** cwd — the base for project scope (`./.claude/skills/wego`). */
  cwd: () => string;
  /** Confirm a filesystem write; bypassed when `-y`/`--yes` is passed. */
  confirm: (question: string) => Promise<boolean>;
  /** This install's skill channel base — the **baked store origin** plus the ring
   *  **recorded on this machine**, composed by `ring-follow.ts`'s
   *  `skillBaseForRing` (#1751). Not baked whole: a channel compiled into the
   *  binary is wrong on one side of every promote, since a promote moves a pointer
   *  over the same bytes. `undefined` from source, an unbaked build, or an install
   *  with no recorded ring ⇒ `install` uses the embedded copy. `install` composes
   *  `<base>/<id>/…`. */
  skillUrl?: string;
  /** Install-only remote resolver (index.ts binds the real fetch+verify from
   *  `skill-remote.ts`). Returns the **verified canonical** body, or `null` on
   *  any failure (→ embedded fallback). Absent ⇒ always embedded. `install` is
   *  the only caller — and it treats a REJECTION as a failure too, so a down
   *  remote can never fail the install. */
  fetchRemoteSkill?: (baseUrl: string, id: string) => Promise<string | null>;
  /** Treat an unverifiable remote body as "do nothing" instead of falling back to
   *  the embedded copy. Off (embedded fallback) for the foreground `skill
   *  install`, where a fresh install needs *some* body and "never fails on a down
   *  remote" is the contract. On for the **background refresh**, where a body
   *  already exists and may be NEWER than the embedded one — a previous refresh
   *  can have pulled a published body postdating this binary. Falling back there
   *  would silently downgrade a good file and, because the throttle stamp is
   *  already written, leave it downgraded for 24h. Nothing is strictly better
   *  than older. */
  requireRemote?: boolean;
  /** Update only dirs that ALREADY carry an ownership marker; never create a new
   *  target. Set by the same background caller as `requireRemote` (they are
   *  independent policies — remote-failure handling vs target creation — but the
   *  refresh needs both, and `index.ts` sets them together).
   *
   *  Without it the refresh's "refresh-only, never create" contract holds at the
   *  CALL level but not at the WRITE level: ownership gates *whether* to run,
   *  while `resolveTargets` re-runs auto-detect to decide *where*. So a
   *  `~/.codex` created at any point after a Claude-only install would silently
   *  acquire a skill and a marker on the next background refresh — a new
   *  directory in someone's `$HOME`, for an agent they never ran `skill install`
   *  for. The foreground install must keep creating targets; that is its job. */
  refreshOnly?: boolean;
}

type Scope = "user" | "project";
const SCOPES: ReadonlySet<Scope> = new Set<Scope>(["user", "project"]);
function isScope(value: string): value is Scope {
  return (SCOPES as ReadonlySet<string>).has(value);
}

interface SkillOptions {
  /** Optional `<skill-id>` positional; defaults to the sole registered skill. */
  skillId?: string;
  /** `user` = global (`~/…`); `project` = cwd-relative. */
  scope: Scope;
  /** Requested agents (`--agent`/`-a`, repeatable). `["*"]` = every agent in the
   *  table; `[]` = auto-detect. */
  agents: string[];
  /** Override the skills root (`<dir>/<leaf>` is written), ignoring agent/scope. */
  dir?: string;
  yes: boolean;
  force: boolean;
  /** Skip the remote fetch and install the embedded copy (`--embedded`). */
  embedded: boolean;
  /** Only refresh skill folders wego already owns; never create a new one
   *  (`--owned-only`).
   *
   *  How `update` re-installs the skill after it swaps the binary: the new
   *  binary carries a new embedded body, and the install that follows must
   *  update what this machine already has rather than auto-detecting agent dirs
   *  and installing into ones the user never asked for. Maps onto the same
   *  `refreshOnly` dep the background refresh used in wego-ai, so the target
   *  selection and the never-create rule are one implementation, not two. */
  ownedOnly: boolean;
  /** Don't replace a wego-owned `SKILL.md` that has been edited since wego wrote
   *  it (`--keep-local-edits`); skip that target instead.
   *
   *  Exists because "foreground install" and "a human is watching" are NOT the
   *  same thing. The local-edit protection was scoped to `refreshOnly` on the
   *  reasoning that a foreground install is attended and prints what it did — true
   *  when someone types `wego skill install`, false for the `curl | bash`
   *  installer, which calls the same foreground path with no TTY and nobody
   *  reading stdout. That left the installer able to silently discard an edit on
   *  any re-run (e.g. reinstalling to update the binary). This flag is how an
   *  unattended caller asks for the refresh's protection without also asking for
   *  `refreshOnly`'s never-create rule, which the installer legitimately needs. */
  keepLocalEdits: boolean;
}

// The command the user invoked (`wego` / `wegostaging` / a renamed binary),
// resolved once at module load — so the usage lines name the command they typed.
const PROG = programName();

/**
 * Vendored agent → skills-dir path table (compiled-in data, no runtime
 * dependency — replaces the old `SUPPORTED_AGENTS` Set). `global` is relative to
 * `~`; `project` is relative to cwd. Codex/Cursor/OpenCode/Cline share the
 * project-scope `.agents/skills` dir, so a multi-agent project install collapses
 * to `.claude/skills` + `.agents/skills`. Agent-name reconciliation with
 * `npx skills` (`claude-code` vs `claude`, …) is documented in
 * `docs/skill-distribution.md`.
 */
export const AGENTS: Record<string, { project: string; global: string }> = {
  claude: { project: ".claude/skills", global: ".claude/skills" },
  codex: { project: ".agents/skills", global: ".codex/skills" },
  cursor: { project: ".agents/skills", global: ".cursor/skills" },
  opencode: { project: ".agents/skills", global: ".opencode/skills" },
  cline: { project: ".agents/skills", global: ".cline/skills" },
};
const AGENT_NAMES = Object.keys(AGENTS);

export const SKILL_USAGE = usage({
  cmd: "skill <list|install|path|uninstall> [<skill-id>]",
  what: `Install the agent skill so a coding agent can drive ${PROG}. list works offline.`,
  flags: [
    [
      "--scope VALUE",
      "user: every agent folder found in your home (~/.claude, ~/.codex, ~/.cursor, ~/.opencode, ~/.cline); ~/.claude/skills/wego when none. project: ./.claude/skills/wego and ./.agents/skills/wego.",
      SCOPES,
    ],
    ["-g, --global", "Same as --scope user."],
    ["-a, --agent NAME", "Which coding agent. '*' for all.", AGENT_NAMES],
    ["--dir PATH", "Install under this skills folder."],
    [
      "--embedded",
      "install: use the copy baked into this binary, no download.",
    ],
    [
      "--keep-local-edits",
      `install: skip a SKILL.md edited since ${PROG} wrote it.`,
    ],
    [
      "--owned-only",
      `install: only refresh folders ${PROG} already owns; never create one.`,
    ],
    ["-y", "Skip the confirm."],
    ["--force", `Overwrite a file ${PROG} did not write.`],
    ["--json", "list: machine-readable output."],
  ],
});

// A sibling ownership marker, answering two SEPARATE questions with the same
// file. OWNERSHIP is presence-only: its presence means wego wrote the dir (so
// an upgrade may overwrite it); its absence next to a SKILL.md means a foreign
// / hand-authored file we refuse to clobber without --force. That check never
// reads the file — accident-prevention in a cooperative environment,
// deliberately forgeable, NOT a security control (the body's integrity is Part
// B's SHA256 verify). The CONTENT is a separate signal on top: it holds the
// SHA256 of the body wego last wrote (`stampOwnerMarker`), which
// `localEditState` compares against what's on disk to tell "wego wrote this" from
// "a human edited it" — the baseline an unattended caller needs before it can
// safely overwrite. The legacy `.wego-skill-version` name (written by the #1188
// binary) is still honored on read so those dirs aren't seen as foreign; it
// predates the content baseline, so a marker under that name reads as
// `"unknown"` (see `localEditState`).
const MARKER_NAME = ".wego-skill-owner";
const LEGACY_MARKER_NAME = ".wego-skill-version";

/** Both marker filenames, current first — the read order `hasOwnerMarker` uses.
 *  Exported so the background refresh (`skill-refresh.ts`) gates on, and stamps,
 *  the same file this module treats as proof of ownership, rather than
 *  hard-coding a second copy of these names. */
export const MARKER_NAMES = [MARKER_NAME, LEGACY_MARKER_NAME] as const;

// The `--flag value` / `--flag=value` options; `-a` is short for `--agent`.
const VALUE_FLAGS = new Set(["--scope", "--agent", "--dir"]);

// Valueless flags, as a lookup of their mutation — a table (not a branch per
// flag) keeps `parseSkillArgs` under the cognitive-complexity gate.
const VALUELESS_FLAGS: Record<string, (o: SkillOptions) => void> = {
  "-y": (o) => {
    o.yes = true;
  },
  "--yes": (o) => {
    o.yes = true;
  },
  "--force": (o) => {
    o.force = true;
  },
  "-g": (o) => {
    o.scope = "user";
  },
  "--global": (o) => {
    o.scope = "user";
  },
  "--embedded": (o) => {
    o.embedded = true;
  },
  "--keep-local-edits": (o) => {
    o.keepLocalEdits = true;
  },
  "--owned-only": (o) => {
    o.ownedOnly = true;
  },
};

/** Resolve a value flag's value from its inline (`=value`) or next-arg form.
 *  Throws when the value is missing/empty or looks like another flag. */
function flagValue(
  name: string,
  inline: string | undefined,
  next: string | undefined,
): string {
  if (inline !== undefined) {
    if (inline === "") throw new Error(`${name} requires a value`);
    return inline;
  }
  if (next === undefined || next.startsWith("-")) {
    throw new Error(`${name} requires a value`);
  }
  return next;
}

/** Validate + apply one resolved value flag onto `opts`. */
function assignSkillFlag(
  opts: SkillOptions,
  name: string,
  value: string,
): void {
  switch (name) {
    case "--scope":
      if (!isScope(value)) {
        throw new Error(`--scope must be one of ${[...SCOPES].join(", ")}`);
      }
      opts.scope = value;
      return;
    case "--agent":
      if (value !== "*" && !AGENTS[value]) {
        throw new Error(
          `--agent "${value}" is not supported (supported: ${AGENT_NAMES.join(", ")}, or '*' for all)`,
        );
      }
      opts.agents.push(value);
      return;
    default:
      opts.dir = value; // "--dir"
  }
}

/** Parse one `--flag value` / `--flag=value` token onto `opts`, returning the
 *  number of argv items it consumed (1 for the inline `=value` form, 2 for the
 *  `--flag value` pair). Extracted from `parseSkillArgs` so the main loop stays
 *  under the cognitive-complexity gate. Throws a usage `Error` on an unknown
 *  flag / missing value / bad scope. */
function consumeValueFlag(
  opts: SkillOptions,
  arg: string,
  next: string | undefined,
): number {
  const eq = arg.indexOf("=");
  // `-a` is short for `--agent`.
  const name = (eq === -1 ? arg : arg.slice(0, eq)).replace(/^-a$/, "--agent");
  if (!VALUE_FLAGS.has(name)) {
    throw new Error(`Unknown option: ${name}\n${SKILL_USAGE}`);
  }
  const inline = eq === -1 ? undefined : arg.slice(eq + 1);
  assignSkillFlag(opts, name, flagValue(name, inline, next));
  return inline === undefined ? 2 : 1;
}

/**
 * Turn `wego skill <sub> …` argv (everything after `<sub>`) into `SkillOptions`.
 * Supports `--flag value` / `--flag=value` (`--scope`/`--agent`/`-a`/`--dir`),
 * the valueless `-y`/`--yes`, `--force`, `-g`/`--global`, `--embedded`, and a
 * single optional `<skill-id>` positional. Throws a usage `Error` on an unknown
 * flag / missing value / bad scope / a second positional.
 */
export function parseSkillArgs(args: string[]): SkillOptions {
  const opts: SkillOptions = {
    scope: "user",
    agents: [],
    yes: false,
    force: false,
    embedded: false,
    keepLocalEdits: false,
    ownedOnly: false,
  };
  // `while` (not `for`) because a `--flag value` pair advances the index by two.
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    const valueless = VALUELESS_FLAGS[arg];
    if (valueless) {
      valueless(opts);
      i += 1;
    } else if (!arg.startsWith("-")) {
      if (opts.skillId !== undefined) {
        throw new Error(`Unexpected argument: ${arg}\n${SKILL_USAGE}`);
      }
      opts.skillId = arg;
      i += 1;
    } else {
      i += consumeValueFlag(opts, arg, args[i + 1]);
    }
  }
  return opts;
}

/** The shipped skill's id, which is also its install dir leaf. */
const SHIPPED_SKILL_ID = "wego";

/**
 * Resolve the requested skill id against the registry: no id + exactly one
 * entry → that entry; no id + more than one → a usage error; an unknown id → an
 * error that names `skill list`. The `>1` branch is only reachable via an
 * injected synthetic fixture today (capability, not exercised by the sole
 * shipped skill).
 */
export function resolveSkill(
  skills: readonly SkillEntry[],
  id?: string,
): SkillEntry {
  if (id === undefined) {
    if (skills.length === 1) return skills[0];
    throw new Error(
      `More than one skill is registered – specify which: ${skills
        .map((s) => s.id)
        .join(", ")}. Run \`${PROG} skill list\`.`,
    );
  }
  const found = skills.find((s) => s.id === id);
  if (!found) {
    throw new Error(
      `Unknown skill "${id}". Run \`${PROG} skill list\` to see installable skills.`,
    );
  }
  return found;
}

/** The default user-scope skill dir, `~/.claude/skills/wego`. Exported so
 *  `index.ts` builds `wego uninstall`'s summary path from the SAME leaf the
 *  actual removal resolves through, keeping the printed and deleted targets from
 *  drifting. */
/**
 * Every user-scope dir a **default** `skill install` would write to on this
 * machine — i.e. `selectedAgents`' user-scope auto-detect (agents whose home
 * config dir exists, Claude when none is), mapped through `AGENTS[].global` and
 * deduped by root, with the skill leaf.
 *
 * Exists because the background refresh must watch exactly what the installer
 * writes. `defaultUserSkillDir` alone is only correct on a Claude machine: a
 * Codex/Cursor/OpenCode/Cline-only user gets the skill auto-installed under that
 * agent's dir and no `~/.claude/skills/wego` at all, so gating the refresh on
 * the Claude marker would report "not owned" forever and freeze exactly the
 * installs this feature is meant to keep current.
 *
 * `defaultUserSkillDir` stays Claude-only for `uninstall`, which is deliberately
 * conservative — removal should not sweep every detected agent's global dir.
 */
export function autoDetectedUserSkillDirs(home: string): string[] {
  const detected = AGENT_NAMES.filter((a) =>
    existsSync(join(home, dirname(AGENTS[a].global))),
  );
  const agents = detected.length > 0 ? detected : ["claude"];
  const roots = new Set(agents.map((a) => join(home, AGENTS[a].global)));
  return [...roots].map((root) => join(root, SHIPPED_SKILL_ID));
}

export function defaultUserSkillDir(home: string): string {
  return join(home, ".claude", "skills", SHIPPED_SKILL_ID);
}

/** The skills **root** dir for one agent under the chosen scope. */
function agentRoot(deps: SkillDeps, opts: SkillOptions, agent: string): string {
  const dirs = AGENTS[agent];
  return opts.scope === "user"
    ? join(deps.homedir(), dirs.global)
    : join(deps.cwd(), dirs.project);
}

/** The agents to write to: `'*'` → all; explicit → as requested; otherwise
 *  auto. For a **project** install the default is Claude + the shared `.agents`
 *  family (so it lands in `.claude/skills` + `.agents/skills`). For a **user**
 *  (global) install, auto-detect agents whose home config dir exists (don't
 *  litter `~/.cursor` for a non-Cursor user), defaulting to Claude when none is
 *  detected. `uninstall` stays conservative — Claude only unless asked. */
function selectedAgents(
  deps: SkillDeps,
  opts: SkillOptions,
  forUninstall: boolean,
): string[] {
  if (opts.agents.includes("*")) return AGENT_NAMES;
  if (opts.agents.length > 0) return [...new Set(opts.agents)];
  // A **project** uninstall must mirror the project install's default targets
  // (Claude + the shared `.agents` family), or `uninstall --scope project` would
  // orphan the `.agents/skills/<id>` copy the matching install wrote. A **user**
  // (global) uninstall stays conservative — Claude only — so the top-level
  // `wego uninstall` never sweeps every auto-detected agent's global dir.
  if (opts.scope === "project") return ["claude", "codex"];
  if (forUninstall) return ["claude"];
  const detected = AGENT_NAMES.filter((a) =>
    existsSync(join(deps.homedir(), dirname(AGENTS[a].global))),
  );
  return detected.length > 0 ? detected : ["claude"];
}

/** Resolve the target skill dirs (deduped by root — the `.agents/skills` family
 *  collapses to one). `--dir` overrides everything to a single target. */
function resolveTargets(
  deps: SkillDeps,
  opts: SkillOptions,
  leaf: string,
  forUninstall: boolean,
): string[] {
  if (opts.dir !== undefined) return [join(opts.dir, leaf)];
  const roots = new Set<string>();
  for (const agent of selectedAgents(deps, opts, forUninstall)) {
    roots.add(agentRoot(deps, opts, agent));
  }
  return [...roots].map((root) => join(root, leaf));
}

/** Read a file, returning `null` only when it does NOT exist (`ENOENT`).
 *  Any OTHER read error (permissions, I/O) PROPAGATES rather than degrading to
 *  "missing" — a present-but-unreadable `SKILL.md` must not be treated as
 *  absent, because `installOne` gates its overwrite protections on
 *  `existing !== null` and `writeFileAtomic`'s `rename` would then silently
 *  replace it regardless of the file's own permissions (only the directory's
 *  write permission matters to `rename`). Every caller here already runs
 *  inside a try/catch that reports a per-target failure, so throwing surfaces
 *  the problem instead of writing over it — that IS "preserve the file when
 *  its edit state cannot be determined." `markerBaseline` is the one caller
 *  that wants unreadable folded into "unknown" (a lower-stakes heuristic, not
 *  file content), and it swallows explicitly for that reason. */
async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}

/** True when a skills dir carries wego's ownership marker (`.wego-skill-owner`,
 *  or the legacy `.wego-skill-version` from the #1188 binary). **Presence-only**
 *  — ownership never depends on the contents, so a marker written by any older
 *  binary still reads as ours. */
function hasOwnerMarker(dir: string): boolean {
  return (
    existsSync(join(dir, MARKER_NAME)) ||
    existsSync(join(dir, LEGACY_MARKER_NAME))
  );
}

/**
 * The SHA256 the marker records for the body wego last wrote, or `null` when
 * there is no baseline to compare against (no marker, a legacy/contentless one,
 * or unreadable).
 *
 * Ownership stays presence-only; this is a *separate* question layered on top —
 * ownership answers "may we write here", the baseline answers "would writing
 * destroy something the operator typed". An absent baseline is not a failure,
 * it is simply "unknown", and every caller must degrade to today's behaviour.
 */
async function markerBaseline(dir: string): Promise<string | null> {
  let raw: string | null;
  try {
    raw = await readIfExists(join(dir, MARKER_NAME));
  } catch {
    // Unlike SKILL.md itself, an unreadable MARKER degrades to "no baseline"
    // same as a missing one: this is a lower-stakes heuristic signal, not the
    // content an overwrite would destroy, and every caller already treats a
    // null baseline as "unknown" (see the doc comment above).
    return null;
  }
  // FIRST LINE, not the whole file: the marker grew an optional `ring=` line
  // (`stampOwnerMarker`), and matching the digest against the whole trimmed body
  // would read every ring-stamped marker as "no baseline" — silently disabling
  // local-edit detection for exactly the installs that carry one.
  const hex = raw?.split("\n", 1)[0]?.trim().toLowerCase();
  return hex !== undefined && /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

/**
 * Stamp the current ownership marker with `content`'s digest, and **retire any
 * legacy marker in the same dir**.
 *
 * Retiring matters because the two names are not merely aliases once mtimes are
 * load-bearing. The background refresh watches BOTH names and takes the OLDEST
 * mtime, so a legacy marker left behind by an upgraded install stays stale
 * forever while only this one gets restamped — and a stale marker keeps the
 * throttle window permanently open. The visible symptom is the one the explicit-
 * command guard is supposed to prevent: `skill install --embedded` completes,
 * then the very next ordinary command sees "stale" and pulls the remote body
 * over the embedded one the user explicitly asked for.
 *
 * Removing rather than restamping, because two files recording one fact is what
 * created the bug: any future write that updates one and not the other brings it
 * straight back. `uninstall` already deletes both names, so the legacy file is
 * long since ours to manage. The cost is that a rollback to a pre-rename binary
 * would no longer recognise the dir — but that fails loudly with the "not
 * installed by wego, re-run with --force" message, not silently.
 */
async function stampOwnerMarker(
  dir: string,
  content: string,
  ring?: string,
  source?: string,
): Promise<void> {
  const digest = await sha256Hex(content);
  const lines = [digest];
  if (ring) lines.push(`${MARKER_RING_PREFIX}${ring}`);
  if (source) lines.push(`${MARKER_SOURCE_PREFIX}${source}`);
  await writeFile(
    join(dir, MARKER_NAME),
    lines.length > 1 ? `${lines.join("\n")}\n` : digest,
  );
  await rm(join(dir, LEGACY_MARKER_NAME), { force: true });
}

/** The marker's optional second line: which release ring's install wrote this
 *  skill (foundations#74). Prefixed rather than bare so the line says what it is,
 *  and so a future third line cannot be mistaken for it. */
const MARKER_RING_PREFIX = "ring=";

/**
 * The marker's optional third line: WHERE the body wego wrote actually came from
 * — a ring name (`stable`) when it was fetched and verified from that channel, or
 * `embedded` when it came from this binary's own copy (issue #1751).
 *
 * Separate from `ring=`, which records which install's ring OWNS the dir. The two
 * are usually the same name and are still different facts: a `stable` install that
 * fell back to its embedded copy because the channel was unreachable owns the dir
 * as `stable` while the body on disk came from the binary. The install message
 * reports THIS one, because "which body is this" is the question the version stamp
 * used to answer wrongly.
 */
const MARKER_SOURCE_PREFIX = "source=";

/** The body source recorded in a marker, or `null` when it names none (every
 *  marker written before #1751). Same tolerant prefix scan as `markerRing`. */
export function markerSource(raw: string | null): string | null {
  const line = raw
    ?.split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith(MARKER_SOURCE_PREFIX));
  return line?.slice(MARKER_SOURCE_PREFIX.length).trim() || null;
}

/**
 * The ring recorded in `dir`'s marker, or `null` when it names none.
 *
 * `null` is the pre-ring marker (one bare digest line) and is NOT a refusal —
 * every caller degrades to the behaviour it had before rings existed. Only a
 * marker that positively names a DIFFERENT ring is evidence of another channel's
 * ownership.
 */
export function markerRing(raw: string | null): string | null {
  const line = raw
    ?.split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith(MARKER_RING_PREFIX));
  // `|| null`, not a ternary: an empty or whitespace-only ring is "names none",
  // the same answer as an absent line, and `||` says that in one token.
  return line?.slice(MARKER_RING_PREFIX.length).trim() || null;
}

/**
 * Whether `dir`'s `SKILL.md` still holds exactly the bytes wego last wrote.
 *
 * `"unmodified"` / `"modified"` are only returned when a baseline exists;
 * `"unknown"` covers every dir installed before markers carried one (and any
 * unreadable file). `"unknown"` is genuinely undecidable, so the two unattended
 * callers answer it differently rather than sharing one guess — see `installOne`,
 * where the silent refresh preserves it and the installer rebaselines it.
 */
async function localEditState(
  dir: string,
  existing: string | null,
): Promise<"unmodified" | "modified" | "unknown"> {
  const baseline = await markerBaseline(dir);
  if (baseline === null || existing === null) return "unknown";
  return (await sha256Hex(existing)) === baseline ? "unmodified" : "modified";
}

/**
 * Write `file` via a sibling temp file + `rename`.
 *
 * `rename` within a directory is atomic, which matters twice here: a crash or
 * SIGINT mid-write can no longer leave a truncated `SKILL.md` behind (the
 * background refresh stamps its throttle marker BEFORE writing, so a corrupt
 * body would otherwise persist for the full 24h window with nothing to detect
 * it), and two concurrent `wego` processes racing the same path now interleave
 * at whole-file granularity instead of byte-level. The temp name carries the
 * pid so those two processes cannot collide on the temp file either.
 */
async function writeFileAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.tmp.${process.pid}`;
  try {
    // `wx` = create-exclusive: fail if the path already exists, and crucially do NOT
    // follow it. A plain write follows a symlink, so anyone able to pre-create
    // `SKILL.md.tmp.<pid>` in this dir could redirect the body somewhere else — the temp
    // name is derived from a pid, so it is guessable. That needs write access to the
    // user's own skill dir, which makes it hardening rather than a hole, but exclusive
    // create costs nothing and turns the attempt into a per-target failure instead of a
    // write-through. It also surfaces a leftover temp from a killed run rather than
    // silently reusing it.
    await writeFile(tmp, content, { flag: "wx" });
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Resolve the canonical install body: the verified remote copy when a URL is
 *  baked and `--embedded` wasn't passed, else the embedded copy. One body, shipped
 *  as published — there is no local rewrite between verification and the write. */
async function resolveInstallBody(
  deps: SkillDeps,
  entry: SkillEntry,
  opts: SkillOptions,
): Promise<{ body: string; verified: boolean } | null> {
  let canonical: string | null = null;
  if (!opts.embedded && deps.skillUrl && deps.fetchRemoteSkill) {
    // "install never fails on a down remote" is enforced HERE, not delegated to
    // the injected resolver. `fetchRemoteSkill` is fail-closed-by-return today
    // (it resolves null on every failure), but that is its contract, not a
    // guarantee this composition can rely on: a resolver that REJECTS would
    // otherwise turn a down remote into a hard install failure.
    try {
      canonical = await deps.fetchRemoteSkill(deps.skillUrl, entry.id);
    } catch {
      canonical = null;
    }
  }
  // `requireRemote` (background refresh) stops here rather than downgrading an
  // existing, possibly-newer file to the embedded copy. The foreground install
  // keeps the embedded fallback — it may be creating the file from nothing.
  if (canonical === null && deps.requireRemote) return null;
  // `verified` records WHERE the body came from, which the caller needs because
  // the right answer differs per target: creating a file from nothing should use
  // the embedded copy, while replacing an existing one with it may be a
  // DOWNGRADE (an earlier refresh can have installed a published body that
  // postdates this binary's embed). `requireRemote` decides that globally for the
  // refresh; the installer needs it per-dir, so the fact travels instead.
  const verified = canonical !== null;
  if (canonical === null) canonical = await entry.read();
  return { body: canonical, verified };
}

type TargetOutcome = {
  dir: string;
  ok: boolean;
  message: string;
  error?: boolean;
};

/**
 * Why an UNATTENDED caller must leave an existing `SKILL.md` alone, or `null` to
 * go ahead and write it.
 *
 * Split out of `installOne` because all three rules share one precondition — the
 * caller is unattended and `--force` was not passed — and reasoning about them
 * together is the point: each answers a different "is overwriting safe?" question
 * about the same file.
 *
 * "Unattended" is not "background". A foreground `skill install` a user typed IS
 * the request for the canonical body, and it prints what it did, so it overwrites.
 * But foreground and "someone is watching" came apart in one place: the
 * `curl | bash` installer runs this same foreground path with no TTY and nobody
 * reading stdout, on every re-run. `--keep-local-edits` is how that caller asks
 * for this protection without also taking `refreshOnly`'s never-create rule,
 * which it legitimately needs on a clean machine.
 */
function unattendedSkipReason(
  deps: SkillDeps,
  opts: SkillOptions,
  file: string,
  edit: "unmodified" | "modified" | "unknown",
  verified: boolean,
): string | null {
  if (opts.force) return null;
  const unattended = deps.refreshOnly === true || opts.keepLocalEdits;
  if (!unattended) return null;

  // 1. A hand edit we can SEE. Never let the silent path destroy something a
  //    human typed: it produces no diff, no backup and no log line, so the edit
  //    is simply gone within 24h with nothing to notice. Ownership says we MAY
  //    write; it does not say the current bytes are ours to discard.
  if (edit === "modified") {
    return `${file} has local modifications – left alone. Run \`${programName()} skill install --force\` to replace it with the published copy.`;
  }

  // 2. A hand edit we CANNOT see. `"unknown"` means the dir predates the content
  //    baseline, so "is this an edit?" is undecidable — and the two unattended
  //    callers must not answer it the same way.
  //
  //    The SILENT refresh preserves it: `wego update` replaces the binary without
  //    running an install, so a machine really can arrive here holding a
  //    hand-edited body under a baseline-less marker, and destroying it would be
  //    unrecoverable. Undecidable is exactly when a silent write is least
  //    defensible.
  //
  //    The INSTALLER (`--keep-local-edits`, no `refreshOnly`) still rebaselines,
  //    and that is what keeps rule 2 from becoming permanent: nothing else ever
  //    writes a baseline for a pre-marker install, so if the installer preserved
  //    it too, the refresh would freeze every existing machine forever — the exact
  //    staleness this feature exists to remove. The installer is a deliberate act,
  //    so one loud overwrite there buys a correct baseline from then on, and
  //    `wego skill install` fixes a machine by hand in the meantime.
  if (edit === "unknown" && deps.refreshOnly === true) {
    return `${file} predates the content baseline – left alone. Run \`${programName()} skill install\` to adopt it.`;
  }

  // 3. Not an edit at all, but writing would still lose content: a channel is
  //    configured, its fetch did not land, and the fallback body is the binary's
  //    embed with a file already there. An earlier refresh may have installed a
  //    published body postdating this build, so writing would DOWNGRADE it.
  //    `requireRemote` gives the refresh this all-or-nothing, which the installer
  //    cannot take — on a clean machine it must still create from nothing — hence
  //    the per-target decision off `resolveInstallBody`'s `verified`. The edit
  //    guard above does not cover this: the installed body matches its baseline,
  //    so it is not an edit.
  //
  //    Scoped to a CONFIGURED channel, and that scoping is the whole of #24.
  //    `verified` does double duty — it also labels the marker's provenance — and
  //    is false whenever the body is the embed, including when there is no other
  //    source it could have come from. This repository ships exactly that wiring:
  //    the skill channel is gone and `index.ts` supplies neither `skillUrl` nor
  //    `fetchRemoteSkill`, so the rule fired on every machine that already had
  //    the skill and the post-update refresh could never write. With no channel
  //    nothing on disk can postdate this binary's embed, so there is no newer
  //    body to lose and the premise the rule is written on does not hold.
  const channelConfigured =
    deps.skillUrl !== undefined && deps.fetchRemoteSkill !== undefined;
  if (!verified && channelConfigured) {
    return `${file} left unchanged – could not verify the published copy, and the installed one may be newer than this binary's built-in copy.`;
  }
  return null;
}

/** Install into one target dir. Never throws — an fs error or the foreign-file
 *  refusal is reported as a per-target failure so the multi-target driver can
 *  keep the other targets. */
async function installOne(
  deps: SkillDeps,
  content: string,
  dir: string,
  opts: SkillOptions,
  verified: boolean,
): Promise<TargetOutcome> {
  const file = join(dir, "SKILL.md");
  // Provenance of the body about to be written (#1751). `verified` is true only
  // when `resolveInstallBody` fetched AND checksum-verified it from the channel,
  // so the recorded ring names where it came from; anything else is this binary's
  // own embedded copy.
  //
  // `remote` covers a verified body whose ring we cannot name. Real wiring never
  // produces it — `skillBaseForRing` yields no channel without a ring, so there is
  // nothing to fetch from — but a caller that injects `skillUrl` directly can, and
  // the honest answer there is "a channel, not this binary" rather than a ring name
  // invented to fill the slot. The whole point of this field is that it never
  // claims more than it knows.
  const source = verified ? (deps.ring ?? "remote") : "embedded";
  try {
    // Refresh mode updates what wego already owns and nothing else. `ok: true`
    // because skipping is the correct outcome here, not a failure — a run where
    // every target is skipped should still exit 0.
    if (deps.refreshOnly && !hasOwnerMarker(dir)) {
      return { dir, ok: true, message: `${dir} not wego-owned – left alone.` };
    }
    // After the skip, not before: the body is ~96KB and the silent refresh calls
    // this for every detected dir, so hashing ahead of the early return would pay
    // for a digest that path discards.
    const digest = await sha256Hex(content);
    const existing = await readIfExists(file);
    if (existing === content) {
      // Byte-identical already — nothing to write. But a marker-less file that
      // happens to match canonical content would otherwise never get a marker,
      // so the NEXT body change would be refused as foreign and every future
      // upgrade would need --force. Claim it now.
      //
      // ACCEPTED TRADEOFF: a *coincidental* byte-match grants permanent
      // ownership of a dir wego didn't write. Accepted because (a) the bytes are
      // exactly what install would have written, so nothing of the author's is
      // lost or overwritten; (b) the marker is presence-only accident-prevention,
      // not a security control (body integrity is the SHA256 verify); and (c) the
      // alternative — never adopting — permanently degrades the upgrade path for a
      // file whose content we already own. `uninstall` stays conservative: it
      // deletes only SKILL.md + the markers and leaves any other file in the dir,
      // so adoption never widens what a later removal touches.
      await stampOwnerMarker(dir, content, deps.ring, source);
      return { dir, ok: true, message: `${file} already up to date.` };
    }
    const isUpdate = existing !== null;
    if (isUpdate && !hasOwnerMarker(dir) && !opts.force) {
      return {
        dir,
        ok: false,
        error: true,
        message: `${file} exists and was not installed by wego. Re-run with --force to overwrite it.`,
      };
    }
    // With a file already there, an unattended caller may have to leave it alone
    // rather than write — three separate reasons, all in `unattendedSkipReason`.
    // Gated on `existing !== null` because every one of them is about not losing
    // content that is already on disk; creating from nothing is never a loss.
    const edit = await localEditState(dir, existing);
    if (existing !== null) {
      const skip = unattendedSkipReason(deps, opts, file, edit, verified);
      if (skip !== null) return { dir, ok: true, message: skip };
    }
    await mkdir(dir, { recursive: true });
    await writeFileAtomic(file, content);
    // The marker now records WHAT we wrote, WHICH RING wrote it, and WHERE the
    // body came from — not merely that we wrote. Still presence-only for ownership
    // (`hasOwnerMarker` never reads it); the ring is read by the background refresh
    // alone, to tell a skill it maintains from one another channel's install owns.
    await stampOwnerMarker(dir, content, deps.ring, source);
    return {
      dir,
      ok: true,
      // Two ways to pick it up, and the order matters for an agent that just ran
      // this mid-session: reading the file works now, a restart is only needed
      // for automatic discovery. (The `apps/api` onboarding doc takes the first.)
      //
      // Say so when the replaced body was NOT what we last wrote: the foreground
      // command is allowed to overwrite an edit, but it must not do it quietly —
      // that is the whole difference between it and the refresh path above.
      // Names the BODY, not the binary. It used to interpolate `deps.version`, the
      // running binary's version — a fact about the wrong thing, and unfalsifiable:
      // it read "(v0.8.0)" just as confidently while writing a body from a retired
      // channel that the binary had never embedded (#1751). `SKILL.md` carries no
      // version of its own, so source + digest is the honest identity available.
      message: `${isUpdate ? "Updated" : "Installed"} ${basename(dir)} skill → ${file} (${source}, ${digest.slice(0, 12)}).${edit === "modified" ? " Replaced a locally modified copy." : ""} Read that file to use it now, or restart your agent to pick it up automatically.`,
    };
  } catch (err) {
    return {
      dir,
      ok: false,
      error: true,
      message: `Failed to install to ${dir}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Emit per-target outcomes and return the command exit code: **best-effort** —
 *  a run succeeds (exit 0) as long as at least one target succeeded; it exits
 *  non-zero only when EVERY target failed. A single skipped/foreign target among
 *  successes is a warning, not a failure. */
function reportOutcomes(deps: SkillDeps, outcomes: TargetOutcome[]): number {
  for (const o of outcomes) {
    if (o.error) deps.error(o.message);
    else deps.log(o.message);
  }
  if (outcomes.length > 1) {
    const ok = outcomes.filter((o) => o.ok).length;
    deps.log(`${ok}/${outcomes.length} target(s) succeeded.`);
  }
  return outcomes.some((o) => o.ok) ? 0 : 1;
}

async function install(deps: SkillDeps, opts: SkillOptions): Promise<number> {
  const entry = resolveSkill(deps.skills, opts.skillId);
  const resolved = await resolveInstallBody(deps, entry, opts);
  if (resolved === null) {
    // Only reachable with `requireRemote` (the background refresh): the channel
    // was unverifiable, so leave every target exactly as it is.
    deps.log(
      `Could not verify the published ${entry.id} skill – leaving the installed copy unchanged.`,
    );
    return 0;
  }
  const leaf = entry.id;
  const targets = resolveTargets(deps, opts, leaf, false);

  if (!opts.yes) {
    const list = targets.map((t) => `  ${join(t, "SKILL.md")}`).join("\n");
    const ok = await deps.confirm(
      `Install the ${entry.id} agent skill to:\n${list}\n?`,
    );
    if (!ok) {
      deps.log("Skipped.");
      return 0;
    }
  }

  const outcomes: TargetOutcome[] = [];
  for (const dir of targets) {
    outcomes.push(
      await installOne(deps, resolved.body, dir, opts, resolved.verified),
    );
  }
  return reportOutcomes(deps, outcomes);
}

function printPath(deps: SkillDeps, opts: SkillOptions): number {
  const entry = resolveSkill(deps.skills, opts.skillId);
  const leaf = entry.id;
  // An EXPLICIT selection (`-a`/`--agent '*'`) asks "where would this agent's copy
  // go" — answer verbatim, installed or not.
  if (opts.agents.length > 0) {
    for (const dir of resolveTargets(deps, opts, leaf, false)) {
      deps.log(join(dir, "SKILL.md"));
    }
    return 0;
  }
  // With no selection, report where the skill ACTUALLY is. This used to reuse
  // `uninstall`'s conservative Claude-only default for a single deterministic
  // line, which prints `~/.claude/skills/<leaf>/SKILL.md` — a path that does not
  // exist on a Codex/Cursor/OpenCode/Cline-only machine, precisely the machines
  // the auto-detecting installer serves. That matters beyond cosmetics: the
  // agent-onboarding doc (`apps/api/src/skills.ts`) tells an agent to READ the
  // path this prints in order to load the skill in-session, so a wrong line there
  // breaks onboarding silently — the agent reads nothing and carries on.
  //
  // Ownership is part of the filter, not just presence. `installOne` REFUSES a
  // marker-less `SKILL.md` as foreign, so on a multi-agent machine a dir can hold
  // someone else's file next to a dir holding ours. Reporting the foreign one
  // hands the agent unrelated instructions to load — worse than reporting
  // nothing, because it looks like it worked. The same marker test that decides
  // we may WRITE there decides we may CLAIM it here.
  const installed = resolveTargets(deps, opts, leaf, false).filter(
    (dir) => existsSync(join(dir, "SKILL.md")) && hasOwnerMarker(dir),
  );
  if (installed.length > 0) {
    for (const dir of installed) deps.log(join(dir, "SKILL.md"));
    return 0;
  }
  // Nothing owned anywhere. Fall back to the conservative single target so the
  // pre-install "where would it land" use keeps one deterministic answer — but
  // NOT when that location is itself occupied by a foreign file. Otherwise the
  // ownership filter above is undone at exactly the moment it matters: no owned
  // copy exists, so we fall through and name the very file `installOne` refuses
  // to touch, and onboarding reads it as the verified Wego skill.
  const fallback = resolveTargets(deps, opts, leaf, true);
  const foreign = fallback.filter(
    (dir) => existsSync(join(dir, "SKILL.md")) && !hasOwnerMarker(dir),
  );
  if (foreign.length > 0) {
    // stdout is the machine-readable answer ("the path to wego's skill"), and
    // there isn't one — so it stays empty rather than carrying a path that would
    // be wrong to read. The reason goes to stderr, and the exit stays 0 because
    // `path` is documented as an offline, non-failing lookup.
    deps.error(
      `No wego skill is installed. ${foreign
        .map((d) => join(d, "SKILL.md"))
        .join(
          ", ",
        )} exists but was not installed by wego, so it is not reported here. Run \`${programName()} skill install\` (add --force to take over that file).`,
    );
    return 0;
  }
  for (const dir of fallback) deps.log(join(dir, "SKILL.md"));
  return 0;
}

async function list(deps: SkillDeps, args: string[]): Promise<void> {
  const unknown = args.find((arg) => arg !== "--json");
  if (unknown) throw new Error(`Unknown option: ${unknown}\n${SKILL_USAGE}`);
  // The id a user may pass back to `install`, and the description that install
  // would actually write.
  const rows = deps.skills.map((s) => ({
    id: s.id,
    description: s.description,
  }));
  if (args.includes("--json")) {
    deps.log(JSON.stringify(rows));
    return;
  }
  for (const s of rows) deps.log(`${s.id}\t${s.description}`);
}

/** Uninstall from one target dir. Never throws (best-effort driver). */
async function uninstallOne(
  dir: string,
  opts: SkillOptions,
): Promise<TargetOutcome> {
  const file = join(dir, "SKILL.md");
  try {
    if ((await readIfExists(file)) === null) {
      return { dir, ok: true, message: `No wego skill installed at ${file}.` };
    }
    if (!hasOwnerMarker(dir) && !opts.force) {
      return {
        dir,
        ok: false,
        error: true,
        message: `${file} exists but was not installed by wego. Re-run with --force to remove it.`,
      };
    }
    // Remove only what install writes (SKILL.md + either marker name), then drop
    // the dir *only if it is now empty* — a `--force`-adopted dir's other files
    // are the user's and must be left intact.
    await rm(file, { force: true });
    await rm(join(dir, MARKER_NAME), { force: true });
    await rm(join(dir, LEGACY_MARKER_NAME), { force: true });
    // Check emptiness explicitly rather than rm-and-swallow so a real fs error
    // (EACCES/…) propagates instead of masquerading as "adopted files remain".
    if ((await readdir(dir)).length === 0) {
      await rmdir(dir);
      return { dir, ok: true, message: `Removed wego skill at ${dir}.` };
    }
    return {
      dir,
      ok: true,
      message: `Removed wego skill from ${dir}; left files wego did not create.`,
    };
  } catch (err) {
    return {
      dir,
      ok: false,
      error: true,
      message: `Failed to uninstall from ${dir}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function uninstall(deps: SkillDeps, opts: SkillOptions): Promise<number> {
  const entry = resolveSkill(deps.skills, opts.skillId);
  const leaf = entry.id;
  const targets = resolveTargets(deps, opts, leaf, true);
  const outcomes: TargetOutcome[] = [];
  for (const dir of targets) {
    outcomes.push(await uninstallOne(dir, opts));
  }
  return reportOutcomes(deps, outcomes);
}

/** `wego skill <sub> …` — dispatch to the sub-command handlers. */
export async function skill(args: string[], deps: SkillDeps): Promise<number> {
  const sub = args[0];
  // `wego skill --help`/`-h`/`help` prints usage on stdout with exit 0 (CLI-3).
  if (isHelpArg(args)) {
    deps.log(SKILL_USAGE);
    return 0;
  }
  let opts: SkillOptions;
  try {
    // Inside the try because `list` reads the overlay, so it can fail.
    if (sub === "list") {
      await list(deps, args.slice(1));
      return 0;
    }
    opts = parseSkillArgs(args.slice(1));
  } catch (err) {
    deps.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  try {
    switch (sub) {
      case "install":
        // `--owned-only` is the CLI surface of the `refreshOnly` dep: same
        // target selection, same never-create rule, one implementation.
        return await install(
          opts.ownedOnly ? { ...deps, refreshOnly: true } : deps,
          opts,
        );
      case "path":
        return printPath(deps, opts);
      case "uninstall":
        return await uninstall(deps, opts);
      default:
        deps.error(
          sub
            ? `Unknown skill sub-command: ${sub}\n${SKILL_USAGE}`
            : SKILL_USAGE,
        );
        return 1;
    }
  } catch (err) {
    // `resolveSkill` throws on an unknown / ambiguous id — surface it as a usage
    // error (exit 1) rather than an unhandled rejection.
    deps.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
