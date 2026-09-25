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

/** Recorded in the ownership marker to tell "wego wrote this" from "the operator
 *  edited it". */
async function sha256Hex(body: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(body);
  return hasher.digest("hex");
}

/**
 * `wego skill`: discover, install and manage the agent SKILL.md that teaches a
 * coding agent to drive this CLI.
 *
 *  - The installable skills live in the `SKILLS` registry (`skill-embed.ts`).
 *    install/path/uninstall take an optional `<skill-id>` that defaults to the
 *    sole registered skill. The install dir leaf is the skill `id`.
 *  - `install` can take a verified body from a remote channel through the
 *    injected `fetchRemoteSkill`, falling back to the embedded copy. `index.ts`
 *    wires no channel, so the embedded copy is what ships.
 *  - An agent path table maps each agent to its skills dir, so a project install
 *    lands in `.claude/skills/<id>` and the shared `.agents/skills/<id>`.
 *    Multi-target installs are best-effort.
 *
 * Written against injected deps so the flows are unit-testable without touching
 * the real home dir, the network or a prompt.
 */

export interface SkillIo {
  log: (message: string) => void;
  error: (message: string) => void;
}

export interface SkillDeps extends SkillIo {
  /** Injected so a test can use a multi-entry registry, which reaches
   *  `resolveSkill`'s no-id-with-many branch that the single shipped skill
   *  cannot. */
  skills: readonly SkillEntry[];
  version: string;
  /** The release ring this install follows (`ring-follow.ts`), stamped into the
   *  ownership marker so another channel's install can tell the skill is not its
   *  to maintain. `undefined` on a pre-ring install or from source: the marker
   *  then names no ring and readers behave as they did before rings. */
  ring?: string;
  /** The base for user scope (`~/.claude/skills/wego`). */
  homedir: () => string;
  /** The base for project scope (`./.claude/skills/wego`). */
  cwd: () => string;
  /** Bypassed by `-y`/`--yes`. */
  confirm: (question: string) => Promise<boolean>;
  /** The skill channel base: the baked store origin plus the ring recorded on
   *  this machine (`skillBaseForRing` in `ring-follow.ts`). Not baked whole
   *  because a promote moves a pointer over the same bytes, so a channel compiled
   *  into the binary is wrong on one side of every promote. `undefined` means
   *  `install` uses the embedded copy. `install` fetches `<base>/<id>/…`. */
  skillUrl?: string;
  /** Returns the verified canonical body, or `null` on any failure (embedded
   *  fallback). Absent means always embedded. `install` treats a rejection as a
   *  failure too, so a down remote can never fail the install. */
  fetchRemoteSkill?: (baseUrl: string, id: string) => Promise<string | null>;
  /** Treat an unverifiable remote body as "do nothing" instead of falling back to
   *  the embedded copy. Off for the foreground `skill install`, where a fresh
   *  install needs some body and must not fail on a down remote. On for a
   *  background refresh, where the existing body may be newer than the embedded
   *  one (an earlier refresh can have pulled a published body postdating this
   *  binary). Falling back there would silently downgrade it and, because the
   *  throttle stamp is already written, leave it downgraded for 24h. */
  requireRemote?: boolean;
  /** Update only dirs that already carry an ownership marker; never create a new
   *  target. Independent of `requireRemote`, though a background refresh sets
   *  both.
   *
   *  Ownership gates whether a refresh runs, but `resolveTargets` re-runs
   *  auto-detect to decide where. Without this flag, a `~/.codex` created after a
   *  Claude-only install would silently get a skill and a marker on the next
   *  refresh, for an agent the user never ran `skill install` for. The
   *  foreground install must keep creating targets. */
  refreshOnly?: boolean;
}

type Scope = "user" | "project";
const SCOPES: ReadonlySet<Scope> = new Set<Scope>(["user", "project"]);
function isScope(value: string): value is Scope {
  return (SCOPES as ReadonlySet<string>).has(value);
}

interface SkillOptions {
  skillId?: string;
  /** `user` = global (`~/…`); `project` = cwd-relative. */
  scope: Scope;
  /** `["*"]` = every agent in the table; `[]` = auto-detect. */
  agents: string[];
  /** Override the skills root (`<dir>/<leaf>` is written), ignoring agent/scope. */
  dir?: string;
  yes: boolean;
  force: boolean;
  embedded: boolean;
  /** `--owned-only`: only refresh skill folders wego already owns; never create
   *  one.
   *
   *  How `update` re-installs the skill after it swaps the binary: the install
   *  must update what this machine already has rather than auto-detect agent
   *  dirs and install into ones the user never asked for. Maps onto the
   *  `refreshOnly` dep so the target selection and the never-create rule have
   *  one implementation. */
  ownedOnly: boolean;
  /** `--keep-local-edits`: skip a wego-owned `SKILL.md` that has been edited
   *  since wego wrote it, instead of replacing it.
   *
   *  A foreground install is not always attended. The `curl | bash` installer
   *  runs the same foreground path with no TTY and nobody reading stdout, so
   *  without this it could silently discard an edit on any re-run. This flag
   *  gives that caller the edit protection without `refreshOnly`'s never-create
   *  rule, which the installer cannot take on a clean machine. */
  keepLocalEdits: boolean;
}

// Resolved once so the usage lines name the command the user typed (`wego`,
// `wegostaging` or a renamed binary).
const PROG = programName();

/**
 * `global` is relative to `~`; `project` is relative to cwd.
 * Codex/Cursor/OpenCode/Cline share the project-scope `.agents/skills` dir, so a
 * multi-agent project install collapses to `.claude/skills` + `.agents/skills`.
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

// A sibling ownership marker that answers two separate questions.
//
// Ownership is presence-only: present means wego wrote the dir, so an upgrade may
// overwrite it; absent next to a SKILL.md means a foreign or hand-written file we
// refuse to overwrite without --force. That check never reads the file. It is
// accident prevention, deliberately forgeable, not a security control.
//
// The content holds the SHA256 of the body wego last wrote (`stampOwnerMarker`),
// which `localEditState` compares with the file on disk to tell "wego wrote this"
// from "a human edited it". An unattended caller needs that before it can safely
// overwrite.
//
// The legacy `.wego-skill-version` name is still honored on read so those dirs
// are not seen as foreign. It predates the content baseline, so it reads as
// `"unknown"` (see `localEditState`).
const MARKER_NAME = ".wego-skill-owner";
const LEGACY_MARKER_NAME = ".wego-skill-version";

/** Both marker filenames, current first. Exported so other code checks the same
 *  file this module treats as proof of ownership rather than hard-coding a
 *  second copy of the names. */
export const MARKER_NAMES = [MARKER_NAME, LEGACY_MARKER_NAME] as const;

const VALUE_FLAGS = new Set(["--scope", "--agent", "--dir"]);

// A table rather than a branch per flag keeps `parseSkillArgs` under the
// cognitive-complexity gate.
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

/** Throws when the value is missing, empty or looks like another flag. */
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

/** Returns the number of argv items consumed: 1 for `--flag=value`, 2 for
 *  `--flag value`. Separate from `parseSkillArgs` to keep that loop under the
 *  cognitive-complexity gate. */
function consumeValueFlag(
  opts: SkillOptions,
  arg: string,
  next: string | undefined,
): number {
  const eq = arg.indexOf("=");
  const name = (eq === -1 ? arg : arg.slice(0, eq)).replace(/^-a$/, "--agent");
  if (!VALUE_FLAGS.has(name)) {
    throw new Error(`Unknown option: ${name}\n${SKILL_USAGE}`);
  }
  const inline = eq === -1 ? undefined : arg.slice(eq + 1);
  assignSkillFlag(opts, name, flagValue(name, inline, next));
  return inline === undefined ? 2 : 1;
}

/** `args` is everything after `<sub>`. Throws a usage `Error` on an unknown
 *  flag, a missing value, a bad scope or a second positional. */
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

/** With no id, the sole registered skill; with more than one registered, a usage
 *  error. Only an injected test registry reaches that branch today. */
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

/**
 * Every user-scope dir a default `skill install` would write to on this machine
 * (the same auto-detect as `selectedAgents`).
 *
 * A background refresh must watch exactly what the installer writes.
 * `defaultUserSkillDir` is only correct on a Claude machine: a Codex-only user,
 * say, has no `~/.claude/skills/wego`, so gating a refresh on the Claude marker
 * would report "not owned" forever and never update that install.
 */
export function autoDetectedUserSkillDirs(home: string): string[] {
  const detected = AGENT_NAMES.filter((a) =>
    existsSync(join(home, dirname(AGENTS[a].global))),
  );
  const agents = detected.length > 0 ? detected : ["claude"];
  const roots = new Set(agents.map((a) => join(home, AGENTS[a].global)));
  return [...roots].map((root) => join(root, SHIPPED_SKILL_ID));
}

/** Claude-only, because `uninstall` is deliberately conservative: removal should
 *  not sweep every detected agent's global dir. Exported so `index.ts` builds
 *  `wego uninstall`'s summary path from the same leaf the removal uses. */
export function defaultUserSkillDir(home: string): string {
  return join(home, ".claude", "skills", SHIPPED_SKILL_ID);
}

function agentRoot(deps: SkillDeps, opts: SkillOptions, agent: string): string {
  const dirs = AGENTS[agent];
  return opts.scope === "user"
    ? join(deps.homedir(), dirs.global)
    : join(deps.cwd(), dirs.project);
}

/** With no explicit agents: a project install targets Claude plus the shared
 *  `.agents` family. A user install auto-detects agents whose home config dir
 *  exists (so a non-Cursor user gets no `~/.cursor`), defaulting to Claude. */
function selectedAgents(
  deps: SkillDeps,
  opts: SkillOptions,
  forUninstall: boolean,
): string[] {
  if (opts.agents.includes("*")) return AGENT_NAMES;
  if (opts.agents.length > 0) return [...new Set(opts.agents)];
  // A project uninstall mirrors the project install's targets, or it would orphan
  // the `.agents/skills/<id>` copy. A user uninstall stays Claude-only so
  // `wego uninstall` never sweeps every auto-detected agent's global dir.
  if (opts.scope === "project") return ["claude", "codex"];
  if (forUninstall) return ["claude"];
  const detected = AGENT_NAMES.filter((a) =>
    existsSync(join(deps.homedir(), dirname(AGENTS[a].global))),
  );
  return detected.length > 0 ? detected : ["claude"];
}

/** Deduped by root, so the `.agents/skills` family collapses to one target. */
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

/** `null` only for `ENOENT`; any other read error propagates. A present but
 *  unreadable `SKILL.md` must not look absent: `installOne` gates its overwrite
 *  protections on `existing !== null`, and `rename` would replace the file
 *  regardless of its own permissions (only the directory's matter). Every
 *  caller reports a throw as a per-target failure, which preserves the file.
 *  `markerBaseline` swallows explicitly because it wants unreadable folded into
 *  "unknown". */
async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}

/** Presence-only: ownership never depends on the contents, so a marker written
 *  by any older binary still reads as ours. */
function hasOwnerMarker(dir: string): boolean {
  return (
    existsSync(join(dir, MARKER_NAME)) ||
    existsSync(join(dir, LEGACY_MARKER_NAME))
  );
}

/**
 * The SHA256 the marker records for the body wego last wrote, or `null` when
 * there is no baseline (no marker, a legacy or contentless one, or unreadable).
 *
 * Separate from ownership: ownership answers "may we write here", the baseline
 * answers "would writing destroy something the operator typed". A missing
 * baseline means "unknown", not a failure.
 */
async function markerBaseline(dir: string): Promise<string | null> {
  let raw: string | null;
  try {
    raw = await readIfExists(join(dir, MARKER_NAME));
  } catch {
    // Unlike SKILL.md, an unreadable marker is treated as missing: it is a
    // heuristic signal, not the content an overwrite would destroy.
    return null;
  }
  // First line only: the marker can carry `ring=` and `source=` lines, and
  // matching the whole body would read every such marker as "no baseline",
  // disabling local-edit detection for those installs.
  const hex = raw?.split("\n", 1)[0]?.trim().toLowerCase();
  return hex !== undefined && /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

/**
 * Stamp the current marker with `content`'s digest and remove any legacy marker
 * in the same dir.
 *
 * A background refresh watches both names and takes the oldest mtime, so a
 * legacy marker left behind stays stale forever and keeps the throttle window
 * open: `skill install --embedded` would be followed by the next command pulling
 * the remote body over it. Removing rather than restamping, because two files
 * recording one fact invites a write that updates only one. The cost: a rollback
 * to a pre-rename binary no longer recognises the dir, but it fails loudly with
 * the "re-run with --force" message.
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

/** The marker's optional line naming which release ring's install wrote this
 *  skill. Prefixed so the line says what it is and a later line cannot be
 *  mistaken for it. */
const MARKER_RING_PREFIX = "ring=";

/**
 * The marker's optional line naming where the body came from: a ring name when
 * it was fetched and verified from that channel, or `embedded` for this binary's
 * own copy.
 *
 * Separate from `ring=`, which records which ring owns the dir. A `stable`
 * install that fell back to its embedded copy owns the dir as `stable` while the
 * body came from the binary. The install message reports this one, because it
 * answers "which body is this".
 */
const MARKER_SOURCE_PREFIX = "source=";

/** `null` when the marker names no source (markers from older binaries). */
export function markerSource(raw: string | null): string | null {
  const line = raw
    ?.split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith(MARKER_SOURCE_PREFIX));
  return line?.slice(MARKER_SOURCE_PREFIX.length).trim() || null;
}

/**
 * `null` when the marker names no ring (a pre-ring marker is one bare digest
 * line). That is not a refusal: only a marker that names a different ring is
 * evidence of another channel's ownership.
 */
export function markerRing(raw: string | null): string | null {
  const line = raw
    ?.split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith(MARKER_RING_PREFIX));
  // An empty or whitespace-only ring means "names none", same as no line.
  return line?.slice(MARKER_RING_PREFIX.length).trim() || null;
}

/**
 * Whether `dir`'s `SKILL.md` still holds exactly the bytes wego last wrote.
 *
 * `"unknown"` covers every dir installed before markers carried a baseline, and
 * any unreadable file. It is undecidable, so the two unattended callers answer
 * it differently (see `unattendedSkipReason`).
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
 * Write via a sibling temp file and `rename`, which is atomic within a
 * directory. A crash or SIGINT mid-write cannot leave a truncated `SKILL.md`
 * (a background refresh stamps its throttle marker before writing, so a corrupt
 * body would persist for 24h), and two concurrent `wego` processes interleave
 * per file rather than per byte. The pid in the temp name keeps them off each
 * other's temp file.
 */
async function writeFileAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.tmp.${process.pid}`;
  try {
    // `wx` (create-exclusive) fails if the path exists and does not follow a
    // symlink. The pid-based temp name is guessable, so a pre-created symlink
    // could otherwise redirect the body. That needs write access to the user's
    // own skill dir, so this is hardening rather than a fix, but it costs
    // nothing. It also surfaces a leftover temp from a killed run instead of
    // reusing it.
    await writeFile(tmp, content, { flag: "wx" });
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** The verified remote copy when a channel is configured and `--embedded` was not
 *  passed, else the embedded copy. The body is written as published, with no
 *  local rewrite between verification and the write. */
async function resolveInstallBody(
  deps: SkillDeps,
  entry: SkillEntry,
  opts: SkillOptions,
): Promise<{ body: string; verified: boolean } | null> {
  let canonical: string | null = null;
  if (!opts.embedded && deps.skillUrl && deps.fetchRemoteSkill) {
    // "Install never fails on a down remote" is enforced here rather than trusted
    // to the injected resolver: one that rejects instead of returning null would
    // otherwise turn a down remote into a hard install failure.
    try {
      canonical = await deps.fetchRemoteSkill(deps.skillUrl, entry.id);
    } catch {
      canonical = null;
    }
  }
  // `requireRemote` stops here rather than downgrade an existing, possibly newer
  // file to the embedded copy. The foreground install may be creating the file
  // from nothing, so it keeps the fallback.
  if (canonical === null && deps.requireRemote) return null;
  // The caller needs the body's origin per target: creating a file from nothing
  // should use the embedded copy, while replacing an existing one with it may be
  // a downgrade (an earlier refresh can have installed a newer published body).
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
 * Why an unattended caller must leave an existing `SKILL.md` alone, or `null` to
 * write it. The three rules share one precondition (unattended, no `--force`)
 * and each answers a different "is overwriting safe?" question about the same
 * file.
 *
 * "Unattended" is not "background". A `skill install` a user typed is the
 * request for the canonical body and prints what it did, so it overwrites. The
 * `curl | bash` installer runs the same foreground path with nobody watching, so
 * it passes `--keep-local-edits`.
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

  // 1. A visible hand edit. The silent path leaves no diff, backup or log line,
  //    so the edit would just be gone. Ownership says we may write; it does not
  //    say the current bytes are ours to discard.
  if (edit === "modified") {
    return `${file} has local modifications – left alone. Run \`${programName()} skill install --force\` to replace it with the published copy.`;
  }

  // 2. A hand edit we cannot see. `"unknown"` means the dir predates the content
  //    baseline, so "is this an edit?" is undecidable, and the two unattended
  //    callers answer it differently.
  //
  //    The silent refresh (`refreshOnly`) preserves it: a machine can hold a
  //    hand-edited body under a baseline-less marker, and destroying it would be
  //    unrecoverable.
  //
  //    The installer (`--keep-local-edits` alone) still overwrites and so writes
  //    a baseline. Nothing else ever does for a pre-marker install, so if the
  //    installer preserved it too, the refresh would skip that machine forever.
  //    The installer is a deliberate act, so one loud overwrite there is
  //    acceptable.
  if (edit === "unknown" && deps.refreshOnly === true) {
    return `${file} predates the content baseline – left alone. Run \`${programName()} skill install\` to adopt it.`;
  }

  // 3. Not an edit, but writing would still lose content: a channel is
  //    configured, its fetch failed, and the fallback is the binary's embed over
  //    an existing file. An earlier refresh may have installed a newer published
  //    body, so writing would downgrade it. The installer cannot use
  //    `requireRemote`'s all-or-nothing because on a clean machine it must still
  //    create the file, hence this per-target check.
  //
  //    Only with a configured channel: `verified` is also false when the embed is
  //    the only possible source, as in the wiring `index.ts` ships. Then nothing
  //    on disk can be newer than the embed, and without this scoping the
  //    post-update refresh could never write.
  const channelConfigured =
    deps.skillUrl !== undefined && deps.fetchRemoteSkill !== undefined;
  if (!verified && channelConfigured) {
    return `${file} left unchanged – could not verify the published copy, and the installed one may be newer than this binary's built-in copy.`;
  }
  return null;
}

/** Never throws: an fs error or a foreign-file refusal is a per-target failure,
 *  so the other targets still proceed. */
async function installOne(
  deps: SkillDeps,
  content: string,
  dir: string,
  opts: SkillOptions,
  verified: boolean,
): Promise<TargetOutcome> {
  const file = join(dir, "SKILL.md");
  // `remote` covers a verified body whose ring we cannot name. Real wiring never
  // produces it (`skillBaseForRing` yields no channel without a ring), but a
  // caller that injects `skillUrl` directly can, and inventing a ring name there
  // would claim more than we know.
  const source = verified ? (deps.ring ?? "remote") : "embedded";
  try {
    // `ok: true` because skipping is the correct outcome in refresh mode: a run
    // where every target is skipped should still exit 0.
    if (deps.refreshOnly && !hasOwnerMarker(dir)) {
      return { dir, ok: true, message: `${dir} not wego-owned – left alone.` };
    }
    // After the skip: the body is ~96KB and a refresh calls this for every
    // detected dir, so hashing first would waste a digest on skipped dirs.
    const digest = await sha256Hex(content);
    const existing = await readIfExists(file);
    if (existing === content) {
      // Nothing to write, but stamp the marker anyway: a marker-less file that
      // matches would otherwise be refused as foreign on the next body change,
      // and every later upgrade would need --force.
      //
      // Accepted tradeoff: a coincidental byte-match grants ownership of a dir
      // wego did not write. The bytes are exactly what install would write, the
      // marker is not a security control, and `uninstall` deletes only SKILL.md
      // and the markers, so adoption never widens what a removal touches.
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
    // Gated on `existing !== null` because every skip reason is about not losing
    // content already on disk; creating from nothing is never a loss.
    const edit = await localEditState(dir, existing);
    if (existing !== null) {
      const skip = unattendedSkipReason(deps, opts, file, edit, verified);
      if (skip !== null) return { dir, ok: true, message: skip };
    }
    await mkdir(dir, { recursive: true });
    await writeFileAtomic(file, content);
    await stampOwnerMarker(dir, content, deps.ring, source);
    return {
      dir,
      ok: true,
      // The order matters for an agent that just ran this mid-session: reading
      // the file works now, a restart is only needed for automatic discovery.
      //
      // The foreground command may overwrite an edit, but it must say so.
      //
      // Identifies the body by source and digest, not the binary's version:
      // `SKILL.md` carries no version, and the binary's says nothing about where
      // the body came from.
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

/** Best-effort: exits non-zero only when every target failed. A foreign target
 *  among successes is a warning, not a failure. */
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
    // Only reachable with `requireRemote`.
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
  // An explicit `--agent` asks where that agent's copy would go, installed or not.
  if (opts.agents.length > 0) {
    for (const dir of resolveTargets(deps, opts, leaf, false)) {
      deps.log(join(dir, "SKILL.md"));
    }
    return 0;
  }
  // With no selection, report where the skill actually is. The API's
  // agent-onboarding doc tells an agent to read the path this prints, so a path
  // that does not exist (Claude's, on a Codex-only machine) breaks onboarding
  // silently.
  //
  // Ownership is part of the filter: a dir can hold someone else's marker-less
  // `SKILL.md`, and reporting it would hand the agent unrelated instructions
  // while looking like it worked.
  const installed = resolveTargets(deps, opts, leaf, false).filter(
    (dir) => existsSync(join(dir, "SKILL.md")) && hasOwnerMarker(dir),
  );
  if (installed.length > 0) {
    for (const dir of installed) deps.log(join(dir, "SKILL.md"));
    return 0;
  }
  // Nothing owned anywhere: fall back to the conservative single target so the
  // pre-install "where would it land" answer stays deterministic, unless a
  // foreign file occupies it. Naming that file would undo the ownership filter
  // above.
  const fallback = resolveTargets(deps, opts, leaf, true);
  const foreign = fallback.filter(
    (dir) => existsSync(join(dir, "SKILL.md")) && !hasOwnerMarker(dir),
  );
  if (foreign.length > 0) {
    // stdout is the machine-readable answer and there is none, so it stays empty.
    // Exit 0 because `path` is documented as a non-failing lookup.
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

/** Never throws, so the other targets still proceed. */
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
    // Remove only what install writes, then the dir only if it is now empty: a
    // `--force`-adopted dir's other files are the user's.
    await rm(file, { force: true });
    await rm(join(dir, MARKER_NAME), { force: true });
    await rm(join(dir, LEGACY_MARKER_NAME), { force: true });
    // Checked explicitly rather than rm-and-swallow so a real fs error (EACCES)
    // propagates instead of looking like "adopted files remain".
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

export async function skill(args: string[], deps: SkillDeps): Promise<number> {
  const sub = args[0];
  if (isHelpArg(args)) {
    deps.log(SKILL_USAGE);
    return 0;
  }
  let opts: SkillOptions;
  try {
    // Inside the try because `list` throws on an unknown option.
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
    // `resolveSkill` throws on an unknown or ambiguous id.
    deps.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
