import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function unquote(value: string): string {
  const quoted =
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")));
  return quoted ? value.slice(1, -1) : value;
}

function parseLine(raw: string): [string, string] | null {
  const line = raw.trim();
  if (line === "" || line.startsWith("#")) return null;
  const body = line.startsWith("export ") ? line.slice(7).trim() : line;
  const eq = body.indexOf("=");
  if (eq <= 0) return null;
  const key = body.slice(0, eq).trim();
  if (!KEY_RE.test(key)) return null;
  return [key, unquote(body.slice(eq + 1).trim())];
}

/**
 * Minimal `.env`-format parser: `KEY=VALUE` per line, `#` comment lines and
 * blanks skipped, an optional leading `export `, and surrounding single/double
 * quotes stripped from the value. Does not expand `$VAR` (Bun's autoloader
 * does): the CLI's own vars don't need it, and anything that would rely on
 * expansion is better set as a real shell env var, which always wins (see
 * `loadSourceEnvLocal`).
 */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const entry = parseLine(raw);
    if (entry) out[entry[0]] = entry[1];
  }
  return out;
}

/**
 * Load the repo's `.env.local` into `process.env` for a from-source run, so the
 * source `wego` is configured from any cwd and any shell, interactive or not,
 * without depending on direnv or Bun's cwd-relative autoload. An agent or
 * script shelling out non-interactively would otherwise hit "env not loaded"
 * failures such as `WEGO_CLI_CLIENT_ID` unset.
 *
 * The file is resolved relative to this module (`src/../.env.local`), never
 * relative to cwd. A compiled binary has no such sibling on the real filesystem
 * (`import.meta.dir` points into the embedded fs), so this is a no-op there and
 * the baked config stands.
 *
 * A key already present in `env` is never overwritten, so a real shell env var
 * (or a value direnv already exported) still wins over the file.
 */
export function loadSourceEnvLocal(
  envLocalPath: string = join(import.meta.dir, "..", ".env.local"),
  env: Record<string, string | undefined> = process.env,
): { loaded: boolean; path: string; keys: string[] } {
  if (!existsSync(envLocalPath)) {
    return { loaded: false, path: envLocalPath, keys: [] };
  }
  const parsed = parseDotenv(readFileSync(envLocalPath, "utf8"));
  const applied: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) {
      env[key] = value;
      applied.push(key);
    }
  }
  return { loaded: true, path: envLocalPath, keys: applied };
}
