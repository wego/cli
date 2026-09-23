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
import { join, relative } from "node:path";
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

/** `import { a, type B, c as d } from "<spec>"` → the imported names. */
export function importedNames(source: string, spec: RegExp): string[] {
  const names: string[] = [];
  const re = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)"/g;
  for (const m of source.matchAll(re)) {
    if (!spec.test(m[2] ?? "")) continue;
    for (const raw of (m[1] ?? "").split(",")) {
      const name = raw.trim();
      if (!name || name.startsWith("type ")) continue;
      names.push(name.split(/\s+as\s+/)[0]?.trim() ?? name);
    }
  }
  return names;
}

export function violations(path: string, source: string): string[] {
  const found: string[] = [];
  for (const [module, entries] of Object.entries(ENTRY_POINTS)) {
    const spec = new RegExp(`^(\\./|\\.\\./src/)${module}$`);
    for (const name of importedNames(source, spec)) {
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
        "x.test.ts",
        [
          'import { run } from "./index";',
          'import { parseLoginArgs, login as doLogin } from "./commands";',
          'import { config } from "./config-command";',
          'import { runCli } from "./testing/cli-runner";',
        ].join("\n"),
      ),
    ).toEqual([
      "x.test.ts imports run from index",
      "x.test.ts imports login from commands",
      "x.test.ts imports config from config-command",
      "x.test.ts imports the in-process CLI runner",
    ]);
  });

  it("lets a parser and a type through", () => {
    expect(
      violations(
        "x.test.ts",
        'import { type FlightsDeps, parseFlightSearchArgs } from "./commands";',
      ),
    ).toEqual([]);
  });
});
