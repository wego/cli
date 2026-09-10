import { programName } from "./program-name";

const INDENT = "  ";
const COL = 28;
export const HELP_WIDTH = 100;

export type FlagLine = readonly [string, string, Iterable<string>?];

export interface UsageSpec {
  cmd: string;
  alt?: readonly string[];
  what: string;
  flags?: readonly FlagLine[];
  env?: readonly (readonly [string, string])[];
  note?: string;
  see?: string;
}

export function usage(spec: UsageSpec): string {
  const prog = programName();
  const flags = spec.flags ?? [];
  const env = spec.env ?? [];
  return [
    `Usage: ${prog} ${spec.cmd}${flags.length ? " [flags]" : ""}`,
    ...(spec.alt ?? []).map((alt) => `   or: ${prog} ${alt}`),
    spec.what,
    ...section(flags.flatMap(flagRow)),
    ...section(
      env.length ? ["Env:", ...env.flatMap(([n, t]) => row(n, t))] : [],
    ),
    ...section(spec.note ? wrap(spec.note, "") : []),
    ...section(
      spec.see
        ? [`Run ${prog} ${spec.see} --help for the other commands.`]
        : [],
    ),
  ].join("\n");
}

function section(lines: string[]): string[] {
  return lines.length ? ["", ...lines] : [];
}

function flagRow([flag, text, values]: FlagLine): string[] {
  const list = values ? [...values].join("|") : "";
  return row(flag, list && text ? `${list}. ${text}` : list || text);
}

export function group(
  name: string,
  what: string,
  subs: readonly (readonly [string, string])[],
): string {
  const prog = programName();
  const lines = [`Usage: ${prog} ${name} <command> [flags]`, what, ""];
  for (const [sub, text] of subs) lines.push(...row(sub, text));
  lines.push("", `Run ${prog} ${name} <command> --help for flags.`);
  return lines.join("\n");
}

export function usageErrorLabel(arg: string): string {
  return arg.startsWith("-") ? "Unknown option" : "Unexpected argument";
}

export function indexRow(name: string, text: string): string[] {
  return row(name, text);
}

function row(head: string, text: string): string[] {
  if (!text) return [INDENT + head];
  const body = wrap(text, INDENT + " ".repeat(COL));
  if (head.length <= COL - 2) {
    body[0] = INDENT + head.padEnd(COL) + body[0].trimStart();
    return body;
  }
  return [INDENT + head, ...body];
}

function wrap(text: string, indent: string): string[] {
  const pieces: { s: string; space: boolean }[] = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    word.split(/(?<=\|)/).forEach((s, i) => {
      pieces.push({ s, space: i === 0 });
    });
  }
  const out: string[] = [];
  let line = indent;
  let filled = false;
  for (const p of pieces) {
    const sep = filled && p.space ? " " : "";
    if (filled && line.length + sep.length + p.s.length > HELP_WIDTH) {
      out.push(line);
      line = indent + p.s;
    } else {
      line += sep + p.s;
    }
    filled = true;
  }
  out.push(line);
  return out;
}
