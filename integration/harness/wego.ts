/**
 * Run the binary the way a user's shell does: real argv, real environment, its own
 * process, and a home of its own.
 *
 * The environment is built from nothing rather than copied from the suite's, so a
 * developer's `WEGO_*` exports, `.env.local` or real `~/.config/wego/` cannot reach
 * a scenario. Every endpoint points at the fake; telemetry, the update notice and
 * the background skill sync are off unless a scenario turns one on.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { binaryPath } from "./binary";
import { type Fake, TEST_CLIENT_ID } from "./fake";

export type CliResult = { code: number; out: string; err: string };

export interface Home {
  dir: string;
  /** `$XDG_CONFIG_HOME/wego`, where every per-install file lives. */
  configDir: string;
  credentialsPath: string;
  cleanup: () => void;
}

export function makeHome(): Home {
  const dir = mkdtempSync(join(tmpdir(), "wego-integration-home-"));
  const configDir = join(dir, ".config", "wego");
  return {
    dir,
    configDir,
    credentialsPath: join(configDir, "credentials.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export interface StoredCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  market?: string;
  idToken?: string;
}

/** Start a scenario already logged in, as a previous `wego login` would have left
 *  it. `login.test.ts` is where the login itself is driven. */
export function signIn(
  home: Home,
  creds: StoredCredentials = {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresAt: Date.now() + 3_600_000,
  },
): void {
  mkdirSync(home.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(home.credentialsPath, `${JSON.stringify(creds, null, 2)}\n`, {
    mode: 0o600,
  });
}

export function writeSettings(home: Home, settings: Record<string, string>) {
  mkdirSync(home.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(home.configDir, "settings.json"),
    `${JSON.stringify(settings, null, 2)}\n`,
    { mode: 0o600 },
  );
}

/** An unsigned id_token carrying `claims`: the CLI decodes it, never verifies it. */
export function idToken(claims: Record<string, unknown>): string {
  const part = (v: unknown) =>
    Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.sig`;
}

export interface RunOptions {
  fake?: Fake;
  home: Home;
  env?: Record<string, string>;
  stdin?: string;
}

/** A loopback port nothing listens on: the discard port. */
const DEAD_PROXY = "http://127.0.0.1:9";

function environment(opts: RunOptions): Record<string, string> {
  const inherited = [
    "PATH",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SystemRoot",
    "SYSTEMROOT",
    "ComSpec",
    "PATHEXT",
    "WINDIR",
  ];
  const env: Record<string, string> = {};
  for (const key of inherited) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  const fakeUrl = opts.fake?.url ?? "http://127.0.0.1:9";
  return {
    ...env,
    HOME: opts.home.dir,
    USERPROFILE: opts.home.dir,
    XDG_CONFIG_HOME: join(opts.home.dir, ".config"),
    WEGO_API_URL: fakeUrl,
    WEGO_AUTH_AUTHORIZE_URL:
      opts.fake?.authorizeUrl ?? `${fakeUrl}/oauth/authorize`,
    WEGO_AUTH_TOKEN_URL: opts.fake?.tokenUrl ?? `${fakeUrl}/oauth/token`,
    WEGO_CLI_CLIENT_ID: TEST_CLIENT_ID,
    WEGO_CLI_TELEMETRY: "0",
    WEGO_CLI_NO_UPDATE_NOTICE: "1",
    // Nothing leaves the machine. A release binary bakes a real analytics key,
    // and a scenario that turns telemetry on must not send an event from CI, so
    // every request that is not to loopback goes to a proxy that is not there.
    HTTPS_PROXY: DEAD_PROXY,
    HTTP_PROXY: DEAD_PROXY,
    NO_PROXY: "127.0.0.1,localhost",
    ...opts.env,
  };
}

export interface Running {
  /** Resolves with the first stderr text matching `pattern`. */
  waitForErr: (pattern: RegExp, timeoutMs?: number) => Promise<RegExpExecArray>;
  result: Promise<CliResult>;
  kill: () => void;
}

/** Start the binary and keep talking to it: for login, where the scenario has to
 *  read the authorize URL off stderr before the command can finish. */
export function spawnWego(args: string[], opts: RunOptions): Running {
  const proc = Bun.spawn([binaryPath(), ...args], {
    cwd: opts.home.dir,
    env: environment(opts),
    stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  let err = "";
  const listeners: (() => void)[] = [];
  const errDone = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stderr) {
      err += decoder.decode(chunk, { stream: true });
      for (const notify of listeners) notify();
    }
  })();
  const result = (async () => {
    const [out, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
      errDone,
    ]).then(([o, c]) => [o, c] as const);
    return { code, out, err };
  })();
  const waitForErr = (pattern: RegExp, timeoutMs = 10_000) =>
    new Promise<RegExpExecArray>((resolve, reject) => {
      const check = () => {
        const m = pattern.exec(err);
        if (m) {
          clearTimeout(timer);
          resolve(m);
        }
      };
      const timer = setTimeout(
        () => reject(new Error(`stderr never matched ${pattern}:\n${err}`)),
        timeoutMs,
      );
      listeners.push(check);
      check();
    });
  return { waitForErr, result, kill: () => proc.kill() };
}

export async function wego(
  args: string[],
  opts: RunOptions,
): Promise<CliResult> {
  return spawnWego(args, opts).result;
}

/** stdout parsed as JSON, or a failure naming what was printed instead. */
export function json<T extends object = Record<string, unknown>>(
  result: CliResult,
): T {
  try {
    return JSON.parse(result.out) as T;
  } catch {
    throw new Error(
      `stdout is not JSON (exit ${result.code}):\n${result.out}\nstderr:\n${result.err}`,
    );
  }
}
