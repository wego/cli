import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { isRemoteShell, waitForPastedCallback } from "./paste-callback";
import type { PromptIo } from "./prompt";

/** A stdin stand-in: an emitter with the TTY + flow-control bits the waiter
 *  touches, so a test can "type" a line without a real terminal. */
function fakeIo(isTTY = true) {
  const stdin = new EventEmitter() as EventEmitter & {
    isTTY?: boolean;
    resume(): void;
    pause(): void;
  };
  stdin.isTTY = isTTY;
  let resumed = 0;
  let paused = 0;
  stdin.resume = () => {
    resumed += 1;
  };
  stdin.pause = () => {
    paused += 1;
  };
  const err: string[] = [];
  const io = {
    stdin,
    stdout: { write: () => true },
    stderr: {
      write: (chunk: string) => {
        err.push(String(chunk));
        return true;
      },
    },
  } as unknown as PromptIo;
  return {
    io,
    err,
    type: (text: string) => stdin.emit("data", Buffer.from(text)),
    listeners: () => stdin.listenerCount("data"),
    counts: () => ({ resumed, paused }),
  };
}

const callbackUrl = (state: string, code = "auth-code-1") =>
  `http://127.0.0.1:54321/callback?code=${code}&state=${state}`;

describe("isRemoteShell", () => {
  it("is true when any SSH marker is set", () => {
    expect(isRemoteShell({ SSH_CONNECTION: "10.0.0.1 22 10.0.0.2 22" })).toBe(
      true,
    );
    expect(isRemoteShell({ SSH_CLIENT: "10.0.0.1 1234 22" })).toBe(true);
    expect(isRemoteShell({ SSH_TTY: "/dev/pts/0" })).toBe(true);
  });

  it("is false in a local shell", () => {
    expect(isRemoteShell({ TERM: "xterm-256color" })).toBe(false);
  });
});

describe("waitForPastedCallback", () => {
  it("resolves with the code from a pasted callback URL", async () => {
    const t = fakeIo();
    const waiter = waitForPastedCallback("state-1", t.io);
    t.type(`${callbackUrl("state-1")}\n`);
    expect(await waiter.promise).toBe("auth-code-1");
  });

  it("accepts a paste wrapped in quotes or angle brackets", async () => {
    const t = fakeIo();
    const waiter = waitForPastedCallback("state-1", t.io);
    t.type(`<${callbackUrl("state-1", "quoted")}>\n`);
    expect(await waiter.promise).toBe("quoted");
  });

  it("re-prompts on junk or a foreign state, then takes the right URL", async () => {
    const t = fakeIo();
    const waiter = waitForPastedCallback("state-1", t.io);
    t.type("\n"); // a bare Enter is not an attempt – no hint
    t.type("not a url at all\n");
    t.type(`${callbackUrl("someone-elses-state")}\n`);
    t.type(`${callbackUrl("state-1", "late-code")}\n`);

    expect(await waiter.promise).toBe("late-code");
    // Two bad attempts got a hint; the blank line did not.
    expect(t.err.length).toBe(2);
    expect(t.err[0]).toMatch(/not the redirect URL/);
  });

  it("rejects when the AS reported an error for our state", async () => {
    const t = fakeIo();
    const waiter = waitForPastedCallback("state-1", t.io);
    t.type(
      "http://127.0.0.1:54321/callback?error=access_denied&state=state-1\n",
    );
    await expect(waiter.promise).rejects.toThrow(/access_denied/);
  });

  it("reassembles a URL split across chunks and ignores a trailing partial", async () => {
    const t = fakeIo();
    const waiter = waitForPastedCallback("state-1", t.io);
    const url = callbackUrl("state-1", "chunked");
    t.type(url.slice(0, 20));
    t.type(`${url.slice(20)}\nhttp://127.0.0.1/partial`);
    expect(await waiter.promise).toBe("chunked");
  });

  // The cap must never eat a line that already arrived: one `data` event can
  // carry the real callback URL AND a flood of trailing junk behind it.
  it("reads a complete URL that shares its chunk with over-cap trailing junk", async () => {
    const t = fakeIo();
    const waiter = waitForPastedCallback("state-1", t.io);

    t.type(`${callbackUrl("state-1", "survives")}\n${"x".repeat(70_000)}`);

    expect(await waiter.promise).toBe("survives");
    // …and the settled login says nothing further: the leftover junk must not
    // draw a "too long" complaint after the code was already accepted.
    expect(t.err).toEqual([]);
  });

  it("drops an unterminated line past the cap instead of buffering forever", async () => {
    const t = fakeIo();
    const waiter = waitForPastedCallback("state-1", t.io);

    t.type("x".repeat(70_000)); // no newline – a stream that never breaks
    expect(t.err.join("")).toMatch(/too long to be a redirect URL/);

    // The buffer was reset, so a real paste right after still lands.
    t.type(`${callbackUrl("state-1", "after-flood")}\n`);
    expect(await waiter.promise).toBe("after-flood");
  });

  it("stays pending and attaches nothing when stdin is not a TTY", async () => {
    const t = fakeIo(false);
    const waiter = waitForPastedCallback("state-1", t.io);
    t.type(`${callbackUrl("state-1")}\n`);

    expect(t.listeners()).toBe(0);
    expect(t.counts().resumed).toBe(0);
    const settled = await Promise.race([
      waiter.promise.then(() => "settled"),
      Promise.resolve("pending"),
    ]);
    expect(settled).toBe("pending");
  });

  it("cancel detaches the stdin listeners so the process can exit", async () => {
    const t = fakeIo();
    const waiter = waitForPastedCallback("state-1", t.io);
    expect(t.listeners()).toBe(1);

    waiter.cancel();

    expect(t.listeners()).toBe(0);
    expect(t.counts().paused).toBe(1);
    // A paste after cancel must not settle the (now abandoned) waiter.
    t.type(`${callbackUrl("state-1")}\n`);
    const settled = await Promise.race([
      waiter.promise.then(() => "settled"),
      Promise.resolve("pending"),
    ]);
    expect(settled).toBe("pending");
  });
});
