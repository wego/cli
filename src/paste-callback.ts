/**
 * Manual (paste-the-redirect-URL) completion of the loopback login, for when
 * the browser and the CLI are on different machines — the SSH case.
 *
 * The loopback listener binds `127.0.0.1` on the machine that runs `wego`. Over
 * SSH the user opens the authorize URL on their laptop, so the AS redirects
 * their *local* browser to `http://127.0.0.1:<port>/callback?code=…`, which no
 * process there answers. The code is still in the address bar, so the user
 * pastes that URL back into the waiting terminal and the flow completes with no
 * change to the redirect_uri, the PKCE verifier, or the AS.
 */

import { interpretCallback } from "./loopback";
import type { PromptIo } from "./prompt";

/** Cap on one unterminated line of pasted input (a callback URL is ~300 B). */
const MAX_LINE_BYTES = 64 * 1024;

export interface PastedCallbackWaiter {
  /** False when stdin is not a TTY: nobody can paste, so the promise never
   *  settles and the caller must not prompt or extend its deadline for it. */
  armed: boolean;
  /** Resolves with the authorization `code` from a pasted callback URL. */
  promise: Promise<string>;
  /** Detach the stdin listeners so the process can exit (loopback won). */
  cancel(): void;
}

/** True when the CLI runs inside an SSH session, where the user's browser is on
 *  another machine and the loopback redirect cannot reach this process. */
export function isRemoteShell(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY);
}

/** Strip shell/markdown noise a paste can carry (quotes, angle brackets). */
function cleanPastedUrl(line: string): string {
  return line
    .trim()
    .replace(/^["'<]+/, "")
    .replace(/["'>]+$/, "");
}

/**
 * Read pasted callback URLs from stdin until one carries our `state`. Lines
 * that aren't for us (blank, junk, wrong `state`) get a hint and another try —
 * only a state-matching line settles the login, exactly like the loopback.
 * Returns a never-settling waiter when stdin is not a TTY: an agent shelling
 * out has nobody to paste, so the loopback stays the only path.
 */
export function waitForPastedCallback(
  expectedState: string,
  io: PromptIo = {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  },
): PastedCallbackWaiter {
  const { stdin, stderr } = io;
  if (!stdin.isTTY) {
    return {
      armed: false,
      promise: new Promise<string>(() => {}),
      cancel: () => {},
    };
  }
  let buffer = "";
  let settled = false;
  let cleanup = () => {};

  const promise = new Promise<string>((resolve, reject) => {
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const onLine = (line: string) => {
      const raw = cleanPastedUrl(line);
      if (!raw) return;
      let outcome: ReturnType<typeof interpretCallback>;
      try {
        outcome = interpretCallback(raw, expectedState);
      } catch {
        outcome = { kind: "ignore" };
      }
      if (outcome.kind === "code") {
        settle(() => resolve(outcome.code));
      } else if (outcome.kind === "error") {
        settle(() => reject(outcome.error));
      } else {
        stderr.write(
          "That is not the redirect URL for this login. Paste the whole URL from the browser address bar, starting with http://127.0.0.1.\n",
        );
      }
    };
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      // Complete lines first: one `data` event can carry the real callback URL
      // AND a pile of trailing junk, and the URL must still be read.
      let index = buffer.indexOf("\n");
      while (index !== -1 && !settled) {
        onLine(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
      // Only the unterminated remainder is capped. A callback URL is a few
      // hundred bytes, so anything past the cap with no newline is not a paste
      // we can use (a stray binary stream, a pipe that never breaks a line) —
      // drop it rather than grow without bound.
      if (!settled && buffer.length > MAX_LINE_BYTES) {
        buffer = "";
        stderr.write(
          "That input is too long to be a redirect URL – ignoring it. Paste just the http://127.0.0.1 address.\n",
        );
      }
    };
    // EOF or a stream error means nobody can paste — stay pending and let the
    // loopback (or the login deadline) decide, rather than failing a login that
    // a forwarded port could still complete.
    const onDone = () => {
      cleanup();
    };
    cleanup = () => {
      stdin.off("data", onData);
      stdin.off("end", onDone);
      stdin.off("error", onDone);
      stdin.pause();
    };
    stdin.resume();
    stdin.on("data", onData);
    stdin.once("end", onDone);
    stdin.once("error", onDone);
  });

  return {
    armed: true,
    promise,
    cancel: () => {
      settled = true;
      cleanup();
    },
  };
}
