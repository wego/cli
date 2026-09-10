import { describe, expect, mock, test } from "bun:test";
import {
  type ConsistencyDeps,
  parseSums,
  sameSums,
  waitChannelConsistent,
} from "./blob-consistency";

// A deterministic 64-hex digest of "<name>#<version>" so tests can express "this
// URL serves version N" without real bytes — real hex so `parseSums` accepts it,
// and version-sensitive so a stale binary reads as a genuine mismatch. The fake
// `hash` dep recovers the served version and mirrors this.
const fakeHash = (name: string, version: string) => {
  let acc = 0;
  const s = `${name}#${version}`;
  for (let i = 0; i < s.length; i++) acc = (acc * 31 + s.charCodeAt(i)) >>> 0;
  return acc.toString(16).padStart(8, "0").repeat(8).slice(0, 64);
};

/** Build a manifest body (GNU `sha256sum` shape) for a set of assets at a version. */
function manifestBody(names: string[], version: string): string {
  return `${names.map((n) => `${fakeHash(n, version)}  ${n}`).join("\n")}\n`;
}

describe("parseSums", () => {
  test("parses GNU and BSD line shapes, ignores noise", () => {
    const body = [
      `${"a".repeat(64)}  wego-linux-x64`,
      `${"b".repeat(64)} *wego-darwin-arm64`, // BSD binary marker
      "",
      "not a sums line",
      `${"c".repeat(64)}  SHA256SUMS.txt`,
    ].join("\n");
    const sums = parseSums(body);
    expect(sums.get("wego-linux-x64")).toBe("a".repeat(64));
    expect(sums.get("wego-darwin-arm64")).toBe("b".repeat(64));
    expect(sums.size).toBe(3);
  });

  test("lowercases hashes", () => {
    expect(parseSums(`${"A".repeat(64)}  x`).get("x")).toBe("a".repeat(64));
  });
});

describe("sameSums", () => {
  const a = new Map([["x", "1"]]);
  test("equal maps match", () => {
    expect(sameSums(a, new Map([["x", "1"]]))).toBe(true);
  });
  test("different hash, size, or name all differ", () => {
    expect(sameSums(a, new Map([["x", "2"]]))).toBe(false);
    expect(sameSums(a, new Map([["y", "1"]]))).toBe(false);
    expect(
      sameSums(
        a,
        new Map([
          ["x", "1"],
          ["y", "1"],
        ]),
      ),
    ).toBe(false);
  });
});

// A fake channel whose served manifest/binary "version" we can flip between
// polls, so a test can simulate a stale channel converging.
function fakeChannel(opts: {
  binNames: string[];
  // A per-attempt version for the manifest and (optionally) individual binaries.
  // `undefined` version → a 404 (not yet copied).
  script: Array<{
    manifest?: string;
    binaries?: Record<string, string | undefined>;
  }>;
}) {
  let call = -1;
  const state = { manifestFetches: 0, binaryFetches: 0 };
  const fetch = mock(async (url: string) => {
    const step = opts.script[Math.min(call, opts.script.length - 1)];
    if (url.endsWith("/SHA256SUMS.txt")) {
      // Advance the scripted step once per *manifest* poll (the loop's top).
      call++;
      state.manifestFetches++;
      const cur = opts.script[Math.min(call, opts.script.length - 1)];
      if (cur.manifest === undefined) return new Response("", { status: 404 });
      return new Response(manifestBody(opts.binNames, cur.manifest));
    }
    state.binaryFetches++;
    const name = url.slice(url.lastIndexOf("/") + 1);
    const version = step?.binaries?.[name] ?? step?.manifest; // default: bins track manifest
    if (version === undefined) return new Response("", { status: 404 });
    return new Response(fakeHash(name, version));
  });
  return { fetch, state };
}

function deps(fetchImpl: (url: string) => Promise<Response>): ConsistencyDeps {
  return {
    fetch: fetchImpl as unknown as typeof fetch,
    // Body was created via `new Response(fakeHash(name, version))`; recover it.
    hash: async (body) => new TextDecoder().decode(body),
    sleep: async () => {},
    log: () => {},
    maxAttempts: 5,
    delayMs: 0,
    // Small so the real AbortSignal.timeout timers the barrier attaches stay
    // short in tests (the fake fetch ignores the signal anyway).
    manifestTimeoutMs: 50,
    assetTimeoutMs: 50,
  };
}

/** A fake fetch whose manifest always serves the target version, but whose binary
 *  fetches THROW (like a timeout / network stall) for the first `throwFirst`
 *  binary requests, then serve the target version. */
function fakeThrowingBinaries(
  binNames: string[],
  version: string,
  throwFirst: number,
) {
  let binaryCalls = 0;
  return mock(async (url: string) => {
    if (url.endsWith("/SHA256SUMS.txt")) {
      return new Response(manifestBody(binNames, version));
    }
    binaryCalls++;
    if (binaryCalls <= throwFirst) {
      const err = new Error("The operation timed out.");
      err.name = "TimeoutError";
      throw err;
    }
    const name = url.slice(url.lastIndexOf("/") + 1);
    return new Response(fakeHash(name, version));
  });
}

/** A 200 Response whose BODY read rejects — models an abort/network drop that
 *  fires *during* body transfer (the signal that aborts a 60–95MB download after
 *  headers arrive). The earlier code read the body outside the try/catch, so this
 *  threw uncaught out of the barrier. */
function bodyFailingResponse(): Response {
  const abort = () => {
    const err = new Error("The operation was aborted.");
    err.name = "AbortError";
    return err;
  };
  return {
    ok: true,
    status: 200,
    text: async () => {
      throw abort();
    },
    arrayBuffer: async () => {
      throw abort();
    },
  } as unknown as Response;
}

describe("waitChannelConsistent", () => {
  const bins = ["wego-linux-x64", "wego-darwin-arm64"];
  const expected = parseSums(manifestBody(bins, "v2"));

  test("passes immediately when manifest + all binaries already serve the tag", async () => {
    const { fetch, state } = fakeChannel({
      binNames: bins,
      script: [{ manifest: "v2" }],
    });
    await expect(
      waitChannelConsistent("https://blob/cli/staging", expected, deps(fetch)),
    ).resolves.toBeUndefined();
    // Each binary fetched exactly once on the single passing attempt.
    expect(state.binaryFetches).toBe(bins.length);
  });

  test("waits out a manifest that hasn't advanced yet, then converges", async () => {
    const { fetch, state } = fakeChannel({
      binNames: bins,
      // Poll 1: manifest still old (v1) → skip binaries. Poll 2: manifest v2, bins v2.
      script: [{ manifest: "v1" }, { manifest: "v2" }],
    });
    await expect(
      waitChannelConsistent("https://blob/cli/staging", expected, deps(fetch)),
    ).resolves.toBeUndefined();
    // No binary was fetched while the manifest was stale.
    expect(state.manifestFetches).toBe(2);
  });

  test("the real failure: fresh manifest but a stale binary — retries, does not falsely certify", async () => {
    const { fetch } = fakeChannel({
      binNames: bins,
      script: [
        // Manifest already v2, but the darwin binary still serves v1 (the bug).
        { manifest: "v2", binaries: { "wego-darwin-arm64": "v1" } },
        // Next poll: it caught up.
        { manifest: "v2" },
      ],
    });
    await expect(
      waitChannelConsistent("https://blob/cli/staging", expected, deps(fetch)),
    ).resolves.toBeUndefined();
  });

  test("does NOT re-fetch a binary that already matched", async () => {
    const { fetch, state } = fakeChannel({
      binNames: bins,
      script: [
        // Poll 1: linux ok (v2), staging stale (v1).
        { manifest: "v2", binaries: { "wego-darwin-arm64": "v1" } },
        // Poll 2: staging catches up; linux must NOT be re-downloaded.
        { manifest: "v2", binaries: { "wego-linux-x64": "v2" } },
      ],
    });
    await waitChannelConsistent(
      "https://blob/cli/staging",
      expected,
      deps(fetch),
    );
    // 2 binaries poll-1 + only the still-unverified 1 poll-2 = 3, not 4.
    expect(state.binaryFetches).toBe(3);
  });

  test("throws after the budget when a binary never converges", async () => {
    const { fetch } = fakeChannel({
      binNames: bins,
      script: [{ manifest: "v2", binaries: { "wego-darwin-arm64": "v1" } }],
    });
    await expect(
      waitChannelConsistent("https://blob/cli/staging", expected, deps(fetch)),
    ).rejects.toThrow(/did not converge/);
  });

  test("throws when the manifest never advances", async () => {
    const { fetch } = fakeChannel({
      binNames: bins,
      script: [{ manifest: "v1" }],
    });
    await expect(
      waitChannelConsistent("https://blob/cli/staging", expected, deps(fetch)),
    ).rejects.toThrow(/did not converge/);
  });

  test("a timed-out/stalled fetch is retryable, not fatal, and converges", async () => {
    // Both binaries throw a TimeoutError on the first poll, then serve v2.
    const fetch = fakeThrowingBinaries(bins, "v2", bins.length);
    await expect(
      waitChannelConsistent("https://blob/cli/staging", expected, deps(fetch)),
    ).resolves.toBeUndefined();
  });

  test("a fetch that always times out fails after the budget (never hangs)", async () => {
    // throwFirst huge → every binary fetch throws on every poll.
    const fetch = fakeThrowingBinaries(bins, "v2", Number.MAX_SAFE_INTEGER);
    await expect(
      waitChannelConsistent("https://blob/cli/staging", expected, deps(fetch)),
    ).rejects.toThrow(/did not converge/);
  });

  // Blocker regression (review by openclaw-anya-wego): a body-read failure that
  // fires AFTER headers arrive (e.g. the deadline aborting a large asset stream)
  // must be a retryable per-poll issue, not an uncaught throw out of the barrier.
  test("an asset body-read abort mid-transfer is retryable, then converges", async () => {
    let binCalls = 0;
    const fetch = mock(async (url: string) => {
      if (url.endsWith("/SHA256SUMS.txt")) {
        return new Response(manifestBody(bins, "v2"));
      }
      binCalls++;
      // Poll 1: both binary bodies abort mid-read. Poll 2: they serve fine.
      if (binCalls <= bins.length) return bodyFailingResponse();
      const name = url.slice(url.lastIndexOf("/") + 1);
      return new Response(fakeHash(name, "v2"));
    });
    await expect(
      waitChannelConsistent("https://blob/cli/staging", expected, deps(fetch)),
    ).resolves.toBeUndefined();
  });

  test("a persistent asset body-read failure fails with the budget message, not a raw throw", async () => {
    const fetch = mock(async (url: string) => {
      if (url.endsWith("/SHA256SUMS.txt")) {
        return new Response(manifestBody(bins, "v2"));
      }
      return bodyFailingResponse(); // every binary body-read aborts, every poll
    });
    // The point: it rejects with /did not converge/, NOT the raw AbortError.
    await expect(
      waitChannelConsistent("https://blob/cli/staging", expected, deps(fetch)),
    ).rejects.toThrow(/did not converge/);
  });

  test("skipAssets certifies a channel whose skipped body is not served yet", async () => {
    // The publisher's first barrier: the manifest already lists VERSION, but
    // VERSION is copied only AFTER this barrier passes. Trimming it out of the
    // expected map instead would make `sameSums` a permanent size mismatch, so
    // the promote could never converge - the map stays whole, the body is skipped.
    const withVersion = [...bins, "VERSION"];
    const full = parseSums(manifestBody(withVersion, "v2"));
    const { fetch, state } = fakeChannel({
      binNames: withVersion,
      // VERSION 404s: it has not been copied to the channel yet.
      script: [{ manifest: "v2", binaries: { VERSION: undefined } }],
    });
    await expect(
      waitChannelConsistent("https://blob/cli/staging", full, {
        ...deps(fetch),
        skipAssets: new Set(["VERSION"]),
      }),
    ).resolves.toBeUndefined();
    // Only the deliverables were read - the skipped body was never fetched.
    expect(state.binaryFetches).toBe(bins.length);
  });

  test("skipAssets still fails when a NON-skipped body is stale", async () => {
    const withVersion = [...bins, "VERSION"];
    const full = parseSums(manifestBody(withVersion, "v2"));
    const { fetch } = fakeChannel({
      binNames: withVersion,
      script: [
        {
          manifest: "v2",
          binaries: { VERSION: undefined, "wego-linux-x64": "v1" },
        },
      ],
    });
    await expect(
      waitChannelConsistent("https://blob/cli/staging", full, {
        ...deps(fetch),
        skipAssets: new Set(["VERSION"]),
      }),
    ).rejects.toThrow(/did not converge/);
  });

  test("a manifest body-read failure is retryable, then converges", async () => {
    let manifestCalls = 0;
    const fetch = mock(async (url: string) => {
      if (url.endsWith("/SHA256SUMS.txt")) {
        manifestCalls++;
        // Poll 1: manifest .text() aborts mid-read. Poll 2: it reads fine.
        if (manifestCalls === 1) return bodyFailingResponse();
        return new Response(manifestBody(bins, "v2"));
      }
      const name = url.slice(url.lastIndexOf("/") + 1);
      return new Response(fakeHash(name, "v2"));
    });
    await expect(
      waitChannelConsistent("https://blob/cli/staging", expected, deps(fetch)),
    ).resolves.toBeUndefined();
  });
});
