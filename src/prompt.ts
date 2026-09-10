import type { Readable, Writable } from "node:stream";

/**
 * The streams `confirmTty` reads/writes. Injectable so the flow is unit-testable
 * without touching the real process streams; defaults to `process.*`.
 */
export interface PromptIo {
  stdin: Readable & { isTTY?: boolean };
  stdout: Pick<Writable, "write">;
  stderr: Pick<Writable, "write">;
}

/**
 * Best-effort interactive yes/no confirm for side-effecting commands.
 *
 * When stdin isn't a TTY (e.g. `curl … | bash`, or an agent shelling out) there
 * is no one to ask, so it returns `false` and points the caller at `-y` rather
 * than blocking forever on a read that never arrives.
 */
export async function confirmTty(
  question: string,
  io: PromptIo = {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  },
): Promise<boolean> {
  const { stdin, stdout, stderr } = io;
  if (!stdin.isTTY) {
    stderr.write(
      `${question}\n(non-interactive – re-run with -y to proceed)\n`,
    );
    return false;
  }
  stdout.write(`${question} [y/N] `);
  const answer = await new Promise<string>((resolve) => {
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.off("end", onDone);
      stdin.off("error", onDone);
      stdin.pause();
    };
    const onData = (chunk: Buffer) => {
      cleanup();
      resolve(chunk.toString());
    };
    // EOF (Ctrl-D on empty stdin) or a stream error must resolve too — treated
    // as "no" — otherwise the promise, and `skill install`'s confirm step,
    // would hang forever waiting for a `data` event that never comes.
    const onDone = () => {
      cleanup();
      resolve("");
    };
    stdin.resume();
    stdin.on("data", onData);
    stdin.once("end", onDone);
    stdin.once("error", onDone);
  });
  const normalized = answer.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}
