/**
 * The embedded skill only tells the agent to run what this binary has.
 *
 * `skills/wego/SKILL.md` is compiled into the binary and followed by the user's
 * coding agent. When a command or flag is renamed and the skill is not, the agent
 * is told to run something that fails, and nothing else here notices: the
 * scenarios test the CLI, the skill evals in wego-ai run per release and cost
 * money. This checks, for every `wego …` command the skill shows, that the
 * command answers `--help` and that each `--flag` it uses is in that help.
 *
 * It cannot tell whether the skill covers a new command; that is what the evals
 * measure.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeHome, wego } from "./harness/wego";

const SKILL = readFileSync(
  fileURLToPath(new URL("../skills/wego/SKILL.md", import.meta.url)),
  "utf8",
);

/** Every `wego …` command line the skill shows: continuation lines joined, a
 *  trailing `# comment` dropped, runs of spaces collapsed. Inline code ends at
 *  its backtick; a `|` inside `[--sort a|b]` does not end anything. */
export function skillCommands(markdown: string): string[] {
  const joined = markdown.replace(/\\\n\s*/g, " ");
  const found = new Set<string>();
  for (const m of joined.matchAll(/(?:^|[\s`(])(wego(?: [^`\n]+)?)/gm)) {
    const command = (m[1] ?? "")
      .replace(/\s#.*$/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (command !== "wego") found.add(command);
  }
  return [...found].sort();
}

/** The subcommand words at the front of a command: lowercase words before the
 *  first argument, placeholder, quote or flag. */
export function commandPath(command: string): string[] {
  const words = command.split(/\s+/).slice(1);
  const path: string[] = [];
  for (const word of words) {
    if (!/^[a-z][a-z-]*$/.test(word) || path.length === 2) break;
    path.push(word);
  }
  return path;
}

export function longFlags(command: string): string[] {
  return [...new Set(command.match(/(?<![\w-])--[a-z][a-z0-9-]*/g) ?? [])];
}

/** Whether `help` lists `flag` as a whole token, so `--page` is not found inside
 *  `--page-size`. */
function listsFlag(help: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w-])${escaped}(?![\\w-])`, "m").test(help);
}

const home = makeHome();
const helpCache = new Map<string, { code: number; out: string }>();

/** `wego <path> --help`, falling back to the parent when a word is an argument
 *  rather than a subcommand (`config set currency`, `places London`). The first
 *  word is never dropped: root help always answers, so falling back to it would
 *  pass a renamed top-level command. */
async function helpFor(
  path: string[],
): Promise<{ path: string[]; out: string } | undefined> {
  for (let n = path.length; n >= Math.min(1, path.length); n -= 1) {
    const candidate = path.slice(0, n);
    const key = candidate.join(" ");
    let result = helpCache.get(key);
    if (!result) {
      const r = await wego([...candidate, "--help"], { home });
      result = { code: r.code, out: r.out };
      helpCache.set(key, result);
    }
    if (result.code === 0 && result.out.includes("Usage:")) {
      return { path: candidate, out: result.out };
    }
  }
  return undefined;
}

describe("the skill matches the CLI", () => {
  const commands = skillCommands(SKILL);

  it("finds the commands the skill shows", () => {
    expect(commands.length).toBeGreaterThan(20);
  });

  for (const command of commands) {
    it(command, async () => {
      const help = await helpFor(commandPath(command));
      expect(help, `no \`--help\` answers for: ${command}`).toBeDefined();
      const missing = longFlags(command).filter(
        (flag) => flag !== "--help" && !listsFlag(help?.out ?? "", flag),
      );
      expect(
        missing,
        `skills/wego/SKILL.md tells the agent to run \`${command}\`, but \`wego ${help?.path.join(" ")} --help\` has no ${missing.join(", ")}`,
      ).toEqual([]);
    });
  }
});

describe("reading the skill", () => {
  it("joins continuation lines and stops at the end of inline code", () => {
    expect(
      skillCommands(
        "Run `wego places London --page 2` or:\n\n    wego flights search SIN BKK \\\n      --adults 2\n",
      ),
    ).toEqual([
      "wego flights search SIN BKK --adults 2",
      "wego places London --page 2",
    ]);
  });

  it("takes the subcommand words, not the arguments", () => {
    expect(commandPath('wego places "Heathrow" --page 2')).toEqual(["places"]);
    expect(commandPath("wego info holidays <country> [--from X]")).toEqual([
      "info",
      "holidays",
    ]);
    expect(commandPath("wego config set currency SAR")).toEqual([
      "config",
      "set",
    ]);
  });

  it("collects long flags only", () => {
    expect(longFlags("wego update -y --check [--locale en] --check")).toEqual([
      "--check",
      "--locale",
    ]);
  });

  it("finds a flag in help only as a whole token", () => {
    const help = "  --page-size <n>  Results per page\n  --types <list>";
    expect(listsFlag(help, "--page")).toBe(false);
    expect(listsFlag(help, "--type")).toBe(false);
    expect(listsFlag(help, "--page-size")).toBe(true);
    expect(listsFlag("--sort=price", "--sort")).toBe(true);
  });
});
