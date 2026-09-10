import { describe, expect, test } from "bun:test";
import {
  type ImmutableUploadDeps,
  isAlreadyPublished,
  putImmutableAssets,
  resolveStoreOrigin,
} from "./blob-publish";

const ORIGIN = "https://store.public.blob.vercel-storage.com";

/** A `put` stub recording its calls, answering with the store URL it would mint. */
function fakePut(behavior?: (pathname: string) => Error | undefined) {
  const calls: { pathname: string; options: Record<string, unknown> }[] = [];
  const put = (async (
    pathname: string,
    _body: unknown,
    options: Record<string, unknown>,
  ) => {
    const failure = behavior?.(pathname);
    if (failure) throw failure;
    calls.push({ pathname, options });
    return { url: `${ORIGIN}/${pathname}` };
  }) as unknown as ImmutableUploadDeps["put"];
  return { calls, put };
}

function run(args: {
  names: string[];
  present?: string[];
  storeOrigin?: string;
  behavior?: (pathname: string) => Error | undefined;
}) {
  const logs: string[] = [];
  const stub = fakePut(args.behavior);
  return {
    logs,
    calls: stub.calls,
    result: putImmutableAssets({
      names: args.names,
      distDir: "dist",
      prefix: "cli/1.2.3",
      present: new Set(args.present ?? []),
      token: "tok",
      storeOrigin: args.storeOrigin,
      deps: {
        put: stub.put,
        openFile: (path: string) => path as unknown as Blob,
        log: (m) => logs.push(m),
      },
    }),
  };
}

describe("isAlreadyPublished", () => {
  test.each([
    "blob already exists",
    "Precondition Failed",
    "etag mismatch",
    "ALREADY EXISTS",
  ])("treats %p as an idempotent resume", (message) => {
    expect(isAlreadyPublished(new Error(message))).toBe(true);
  });

  test.each([
    "network unreachable",
    "403 forbidden",
    "",
  ])("treats %p as a real fault", (message) => {
    expect(isAlreadyPublished(new Error(message))).toBe(false);
  });

  test("a non-Error rejection is a real fault", () => {
    expect(isAlreadyPublished("already exists")).toBe(false);
  });
});

describe("putImmutableAssets", () => {
  test("uploads each name under the prefix and returns the discovered origin", async () => {
    const { result, calls } = run({ names: ["wego-linux-x64", "VERSION"] });
    expect(await result).toBe(ORIGIN);
    expect(calls.map((c) => c.pathname)).toEqual([
      "cli/1.2.3/wego-linux-x64",
      "cli/1.2.3/VERSION",
    ]);
  });

  test("writes every object immutable, chunked and hard-cached", async () => {
    const { result, calls } = run({ names: ["wego-linux-x64"] });
    await result;
    expect(calls[0].options).toMatchObject({
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: false,
      multipart: true,
      cacheControlMaxAge: 31_536_000,
      token: "tok",
    });
  });

  test("skips a name already listed, without calling put", async () => {
    const { result, calls, logs } = run({
      names: ["VERSION"],
      present: ["cli/1.2.3/VERSION"],
    });
    await result;
    expect(calls).toEqual([]);
    expect(logs).toEqual(["= cli/1.2.3/VERSION (already published)"]);
  });

  test("an already-exists rejection is a resume, not a failure", async () => {
    const { result, logs } = run({
      names: ["VERSION"],
      behavior: () => new Error("blob already exists"),
    });
    expect(await result).toBe("");
    expect(logs).toEqual(["= cli/1.2.3/VERSION (already published)"]);
  });

  test("any other rejection propagates", async () => {
    const { result } = run({
      names: ["VERSION"],
      behavior: () => new Error("network unreachable"),
    });
    expect(result).rejects.toThrow("network unreachable");
  });

  test("keeps a store origin the caller already knew", async () => {
    const { result } = run({
      names: ["VERSION"],
      storeOrigin: "https://known.example.com",
    });
    expect(await result).toBe("https://known.example.com");
  });

  test("returns an empty origin when every name was already present", async () => {
    const { result } = run({
      names: ["VERSION"],
      present: ["cli/1.2.3/VERSION"],
    });
    expect(await result).toBe("");
  });
});

describe("resolveStoreOrigin", () => {
  const fakeList = (urls: string[]) => {
    const calls: { prefix: string; token: string }[] = [];
    const list = (async (opts: { prefix: string; token: string }) => {
      calls.push(opts);
      return { blobs: urls.map((url) => ({ url })) };
    }) as unknown as NonNullable<
      Parameters<typeof resolveStoreOrigin>[0]["deps"]
    >["list"];
    return { calls, list };
  };

  test("returns a known origin without listing at all", async () => {
    const stub = fakeList([`${ORIGIN}/cli/1.2.3/VERSION`]);
    const got = await resolveStoreOrigin({
      storeOrigin: "https://known.example.com",
      prefix: "cli/1.2.3",
      token: "tok",
      deps: { list: stub.list },
    });
    expect(got).toBe("https://known.example.com");
    expect(stub.calls).toEqual([]);
  });

  // The gap this exists for: a fully-resumed run uploads nothing, so
  // putImmutableAssets returns "" and the origin has to come from a re-list.
  test("recovers an empty origin by re-listing the prefix", async () => {
    const stub = fakeList([`${ORIGIN}/cli/1.2.3/VERSION`]);
    const got = await resolveStoreOrigin({
      storeOrigin: "",
      prefix: "cli/1.2.3",
      token: "tok",
      deps: { list: stub.list },
    });
    expect(got).toBe(ORIGIN);
    expect(stub.calls).toEqual([{ prefix: "cli/1.2.3/", token: "tok" }]);
  });

  test("stays empty when the prefix lists nothing, so the caller can refuse", async () => {
    const stub = fakeList([]);
    const got = await resolveStoreOrigin({
      storeOrigin: "",
      prefix: "cli/1.2.3",
      token: "tok",
      deps: { list: stub.list },
    });
    expect(got).toBe("");
  });
});
