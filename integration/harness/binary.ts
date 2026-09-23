/**
 * The binary this suite drives: the one it is handed, or one it compiles.
 *
 * `WEGO_INTEGRATION_BINARY` names an already-built binary, which is how the release
 * run tests the exact artifact it is about to publish, on each target's own runner.
 * Without it, the host binary is compiled from this checkout, the way a pull request
 * and a developer run it. Either way the suite drives a single-file binary as its
 * own process: its argv parsing, exit codes and stream split are what an agent
 * depends on, and no in-process test sees them.
 *
 * A compiled binary bakes nothing (`--env 'WEGO_BUILD_*'` is not passed), so it
 * reports `0.0.0-dev`. Every endpoint comes from the runtime env `wego.ts` sets.
 */

import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  mkdtempSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const BINARY_ENV = "WEGO_INTEGRATION_BINARY";

const CLI_DIR = fileURLToPath(new URL("../../", import.meta.url));

/** A cold `bun build --compile` is slow, not unbounded. */
const COMPILE_TIMEOUT_MS = 180_000;

function checkProvided(path: string): string {
  let isFile = false;
  try {
    isFile = statSync(path).isFile();
  } catch {
    throw new Error(`${BINARY_ENV}=${path} does not exist`);
  }
  if (!isFile) throw new Error(`${BINARY_ENV}=${path} is not a file`);
  if (process.platform !== "win32") {
    try {
      accessSync(path, constants.X_OK);
    } catch {
      throw new Error(`${BINARY_ENV}=${path} is not executable`);
    }
  }
  return path;
}

async function compileHost(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "wego-integration-bin-"));
  const path = join(dir, process.platform === "win32" ? "wego.exe" : "wego");
  // `process.execPath` pins the compiler to the Bun running this suite. stdout is
  // ignored, not piped: only stderr is drained, and a full pipe would block.
  const build = Bun.spawn(
    [
      process.execPath,
      "build",
      "--compile",
      "--no-compile-autoload-dotenv",
      "--outfile",
      path,
      "./src/index.ts",
    ],
    { cwd: CLI_DIR, stdout: "ignore", stderr: "pipe" },
  );
  const timer = setTimeout(() => build.kill(), COMPILE_TIMEOUT_MS);
  const [stderr, code] = await Promise.all([
    new Response(build.stderr).text(),
    build.exited,
  ]);
  clearTimeout(timer);
  if (code !== 0) {
    throw new Error(`compiling the host binary failed (${code}):\n${stderr}`);
  }
  return path;
}

/** A binary names itself after its file (`program-name.ts`), and a release asset is
 *  `wego-linux-x64`. Installed, it is `wego`, so the suite drives a copy by that
 *  name: what a user's help and usage lines actually say. */
function installAsWego(provided: string): string {
  const dir = mkdtempSync(join(tmpdir(), "wego-integration-bin-"));
  const path = join(dir, process.platform === "win32" ? "wego.exe" : "wego");
  copyFileSync(provided, path);
  chmodSync(path, 0o755);
  return path;
}

/** The binary's path, compiled at most once per `bun test` run. */
export async function resolveBinary(): Promise<string> {
  const provided = process.env[BINARY_ENV]?.trim();
  const path = provided
    ? installAsWego(checkProvided(provided))
    : await compileHost();
  process.env[BINARY_ENV] = path;
  return path;
}

/** For scenario files: the path `preload.ts` resolved. */
export function binaryPath(): string {
  const path = process.env[BINARY_ENV];
  if (!path) {
    throw new Error(
      "no binary: run through `bun run test:integration`, which preloads integration/harness/preload.ts",
    );
  }
  return path;
}
