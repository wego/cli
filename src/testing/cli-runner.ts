/**
 * Run the real `wego` CLI as a subprocess (issue #1333).
 *
 * In-process `run(argv, deps)` forfeits the two things an agent actually depends
 * on — the exit code and the stdout/stderr split — so the e2e tiers spawn the
 * shipped entrypoint instead. `commands.test.ts` is the in-process tier and stays
 * as it is.
 *
 * Shared here rather than copied per suite: slices 4 and 5 add hotels and an
 * API-direct track against the same booted API.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_DIR = new URL("../../", import.meta.url).pathname;

export type CliResult = { code: number; out: string; err: string };

/** What `runCli` needs from a booted API — `BootedApi` satisfies it as-is, so the
 *  fixture handle can be passed straight through. */
export type CliTarget = {
  url: string;
  credentialsPath: string;
};

/**
 * One throwaway `$XDG_CONFIG_HOME` for the whole suite, so nothing the CLI writes
 * per-run lands in the developer's real `~/.config/<scope>/`.
 *
 * This is not belt-and-braces. `WEGO_CLI_TELEMETRY=0` suppresses the *send*, but
 * the analytics **session id is deliberately independent of the telemetry opt-out**
 * (`src/index.ts`: the session header is sent "whether or not" telemetry is on), so
 * `resolveSession` still writes `session.json` through `installConfigPath`, which
 * resolves `$XDG_CONFIG_HOME` before `~/.config`. Redirecting the base keeps the
 * session id — and therefore the real `X-Wego-Session-Id` request header — flowing
 * to the booted API, which is behaviour worth exercising, while writing it
 * somewhere disposable.
 */
const CONFIG_HOME = mkdtempSync(join(tmpdir(), "wego-cli-e2e-config-"));

/** The settings file the spawned CLI will read (issue #1386), inside the suite's
 *  throwaway config home. The config scope is the constant `wego`, from source and
 *  from a binary alike. */
const SETTINGS_PATH = join(CONFIG_HOME, "wego", "settings.json");

/**
 * Plant the user's travel preferences for the next `runCli` calls, so a suite can
 * prove the SHIPPED entrypoint reads the file — path resolution through
 * `buildRealDeps` is the one part no in-process test can cover.
 */
export function writeUserSettings(settings: Record<string, string>): void {
  mkdirSync(join(CONFIG_HOME, "wego"), { recursive: true, mode: 0o700 });
  writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, {
    mode: 0o600,
  });
}

/** Remove it again, so one settings-aware test cannot leak into the rest. */
export function clearUserSettings(): void {
  rmSync(SETTINGS_PATH, { force: true });
}

export async function runCli(
  args: string[],
  target: CliTarget,
  extraEnv: Record<string, string> = {},
): Promise<CliResult> {
  // `loadSourceEnvLocal` fills any key we leave unset from `apps/cli/.env.local`,
  // which would silently point the CLI at the configured dev API instead of the
  // one under test. Both keys are therefore always set explicitly.
  // Both, because both are what the comment above promises. An empty
  // credentialsPath would be backfilled from `.env.local` just as silently as an
  // empty url, and the CLI would read the developer's real credentials file.
  if (!target.url) throw new Error("runCli: target.url is required");
  if (!target.credentialsPath) {
    throw new Error("runCli: target.credentialsPath is required");
  }
  // `process.execPath`, not the bare name: PATH resolution could pick a DIFFERENT bun
  // from the one running this suite, and the child runs the CLI under test. An absolute
  // path also keeps the spawn independent of a writeable PATH entry (S4036).
  const proc = Bun.spawn([process.execPath, "src/index.ts", ...args], {
    cwd: CLI_DIR,
    env: {
      ...process.env,
      // Keep the background behaviours off the network: both would otherwise fire
      // after every command in the suite.
      WEGO_CLI_NO_AUTO_SKILL: "1",
      WEGO_CLI_NO_UPDATE_NOTICE: "1",
      WEGO_CLI_TELEMETRY: "0",
      ...extraEnv,
      // AFTER `extraEnv`, so the isolation the two guards above promise cannot be
      // undone by a caller — an empty override would be backfilled from
      // `.env.local` just as silently as leaving the key unset.
      WEGO_API_URL: target.url,
      WEGO_CREDENTIALS_PATH: target.credentialsPath,
      // Every per-run file the CLI writes goes here, not into the real config dir.
      XDG_CONFIG_HOME: CONFIG_HOME,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}
