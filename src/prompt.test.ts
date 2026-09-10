import { describe, expect, it } from "bun:test";
import { PassThrough } from "node:stream";
import { confirmTty, type PromptIo } from "./prompt";

/** A capturing write sink standing in for stdout/stderr. */
function sink() {
  const chunks: string[] = [];
  return {
    write: (s: string) => {
      chunks.push(s);
      return true;
    },
    text: () => chunks.join(""),
  };
}

/** A TTY-flagged stdin backed by a PassThrough we can feed or end. */
function ttyStdin() {
  const pt = new PassThrough() as PassThrough & { isTTY?: boolean };
  pt.isTTY = true;
  return pt;
}

describe("confirmTty", () => {
  it("returns false and hints at -y when stdin is not a TTY", async () => {
    const stderr = sink();
    const io: PromptIo = {
      stdin: Object.assign(new PassThrough(), { isTTY: false }),
      stdout: sink(),
      stderr,
    };
    expect(await confirmTty("Proceed?", io)).toBe(false);
    expect(stderr.text()).toContain("non-interactive");
  });

  it('treats "y" / "yes" (any case, trimmed) as yes', async () => {
    for (const reply of ["y\n", "Y", "  yes \n", "YES"]) {
      const stdin = ttyStdin();
      const io: PromptIo = { stdin, stdout: sink(), stderr: sink() };
      const p = confirmTty("Proceed?", io);
      stdin.write(reply);
      expect(await p).toBe(true);
    }
  });

  it("treats anything else as no", async () => {
    for (const reply of ["n\n", "no", "nope", "\n", "  "]) {
      const stdin = ttyStdin();
      const io: PromptIo = { stdin, stdout: sink(), stderr: sink() };
      const p = confirmTty("Proceed?", io);
      stdin.write(reply);
      expect(await p).toBe(false);
    }
  });

  it("resolves to no on EOF (Ctrl-D, empty stdin) instead of hanging", async () => {
    const stdin = ttyStdin();
    const io: PromptIo = { stdin, stdout: sink(), stderr: sink() };
    const p = confirmTty("Proceed?", io);
    stdin.end(); // EOF with no data – must not hang
    expect(await p).toBe(false);
  });

  it("resolves to no on a stdin error instead of hanging", async () => {
    const stdin = ttyStdin();
    const io: PromptIo = { stdin, stdout: sink(), stderr: sink() };
    const p = confirmTty("Proceed?", io);
    stdin.emit("error", new Error("boom"));
    expect(await p).toBe(false);
  });

  it("removes every listener it added once it resolves (no leak)", async () => {
    const stdin = ttyStdin();
    const before = {
      data: stdin.listenerCount("data"),
      end: stdin.listenerCount("end"),
      error: stdin.listenerCount("error"),
    };
    const io: PromptIo = { stdin, stdout: sink(), stderr: sink() };
    const p = confirmTty("Proceed?", io);
    stdin.write("y\n");
    await p;
    expect(stdin.listenerCount("data")).toBe(before.data);
    expect(stdin.listenerCount("end")).toBe(before.end);
    expect(stdin.listenerCount("error")).toBe(before.error);
  });
});
