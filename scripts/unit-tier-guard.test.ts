/**
 * A unit test never asserts on a command's stdout, stderr or exit code: those
 * belong to the integration tier, which runs the compiled binary as its own
 * process against a contract-checked fake (`integration/`).
 *
 * Enforced by what a unit test may import. A command's output only exists once
 * the command runs, so a unit test that cannot reach a command entry point cannot
 * assert on its output. What stays reachable is what unit tests are for: the
 * parsers that turn argv into API-call arguments, the HTTP client, and pure logic.
 *
 * `skill`, `update` and `uninstall` are left out on purpose. They act on the
 * installed binary and the user's file system, which the release's artifact checks
 * exercise on real installs (`install-smoke.sh`, `update-smoke.sh`,
 * `upgrade-path.sh`), so their handlers keep in-process tests with injected file
 * systems.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
/** This file names every way in, as strings, to prove it catches them. */
const SELF = fileURLToPath(import.meta.url);

/** module (relative to src/) → the command entry points it exports. */
const ENTRY_POINTS: Record<string, string[]> = {
  index: ["run"],
  commands: [
    "login",
    "whoami",
    "places",
    "info",
    "feedback",
    "flights",
    "hotels",
    "logout",
  ],
  "config-command": ["config"],
  "telemetry-command": ["telemetry"],
};

function unitTestFiles(): string[] {
  const out: string[] = [];
  for (const dir of ["src", "scripts"]) {
    const walk = (d: string) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const path = join(d, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".test.ts") && path !== SELF) {
          out.push(path);
        }
      }
    };
    walk(join(ROOT, dir));
  }
  return out.sort();
}

/** Every module a test file pulls in: the static clause (`undefined` for a
 *  dynamic `import()` or `require`, which can reach any export) and the specifier. */
export function imports(
  source: string,
): { clause: string | undefined; spec: string }[] {
  const found: { clause: string | undefined; spec: string }[] = [];
  const staticRe =
    /\b(?:import|export)\s+([^;"'`]*?)\s*from\s*["']([^"']+)["']/g;
  for (const m of source.matchAll(staticRe)) {
    found.push({ clause: (m[1] ?? "").trim(), spec: m[2] ?? "" });
  }
  const bareRe = /\bimport\s*["']([^"']+)["']/g;
  for (const m of source.matchAll(bareRe)) {
    found.push({ clause: "", spec: m[1] ?? "" });
  }
  const dynamicRe = /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of source.matchAll(dynamicRe)) {
    found.push({ clause: undefined, spec: m[1] ?? "" });
  }
  return found;
}

/** `{ a, type B, c as d }` → the value names it imports. */
function namedImports(clause: string): string[] {
  const names: string[] = [];
  for (const raw of (/\{([^}]*)\}/.exec(clause)?.[1] ?? "").split(",")) {
    const name = raw.trim();
    if (!name || name.startsWith("type ")) continue;
    names.push(name.split(/\s+as\s+/)[0]?.trim() ?? name);
  }
  return names;
}

/** The `src/` module a specifier names from `file`, whatever the directory depth
 *  and extension: `../commands` from `src/testing/x.test.ts` is `commands`. */
function srcModule(file: string, spec: string): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  const resolved = posix
    .normalize(posix.join(posix.dirname(file.replaceAll("\\", "/")), spec))
    .replace(/\.(ts|js)$/, "");
  return resolved.startsWith("src/")
    ? resolved.slice("src/".length)
    : undefined;
}

/** `path` is relative to the repository root, so a specifier resolves from it. */
export function violations(path: string, source: string): string[] {
  const found: string[] = [];
  for (const { clause, spec } of imports(source)) {
    const module = srcModule(path, spec);
    const entries = module ? ENTRY_POINTS[module] : undefined;
    if (!module || !entries || clause?.startsWith("type ")) continue;
    // A namespace, default, bare or dynamic import reaches every export.
    if (clause === undefined || !/^\{[^}]*\}$/.test(clause)) {
      found.push(`${path} imports all of ${module}`);
      continue;
    }
    for (const name of namedImports(clause)) {
      if (entries.includes(name))
        found.push(`${path} imports ${name} from ${module}`);
    }
  }
  if (/testing\/cli-runner/.test(source)) {
    found.push(`${path} imports the in-process CLI runner`);
  }
  if (/spawn\([^)]*src\/index\.ts/s.test(source)) {
    found.push(`${path} spawns src/index.ts`);
  }
  return found;
}

describe("unit tests stay below the command boundary", () => {
  it("no unit test reaches a command entry point", () => {
    const found = unitTestFiles().flatMap((file) =>
      violations(relative(ROOT, file), readFileSync(file, "utf8")),
    );
    expect(found).toEqual([]);
  });

  it("catches each way in", () => {
    expect(
      violations(
        "src/x.test.ts",
        [
          'import { run } from "./index";',
          'import { parseLoginArgs, login as doLogin } from "./commands";',
          'import { config } from "./config-command";',
          'import { runCli } from "./testing/cli-runner";',
          'import * as cmd from "./commands";',
          'const t = await import("./telemetry-command");',
          'import { hotels } from "./commands.ts";',
        ].join("\n"),
      ),
    ).toEqual([
      "src/x.test.ts imports run from index",
      "src/x.test.ts imports login from commands",
      "src/x.test.ts imports config from config-command",
      "src/x.test.ts imports all of commands",
      "src/x.test.ts imports hotels from commands",
      "src/x.test.ts imports all of telemetry-command",
      "src/x.test.ts imports the in-process CLI runner",
    ]);
    // From any directory depth.
    expect(
      violations(
        "src/testing/x.test.ts",
        'import { whoami } from "../commands";',
      ),
    ).toEqual(["src/testing/x.test.ts imports whoami from commands"]);
    expect(
      violations(
        "scripts/sub/x.test.ts",
        'import { run } from "../../src/index";',
      ),
    ).toEqual(["scripts/sub/x.test.ts imports run from index"]);
  });

  it("lets a parser and a type through", () => {
    expect(
      violations(
        "src/x.test.ts",
        [
          'import { type FlightsDeps, parseFlightSearchArgs } from "./commands";',
          'import type * as Commands from "./commands";',
          'import { run } from "./other/index";',
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});
