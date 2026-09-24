/**
 * The binary this suite drives: the one it is handed, or one it compiles.
 *
 * `WEGO_INTEGRATION_BINARY` names an already-built binary, which is how the release
 * run tests the exact artifact it is about to publish, on each target's own runner.
 * Without it, the host binary is compiled from this checkout, the way a pull request
 * and a developer run it. With `WEGO_INTEGRATION_MANIFEST` also set, the provided
 * binary must match its line in that `SHA256SUMS.txt` before it runs. Either way the suite drives a single-file binary as its
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
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BINARY_ENV = "WEGO_INTEGRATION_BINARY";
/** The release run's `SHA256SUMS.txt`, which a provided binary must match. */
export const MANIFEST_ENV = "WEGO_INTEGRATION_MANIFEST";

const CLI_DIR = fileURLToPath(new URL("../../", import.meta.url));

/** A cold `bun build --compile` is slow, not unbounded. */
const COMPILE_TIMEOUT_MS = 180_000;

/** Each directory holds a full single-file binary, so it lives only as long as the
 *  `bun test` process that made it; otherwise a developer's tmpdir keeps one per run. */
function binaryDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wego-integration-bin-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

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
  const manifest = process.env[MANIFEST_ENV]?.trim();
  if (manifest) checkAgainstManifest(path, manifest);
  return path;
}

/** Verify-then-execute: a provided binary arrived over an artifact hop, so it runs
 *  only once its bytes match the `SHA256SUMS.txt` line for its file name. */
export function checkAgainstManifest(path: string, manifest: string): void {
  const name = basename(path);
  const line = readFileSync(manifest, "utf8")
    .split(/\r?\n/)
    .map((l) => /^([0-9a-f]{64})\s+\*?(.+)$/.exec(l.trim()))
    .find((m) => m?.[2] === name);
  if (!line) throw new Error(`${manifest} lists no ${name}`);
  const actual = new Bun.CryptoHasher("sha256")
    .update(readFileSync(path))
    .digest("hex");
  if (actual !== line[1]) {
    throw new Error(
      `${name} does not match ${manifest}: sha256 ${actual}, expected ${line[1]}`,
    );
  }
}

async function compileHost(): Promise<string> {
  const dir = binaryDir();
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
  const dir = binaryDir();
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
