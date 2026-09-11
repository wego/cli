import { describe, expect, it } from "bun:test";
import { interpretCallback, startLoopback } from "./loopback";

describe("interpretCallback", () => {
  it("returns the code when state matches", () => {
    expect(
      interpretCallback("/callback?code=abc123&state=st-1", "st-1"),
    ).toEqual({
      kind: "code",
      code: "abc123",
    });
  });

  it("accepts a full URL too", () => {
    expect(
      interpretCallback("http://127.0.0.1:5000/callback?code=abc&state=s", "s"),
    ).toEqual({ kind: "code", code: "abc" });
  });

  it("ignores a state mismatch (so unsolicited requests can't cancel login)", () => {
    expect(interpretCallback("/callback?code=abc&state=evil", "st-1")).toEqual({
      kind: "ignore",
    });
  });

  it("ignores an error param that lacks the matching state", () => {
    // state is checked FIRST — a stray ?error= without our state is not for us.
    expect(interpretCallback("/callback?error=access_denied", "st-1")).toEqual({
      kind: "ignore",
    });
  });

  it("surfaces an OAuth error that carries the matching state", () => {
    const outcome = interpretCallback(
      "/callback?error=access_denied&error_description=nope&state=st-1",
      "st-1",
    );
    expect(outcome.kind).toBe("error");
    expect(outcome.kind === "error" && outcome.error.message).toMatch(
      /access_denied.*nope/,
    );
  });

  it("errors when state matches but no code is present", () => {
    const outcome = interpretCallback("/callback?state=st-1", "st-1");
    expect(outcome.kind).toBe("error");
    expect(outcome.kind === "error" && outcome.error.message).toMatch(
      /no code/,
    );
  });

  it("ignores a state-matching callback from a non-loopback origin", () => {
    // Defence in depth: a foreign code could not be redeemed anyway (the
    // exchange uses this process's verifier), but it is not our redirect.
    expect(
      interpretCallback("https://evil.example/callback?code=c&state=st", "st"),
    ).toEqual({ kind: "ignore" });
    // The shapes the two real paths produce still pass: an absolute loopback
    // URL (the server) and a bare query (a paste resolved against 127.0.0.1).
    expect(
      interpretCallback("http://127.0.0.1:5321/callback?code=c&state=st", "st"),
    ).toEqual({ kind: "code", code: "c" });
    expect(interpretCallback("?code=c&state=st", "st")).toEqual({
      kind: "code",
      code: "c",
    });
    expect(
      interpretCallback("http://localhost:5321/callback?code=c&state=st", "st"),
    ).toEqual({ kind: "code", code: "c" });
  });
});

describe("startLoopback (live ephemeral server)", () => {
  it("binds 127.0.0.1 on an ephemeral port and resolves the code on a matching redirect", async () => {
    const listener = startLoopback("/callback");
    try {
      const url = new URL(listener.redirectUri);
      expect(url.hostname).toBe("127.0.0.1");
      expect(url.pathname).toBe("/callback");
      expect(Number(url.port)).toBeGreaterThan(0);

      const pending = listener.waitForCode("st-1", 5_000);
      const res = await fetch(
        `${listener.redirectUri}?code=the-code&state=st-1`,
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Login complete");
      expect(await pending).toBe("the-code");
    } finally {
      listener.close();
    }
  });

  // A pasted callback can win the login while this waiter is still armed, so
  // `close()` must clear its deadline: a live timer holds the event loop open
  // (and would fire a stray rejection) long after the caller is done.
  it("clears the pending deadline on close so an unsettled waiter leaves no timer", async () => {
    const listener = startLoopback("/callback");
    const pending = listener.waitForCode("st-1", 40);
    let rejected: unknown;
    pending.catch((e) => {
      rejected = e;
    });

    listener.close(); // the paste path won; nobody will feed this waiter

    await Bun.sleep(120); // well past the 40ms deadline
    expect(rejected).toBeUndefined();
  });

  // A timed-out waiter must not stay armed: a callback that lands afterwards
  // belongs to whoever waits next, not to the login the caller already lost.
  it("hands a post-timeout callback to the next waiter instead of the dead one", async () => {
    const listener = startLoopback("/callback");
    try {
      await expect(listener.waitForCode("st-1", 30)).rejects.toThrow(
        /timed out/,
      );

      await fetch(`${listener.redirectUri}?code=late-code&state=st-2`);

      expect(await listener.waitForCode("st-2", 5_000)).toBe("late-code");
    } finally {
      listener.close();
    }
  });

  it("ignores an unsolicited/wrong-state request without cancelling the pending login", async () => {
    const listener = startLoopback("/callback");
    try {
      const pending = listener.waitForCode("st-1", 5_000);
      let settled = false;
      pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      const bogus = await fetch(
        `${listener.redirectUri}?error=access_denied&state=evil`,
      );
      expect(bogus.status).toBe(400);
      await new Promise((r) => setTimeout(r, 50));
      expect(settled).toBe(false); // login NOT cancelled by the unsolicited hit

      // A legitimate redirect with the right state still resolves it.
      const ok = await fetch(
        `${listener.redirectUri}?code=the-code&state=st-1`,
      );
      expect(ok.status).toBe(200);
      expect(await pending).toBe("the-code");
    } finally {
      listener.close();
    }
  });

  it("rejects when the redirect carries an OAuth error with the matching state", async () => {
    const listener = startLoopback("/callback");
    try {
      const pending = listener.waitForCode("st-1", 5_000);
      let rejectedWith: Error | undefined;
      pending.catch((e: Error) => {
        rejectedWith = e;
      });
      const res = await fetch(
        `${listener.redirectUri}?error=access_denied&state=st-1`,
      );
      expect(res.status).toBe(400);
      await new Promise((r) => setTimeout(r, 50));
      expect(rejectedWith?.message).toMatch(/access_denied/);
    } finally {
      listener.close();
    }
  });

  it("buffers a callback that arrives before the waiter is armed", async () => {
    const listener = startLoopback("/callback");
    try {
      // Redirect hits the server BEFORE waitForCode() is called.
      const res = await fetch(`${listener.redirectUri}?code=early&state=st-9`);
      expect(res.status).toBe(200);
      // The waiter attaches afterwards and still receives the buffered code.
      expect(await listener.waitForCode("st-9", 5_000)).toBe("early");
    } finally {
      listener.close();
    }
  });

  it("keeps an early valid callback even when an unsolicited one also arrives first", async () => {
    const listener = startLoopback("/callback");
    try {
      // Both arrive BEFORE waitForCode: a wrong-state hit then the real one.
      await fetch(`${listener.redirectUri}?error=access_denied&state=evil`);
      await fetch(`${listener.redirectUri}?code=real&state=st-7`);
      // The wrong-state one is ignored; the valid one still resolves.
      expect(await listener.waitForCode("st-7", 5_000)).toBe("real");
    } finally {
      listener.close();
    }
  });

  it("404s a non-callback path", async () => {
    const listener = startLoopback("/callback");
    try {
      const base = listener.redirectUri.replace("/callback", "");
      expect((await fetch(`${base}/elsewhere`)).status).toBe(404);
    } finally {
      listener.close();
    }
  });

  // Some clients register a BARE-origin loopback redirect (no /callback path);
  // an empty redirectPath must produce a bare redirect_uri and still match `/`.
  it("supports a bare redirect (empty path) and matches the root callback", async () => {
    const listener = startLoopback("");
    try {
      const url = new URL(listener.redirectUri);
      expect(url.hostname).toBe("127.0.0.1");
      // Bare redirect_uri: no path component.
      expect(listener.redirectUri).toBe(`http://127.0.0.1:${url.port}`);

      const pending = listener.waitForCode("st-bare", 5_000);
      // The browser lands on `/` with the query string.
      const res = await fetch(
        `${listener.redirectUri}/?code=bare-code&state=st-bare`,
      );
      expect(res.status).toBe(200);
      expect(await pending).toBe("bare-code");
    } finally {
      listener.close();
    }
  });
});
