import { describe, expect, it } from "bun:test";
import { EXIT } from "./error-report";
import { MANIFEST_ASSET, SIGNATURE_ASSET } from "./release-signing";
import {
  OTHER_IDENTITY_CERT_DER,
  signManifest,
  TEST_ROOT_PEM,
} from "./release-signing/testing/fixture";
import {
  parseUpdateArgs,
  UPDATE_USAGE,
  type UpdateDeps,
  update,
} from "./update";

// The recorded install endpoint (`ring-follow.ts`), not a blob channel base:
// every asset is fetched through its `?dl=` branch.
const BASE = "https://api.wego.com/install";
const RING = "latest";
const enc = (s: string) => new TextEncoder().encode(s);

async function sha256Hex(data: Uint8Array): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(data);
  return hasher.digest("hex");
}

/** `<hash>␠␠<name>` lines, as `sha256sum` writes them. */
async function sumsFor(entries: Record<string, Uint8Array>): Promise<string> {
  const lines: string[] = [];
  for (const [name, bytes] of Object.entries(entries)) {
    lines.push(`${await sha256Hex(bytes)}  ${name}`);
  }
  return `${lines.join("\n")}\n`;
}

interface Route {
  body?: Uint8Array | string;
  status?: number;
  throwErr?: unknown;
}

async function servedBody(
  asset: string | null,
  sums: string,
  latest: Uint8Array<ArrayBuffer>,
): Promise<string | Uint8Array> {
  if (asset === SIGNATURE_ASSET) {
    return JSON.stringify(await signManifest(enc(sums)));
  }
  if (asset === MANIFEST_ASSET) return sums;
  return Bun.gzipSync(latest);
}

function bodyResponse(body: string | Uint8Array): Response {
  const bytes = typeof body === "string" ? enc(body) : body;
  return {
    ok: true,
    status: 200,
    text: async () => new TextDecoder().decode(bytes),
    arrayBuffer: async () => new Uint8Array(bytes).buffer,
  } as Response;
}

/**
 * A real signed build record for whatever manifest the test routed, or null when
 * the URL is not a record request. Derived here rather than added to every route
 * map, and a genuine signature so every test exercises the real verifier. A test
 * that wants a refusal routes the `&sig=1` URL explicitly, which takes precedence.
 */
async function recordFor(
  url: string,
  routes: Record<string, Route>,
): Promise<Response | null> {
  if (new URL(url).searchParams.get("sig") !== "1") return null;
  if (routes[url]) return null;
  // The record's `?dl=` names the bundle; the bytes it signs are the manifest's.
  const manifestUrl = url
    .replace("&sig=1", "")
    .replace(SIGNATURE_ASSET, MANIFEST_ASSET);
  const manifest = routes[manifestUrl]?.body;
  if (manifest === undefined) return null;
  const bytes = typeof manifest === "string" ? enc(manifest) : manifest;
  return bodyResponse(JSON.stringify(await signManifest(bytes)));
}

function fakeFetch(routes: Record<string, Route>): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    const record = await recordFor(url, routes);
    if (record) return record;
    const route = routes[url];
    if (!route) {
      // An unrouted `.gz` models a pre-#1235 ring with no archive: answer 404 so
      // the raw-asset fallback is exercised. Any other unrouted URL is a bug.
      // Read `dl=` rather than the URL's tail, since `&ring=` follows it.
      if (new URL(url).searchParams.get("dl")?.endsWith(".gz")) {
        return {
          ok: false,
          status: 404,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
        } as Response;
      }
      throw new TypeError(`no fake route for ${url}`);
    }
    if (route.throwErr) throw route.throwErr;
    const status = route.status ?? 200;
    const body = route.body ?? "";
    const bytes = typeof body === "string" ? enc(body) : body;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => new TextDecoder().decode(bytes),
      arrayBuffer: async () => new Uint8Array(bytes).buffer,
    } as Response;
  }) as unknown as typeof fetch;
}

/** In-memory fs with `currentBytes` preloaded at `execPath`; `confirm` says yes. */
function makeDeps(
  overrides: Partial<UpdateDeps> = {},
  currentBytes: Uint8Array = enc("OLD-BINARY"),
) {
  const out: string[] = [];
  const err: string[] = [];
  const confirmCalls: string[] = [];
  const chmodCalls: Array<[string, number]> = [];
  const quarantineCalls: string[] = [];
  let sweepCalls = 0;
  const execPath = "/home/u/.local/bin/wego";
  const tempPath = `${execPath}.tmp`;
  const files = new Map<string, Uint8Array>();
  files.set(execPath, currentBytes);

  const missing = (path: string) =>
    Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });

  const deps: UpdateDeps = {
    log: (m) => out.push(m),
    error: (m) => err.push(m),
    version: "0.1.0",
    fromSource: false,
    installRecordPath: "/home/u/.config/wego/install.json",
    readInstallRecord: async () => ({ ring: RING, installUrl: BASE }),
    installUrl: "https://api.wego.com/install",
    platform: "linux",
    arch: "x64",
    execPath,
    fetch: fakeFetch({}),
    trustedRootsPem: TEST_ROOT_PEM,
    gunzip: (data) => Bun.gunzipSync(data),
    hashFile: async (path) => {
      const bytes = files.get(path);
      if (!bytes) throw missing(path);
      return sha256Hex(bytes);
    },
    writeFile: async (path, data) => {
      files.set(path, data);
    },
    chmod: async (path, mode) => {
      chmodCalls.push([path, mode]);
    },
    rename: async (from, to) => {
      const bytes = files.get(from);
      if (!bytes) throw missing(from);
      files.delete(from);
      files.set(to, bytes);
    },
    rm: async (path) => {
      files.delete(path);
    },
    clearQuarantine: async (path) => {
      quarantineCalls.push(path);
    },
    confirm: async (q) => {
      confirmCalls.push(q);
      return true;
    },
    tempPath,
    sweepTemps: async () => {
      sweepCalls += 1;
    },
    ...overrides,
  };
  return {
    deps,
    out,
    err,
    files,
    confirmCalls,
    chmodCalls,
    quarantineCalls,
    execPath,
    tempPath,
    sweeps: () => sweepCalls,
  };
}

describe("parseUpdateArgs", () => {
  it("defaults to no flags", () => {
    expect(parseUpdateArgs([])).toEqual({
      check: false,
      yes: false,
      force: false,
    });
  });

  it("parses --check, -y/--yes, and --force", () => {
    expect(parseUpdateArgs(["--check"])).toMatchObject({ check: true });
    expect(parseUpdateArgs(["-y"])).toMatchObject({ yes: true });
    expect(parseUpdateArgs(["--yes"])).toMatchObject({ yes: true });
    expect(parseUpdateArgs(["--force", "--check"])).toMatchObject({
      force: true,
      check: true,
    });
  });

  it("rejects an unknown flag and a stray positional", () => {
    expect(() => parseUpdateArgs(["--nope"])).toThrow(/Unknown option: --nope/);
    expect(() => parseUpdateArgs(["extra"])).toThrow(
      /Unexpected argument: extra/,
    );
  });
});

describe("update", () => {
  it("prints usage for --help without touching the network", async () => {
    const { deps, out } = makeDeps({
      fetch: fakeFetch({}), // any call throws (no routes)
    });
    expect(await update(["--help"], deps)).toBe(EXIT.OK);
    expect(out[0]).toBe(UPDATE_USAGE);
  });

  it("returns a usage error on a bad flag", async () => {
    const { deps, err } = makeDeps();
    expect(await update(["--bogus"], deps)).toBe(EXIT.USAGE);
    expect(err[0]).toMatch(/Unknown option: --bogus/);
  });

  it("refuses to self-update from source (0.0.0-dev), with a reinstall hint", async () => {
    const { deps, out } = makeDeps({ version: "0.0.0-dev" });
    expect(await update([], deps)).toBe(EXIT.OK);
    expect(out.join("\n")).toMatch(/running from source/);
    expect(out.join("\n")).toContain(
      "curl -fsSL https://api.wego.com/install | bash",
    );
  });

  it("refuses a source run even when WEGO_BUILD_VERSION + base are set (fromSource wins over version)", async () => {
    // A source run (`bun run src/index.ts`) that inherits WEGO_BUILD_VERSION
    // reports a non-dev version, but execPath is the Bun runtime, so self-update
    // must not rename over it.
    const { deps, out } = makeDeps({ version: "0.2.2", fromSource: true });
    expect(await update([], deps)).toBe(EXIT.OK);
    expect(out.join("\n")).toMatch(/running from source/);
    expect(out.join("\n")).toContain(
      "curl -fsSL https://api.wego.com/install | bash",
    );
  });

  it("refuses when the install recorded no ring, naming the record and the reinstall line", async () => {
    // `update` replaces the binary on a checksum difference alone, so with no
    // recorded ring there is nothing safe to guess. It must fail, not degrade to a
    // hint.
    const { deps, err, out } = makeDeps({
      readInstallRecord: async () => null,
    });
    expect(await update([], deps)).toBe(EXIT.PERMANENT);
    expect(err.join("\n")).toMatch(/no release ring recorded/);
    expect(err.join("\n")).toContain("/home/u/.config/wego/install.json");
    expect(err.join("\n")).toContain(
      "curl -fsSL https://api.wego.com/install | bash",
    );
    expect(out).toHaveLength(0);
  });

  it("refuses a missing record on --check too", async () => {
    const { deps, err } = makeDeps({ readInstallRecord: async () => null });
    expect(await update(["--check"], deps)).toBe(EXIT.PERMANENT);
    expect(err.join("\n")).toMatch(/refusing to guess/);
  });

  it("uses the placeholder host when no install URL was baked", async () => {
    const { deps, out } = makeDeps({
      version: "0.0.0-dev",
      installUrl: undefined,
    });
    expect(await update([], deps)).toBe(EXIT.OK);
    expect(out.join("\n")).toContain("<your-api-host>/install");
  });

  it("prints manual instructions on Windows", async () => {
    const { deps, out } = makeDeps({ platform: "win32" });
    expect(await update([], deps)).toBe(EXIT.OK);
    expect(out.join("\n")).toContain(
      `${BASE}?dl=wego-windows-x64.exe&ring=${RING}`,
    );
    expect(out.join("\n")).toContain("/home/u/.local/bin/wego");
  });

  it("errors on an unsupported architecture", async () => {
    const { deps, err } = makeDeps({ arch: "ppc64" });
    expect(await update([], deps)).toBe(EXIT.ERROR);
    expect(err[0]).toMatch(/unsupported platform linux\/ppc64/);
  });

  it("reports already up to date and does not download", async () => {
    const current = enc("SAME");
    const sums = await sumsFor({ "wego-linux-x64": current });
    const { deps, out, chmodCalls } = makeDeps(
      {
        fetch: fakeFetch({
          [`${BASE}?dl=SHA256SUMS.txt&ring=${RING}`]: { body: sums },
        }),
      },
      current,
    );
    expect(await update([], deps)).toBe(EXIT.OK);
    // Names the ring so the user can see which pointer said so.
    expect(out.join("\n")).toMatch(
      /Already up to date \(0\.1\.0, ring latest\)/,
    );
    expect(chmodCalls).toHaveLength(0);
  });

  it("--check reports an available update without writing", async () => {
    const latest = enc("NEW");
    const sums = await sumsFor({ "wego-linux-x64": latest });
    const { deps, out, files, execPath } = makeDeps(
      {
        fetch: fakeFetch({
          [`${BASE}?dl=SHA256SUMS.txt&ring=${RING}`]: { body: sums },
          [`${BASE}?dl=wego-linux-x64&ring=${RING}`]: { body: latest },
        }),
      },
      enc("OLD"),
    );
    expect(await update(["--check"], deps)).toBe(EXIT.OK);
    expect(out.join("\n")).toMatch(/update is available/);
    expect(new TextDecoder().decode(files.get(execPath))).toBe("OLD");
  });

  it("downloads, verifies, and atomically replaces the running binary", async () => {
    const latest = enc("NEW-BINARY");
    const sums = await sumsFor({ "wego-linux-x64": latest });
    const {
      deps,
      out,
      files,
      execPath,
      tempPath,
      chmodCalls,
      quarantineCalls,
    } = makeDeps(
      {
        fetch: fakeFetch({
          [`${BASE}?dl=SHA256SUMS.txt&ring=${RING}`]: { body: sums },
          [`${BASE}?dl=wego-linux-x64&ring=${RING}`]: { body: latest },
        }),
      },
      enc("OLD-BINARY"),
    );
    expect(await update(["-y"], deps)).toBe(EXIT.OK);
    expect(new TextDecoder().decode(files.get(execPath))).toBe("NEW-BINARY");
    expect(files.has(`${tempPath}`)).toBe(false);
    expect(chmodCalls).toEqual([[`${tempPath}`, 0o755]]);
    expect(quarantineCalls).toHaveLength(0);
    expect(out.join("\n")).toMatch(/Updated wego/);
  });

  it("prefers the gzipped asset: decompresses it and replaces in place", async () => {
    const latest = enc("NEW-BINARY");
    const gz = Bun.gzipSync(latest);
    // Only the raw line is listed: `update` verifies the decompressed bytes
    // against the raw checksum, never the archive against its own line.
    const sums = await sumsFor({ "wego-linux-x64": latest });
    const { deps, out, files, execPath, chmodCalls } = makeDeps(
      {
        fetch: fakeFetch({
          [`${BASE}?dl=SHA256SUMS.txt&ring=${RING}`]: { body: sums },
          // Raw asset not served, so success proves the gz path was taken.
          [`${BASE}?dl=wego-linux-x64.gz&ring=${RING}`]: { body: gz },
        }),
      },
      enc("OLD-BINARY"),
    );
    expect(await update(["-y"], deps)).toBe(EXIT.OK);
    expect(new TextDecoder().decode(files.get(execPath))).toBe("NEW-BINARY");
    expect(chmodCalls).toHaveLength(1);
    expect(out.join("\n")).toMatch(/Updated wego/);
  });

  it("falls back to the raw asset when the gz is absent (404)", async () => {
    const latest = enc("NEW-RAW");
    const sums = await sumsFor({ "wego-linux-x64": latest });
    const { deps, files, execPath } = makeDeps(
      {
        fetch: fakeFetch({
          [`${BASE}?dl=SHA256SUMS.txt&ring=${RING}`]: { body: sums },
          [`${BASE}?dl=wego-linux-x64.gz&ring=${RING}`]: { status: 404 },
          [`${BASE}?dl=wego-linux-x64&ring=${RING}`]: { body: latest },
        }),
      },
      enc("OLD"),
    );
    expect(await update(["-y"], deps)).toBe(EXIT.OK);
    expect(new TextDecoder().decode(files.get(execPath))).toBe("NEW-RAW");
  });

  it("aborts fail-closed when the gz decompresses to bytes that don't match the raw checksum", async () => {
    // A hard failure, never a silent downgrade to the raw asset (not served here).
    const gz = Bun.gzipSync(enc("TAMPERED"));
    const sums = await sumsFor({ "wego-linux-x64": enc("EXPECTED") });
    const { deps, err, files, execPath, tempPath } = makeDeps(
      {
        fetch: fakeFetch({
          [`${BASE}?dl=SHA256SUMS.txt&ring=${RING}`]: { body: sums },
          [`${BASE}?dl=wego-linux-x64.gz&ring=${RING}`]: { body: gz },
        }),
      },
      enc("OLD"),
    );
    expect(await update(["-y"], deps)).toBe(EXIT.PERMANENT);
    expect(err[0]).toMatch(/checksum mismatch/);
    expect(new TextDecoder().decode(files.get(execPath))).toBe("OLD");
    expect(files.has(`${tempPath}`)).toBe(false);
  });

  it("fails hard on a non-404 gz error (5xx) and does NOT fall back to raw", async () => {
    // Only a 404 falls back. A 5xx does not mean the archive is absent, so the
    // raw asset is served here but must never be reached.
    const latest = enc("NEW");
    const sums = await sumsFor({ "wego-linux-x64": latest });
    const { deps, err, files, execPath } = makeDeps(
      {
        fetch: fakeFetch({
          [`${BASE}?dl=SHA256SUMS.txt&ring=${RING}`]: { body: sums },
          [`${BASE}?dl=wego-linux-x64.gz&ring=${RING}`]: { status: 503 },
          [`${BASE}?dl=wego-linux-x64&ring=${RING}`]: { body: latest },
        }),
      },
      enc("OLD"),
    );
    expect(await update(["-y"], deps)).not.toBe(EXIT.OK);
    expect(err[0]).toMatch(/update failed/);
    expect(new TextDecoder().decode(files.get(execPath))).toBe("OLD");
  });

  it("fails hard on a present-but-corrupt gz and does NOT fall back to raw", async () => {
    const latest = enc("NEW");
    const sums = await sumsFor({ "wego-linux-x64": latest });
    const { deps, files, execPath } = makeDeps(
      {
        fetch: fakeFetch({
          [`${BASE}?dl=SHA256SUMS.txt&ring=${RING}`]: { body: sums },
          [`${BASE}?dl=wego-linux-x64.gz&ring=${RING}`]: {
            body: enc("not-a-gzip-stream"),
          },
          // Served but must never be reached: a corrupt archive is fatal.
          [`${BASE}?dl=wego-linux-x64&ring=${RING}`]: { body: latest },
        }),
      },
      enc("OLD"),
    );
    expect(await update(["-y"], deps)).not.toBe(EXIT.OK);
    expect(new TextDecoder().decode(files.get(execPath))).toBe("OLD");
  });

  it("clears the quarantine xattr on macOS", async () => {
    const latest = enc("MAC-NEW");
    const sums = await sumsFor({ "wego-darwin-arm64": latest });
    const { deps, quarantineCalls, tempPath } = makeDeps(
      {
        platform: "darwin",
        arch: "arm64",
        fetch: fakeFetch({
          [`${BASE}?dl=SHA256SUMS.txt&ring=${RING}`]: { body: sums },
          [`${BASE}?dl=wego-darwin-arm64&ring=${RING}`]: { body: latest },
        }),
      },
      enc("MAC-OLD"),
    );
    expect(await update(["-y"], deps)).toBe(EXIT.OK);
    expect(quarantineCalls).toEqual([`${tempPath}`]);
  });

  it("skips (no write) when the confirm is declined", async () => {
    const latest = enc("NEW");
    const sums = await sumsFor({ "wego-linux-x64": latest });
    const { deps, out, files, execPath } = makeDeps(
      {
        confirm: async () => false,
        fetch: fakeFetch({
          [`${BASE}?dl=SHA256SUMS.txt&ring=${RING}`]: { body: sums },
          [`${BASE}?dl=wego-linux-x64&ring=${RING}`]: { body: latest },
        }),
      },
      enc("OLD"),
    );
    expect(await update([], deps)).toBe(EXIT.OK);
    expect(out.join("\n")).toBe("Skipped.");
    expect(new TextDecoder().decode(files.get(execPath))).toBe("OLD");
  });

  it("bypasses the confirm with -y", async () => {
    const latest = enc("NEW");
    const sums = await sumsFor({ "wego-linux-x64": latest });
    const { deps, confirmCalls } = makeDeps(
      {
        fetch: fakeFetch({
          [`${BASE}?dl=SHA256SUMS.txt&ring=${RING}`]: { body: sums },
          [`${BASE}?dl=wego-linux-x64&ring=${RING}`]: { body: latest },
        }),
      },
      enc("OLD"),
    );
    expect(await update(["-y"], deps)).toBe(EXIT.OK);
    expect(confirmCalls).toHaveLength(0);
  });

  it("--force re-downloads even when already up to date", async () => {
    const same = enc("SAME");
    const sums = await sumsFor({ "wego-linux-x64": same });
    const { deps, chmodCalls } = makeDeps(
      {
        fetch: fakeFetch({
          [`${BASE}?dl=SHA256SUMS.txt&ring=${RING}`]: { body: sums },
          [`${BASE}?dl=wego-linux-x64&ring=${RING}`]: { body: same },
        }),
      },
      same,
    );
    expect(await update(["--force", "-y"], deps)).toBe(EXIT.OK);
    expect(chmodCalls).toHaveLength(1);
  });

  it("aborts fail-closed on a checksum mismatch, leaving the binary intact", async () => {
    const sums = await sumsFor({ "wego-linux-x64": enc("EXPECTED") });
    const { deps, err, files, execPath, tempPath } = makeDeps(
      {
        fetch: fakeFetch({
          [`${BASE}?dl=SHA256SUMS.txt&ring=${RING}`]: { body: sums },
          [`${BASE}?dl=wego-linux-x64&ring=${RING}`]: { body: enc("TAMPERED") },
        }),
      },
      enc("OLD"),
    );
    expect(await update(["-y"], deps)).toBe(EXIT.PERMANENT);
    expect(err[0]).toMatch(/checksum mismatch/);
    expect(new TextDecoder().decode(files.get(execPath))).toBe("OLD");
    expect(files.has(`${tempPath}`)).toBe(false);
  });

  it("refuses when the asset is not listed in SHA256SUMS.txt", async () => {
    const sums = await sumsFor({ "some-other-asset-linux-x64": enc("other") });
    const { deps, err } = makeDeps(
      {
        fetch: fakeFetch({
          [`${BASE}?dl=SHA256SUMS.txt&ring=${RING}`]: { body: sums },
        }),
      },
      enc("OLD"),
    );
    expect(await update(["-y"], deps)).toBe(EXIT.PERMANENT);
    expect(err[0]).toMatch(/not listed in .*SHA256SUMS\.txt/);
  });

  it("reports a friendly permission error when the replace is denied", async () => {
    const latest = enc("NEW");
    const sums = await sumsFor({ "wego-linux-x64": latest });
    const { deps, err, files, tempPath } = makeDeps(
      {
        rename: async () => {
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        },
        fetch: fakeFetch({
          [`${BASE}?dl=SHA256SUMS.txt&ring=${RING}`]: { body: sums },
          [`${BASE}?dl=wego-linux-x64&ring=${RING}`]: { body: latest },
        }),
      },
      enc("OLD"),
    );
    expect(await update(["-y"], deps)).toBe(EXIT.ERROR);
    expect(err[0]).toMatch(/permission denied/);
    expect(err[0]).toContain("curl -fsSL https://api.wego.com/install | bash");
    expect(files.has(`${tempPath}`)).toBe(false);
  });

  it("surfaces a download failure as a non-zero exit", async () => {
    const sums = await sumsFor({ "wego-linux-x64": enc("NEW") });
    const { deps, err } = makeDeps(
      {
        fetch: fakeFetch({
          [`${BASE}?dl=SHA256SUMS.txt&ring=${RING}`]: { body: sums },
          [`${BASE}?dl=wego-linux-x64&ring=${RING}`]: { status: 503 },
        }),
      },
      enc("OLD"),
    );
    const code = await update(["-y"], deps);
    expect(code).not.toBe(EXIT.OK);
    expect(err[0]).toMatch(/update failed/);
  });

  it("surfaces a checksums fetch failure as 'could not check for updates'", async () => {
    const { deps, err } = makeDeps(
      {
        fetch: fakeFetch({
          [`${BASE}?dl=SHA256SUMS.txt&ring=${RING}`]: { status: 500 },
        }),
      },
      enc("OLD"),
    );
    const code = await update([], deps);
    expect(code).not.toBe(EXIT.OK);
    expect(err[0]).toMatch(/could not check for updates/);
  });

  it("maps a download deadline (TimeoutError) to the timeout exit class", async () => {
    const sums = await sumsFor({ "wego-linux-x64": enc("NEW") });
    const { deps } = makeDeps(
      {
        fetch: fakeFetch({
          [`${BASE}?dl=SHA256SUMS.txt&ring=${RING}`]: { body: sums },
          [`${BASE}?dl=wego-linux-x64&ring=${RING}`]: {
            throwErr: new DOMException(
              "The operation timed out.",
              "TimeoutError",
            ),
          },
        }),
      },
      enc("OLD"),
    );
    expect(await update(["-y"], deps)).toBe(EXIT.TIMEOUT);
  });

  it("attaches an abort-signal deadline to every fetch", async () => {
    const latest = enc("NEW");
    const sums = await sumsFor({ "wego-linux-x64": latest });
    const seen: Array<{ url: string; hasSignal: boolean }> = [];
    const recordingFetch = (async (url: string, init?: RequestInit) => {
      seen.push({
        url: String(url),
        hasSignal: init?.signal instanceof AbortSignal,
      });
      // Three fetches: the signed build record, the sums it vouches for, and the
      // `<asset>.gz` download.
      const body = await servedBody(
        new URL(String(url)).searchParams.get("dl"),
        sums,
        latest,
      );
      const bytes = typeof body === "string" ? enc(body) : body;
      return {
        ok: true,
        status: 200,
        text: async () => new TextDecoder().decode(bytes),
        arrayBuffer: async () => new Uint8Array(bytes).buffer,
      } as Response;
    }) as unknown as typeof fetch;
    const { deps } = makeDeps({ fetch: recordingFetch }, enc("OLD"));
    expect(await update(["-y"], deps)).toBe(EXIT.OK);
    expect(seen.length).toBe(3);
    expect(seen.every((c) => c.hasSignal)).toBe(true);
  });

  // foundations#74 rung 9: the manifest decides whether to replace the binary, so
  // it is never trusted on the store's word alone.
  it("refuses when the ring serves no signed build record", async () => {
    const latest = enc("NEW");
    const sums = await sumsFor({ "wego-linux-x64": latest });
    const { deps, err } = makeDeps(
      {
        fetch: fakeFetch({
          [`${BASE}?dl=SHA256SUMS.txt&ring=${RING}`]: { body: sums },
          // Treating "no record" as "not signed yet" would hand any store writer
          // a downgrade: delete the record and verification turns itself off.
          [`${BASE}?dl=SHA256SUMS.txt.sigstore.json&ring=${RING}&sig=1`]: {
            status: 404,
          },
          [`${BASE}?dl=wego-linux-x64&ring=${RING}`]: { body: latest },
        }),
      },
      enc("OLD"),
    );
    expect(await update(["-y"], deps)).toBe(EXIT.PERMANENT);
    expect(err.join("\n")).toContain("signed build record");
  });

  // Both refuse; the exit code differs. A wrapper branches on the
  // `src/error-report.ts` taxonomy, so an unreached host must not read as
  // PERMANENT, and an absent record must not invite a retry loop.
  it("reports an unreachable record host as a timeout, not a permanent refusal", async () => {
    const latest = enc("NEW");
    const sums = await sumsFor({ "wego-linux-x64": latest });
    const { deps, err } = makeDeps(
      {
        fetch: fakeFetch({
          [`${BASE}?dl=SHA256SUMS.txt&ring=${RING}`]: { body: sums },
          // The deadline fires rather than a status being served, so nothing is
          // known about whether a record exists.
          [`${BASE}?dl=SHA256SUMS.txt.sigstore.json&ring=${RING}&sig=1`]: {
            throwErr: new DOMException(
              "The operation timed out.",
              "TimeoutError",
            ),
          },
          [`${BASE}?dl=wego-linux-x64&ring=${RING}`]: { body: latest },
        }),
      },
      enc("OLD"),
    );
    expect(await update(["-y"], deps)).toBe(EXIT.TIMEOUT);
    expect(err.join("\n")).toContain("signed build record");
    // No reinstall advice: this is temporary, and reinstalling over a network
    // blip trades a working install for a transient failure.
    expect(err.join("\n")).not.toContain("Reinstall the latest with:");
  });

  it("refuses a record that does not vouch for the manifest served with it", async () => {
    const latest = enc("NEW");
    const sums = await sumsFor({ "wego-linux-x64": latest });
    // A correctly signed record over different bytes: the swap a store writer
    // would make, keeping a valid-looking record and changing the manifest.
    const record = JSON.stringify(await signManifest(enc("other manifest\n")));
    const { deps, err } = makeDeps(
      {
        fetch: fakeFetch({
          [`${BASE}?dl=SHA256SUMS.txt&ring=${RING}`]: { body: sums },
          [`${BASE}?dl=SHA256SUMS.txt.sigstore.json&ring=${RING}&sig=1`]: {
            body: record,
          },
          [`${BASE}?dl=wego-linux-x64&ring=${RING}`]: { body: latest },
        }),
      },
      enc("OLD"),
    );
    // RETRYABLE, not PERMANENT: a ring mid-promote serves exactly this.
    // `upload-release-blob.ts` writes the record and the manifest separately, so a
    // reader between them, or a cache straddling them, sees a record for the other
    // manifest. It clears on its own.
    expect(await update(["-y"], deps)).toBe(EXIT.RETRYABLE);
    const out = err.join("\n");
    expect(out).toContain("not vouched for");
    expect(out).toContain("may be mid-update");
    expect(out).toContain("Nothing was installed");
    // Waiting fixes this, so no reinstall advice.
    expect(out).not.toContain("Reinstall the latest with:");
  });

  // Identity is the one dead end: the ring serves a record signed by an identity
  // this binary's trust set does not accept. Waiting never helps and only a build
  // with different rules can take it, so reinstalling is the remedy here and
  // nowhere else. Every 1.2.0 and 1.2.1 install hit this when `cli/stable` served
  // a record signed under wego-ai's `cli-v1.1.0` tag (wego/cli#29).
  it("tells the user to reinstall when the RECORD'S IDENTITY is not accepted", async () => {
    const latest = enc("NEW");
    const sums = await sumsFor({ "wego-linux-x64": latest });
    // A correctly signed record over the right bytes, re-issued to a leaf whose
    // SAN names a workflow this binary does not trust. Identity is checked before
    // any cryptography, so the swap alone produces the refusal.
    const signed = (await signManifest(sums)) as {
      verificationMaterial: { certificate: { rawBytes: string } };
    };
    signed.verificationMaterial.certificate.rawBytes = OTHER_IDENTITY_CERT_DER;
    const { deps, err } = makeDeps(
      {
        fetch: fakeFetch({
          [`${BASE}?dl=SHA256SUMS.txt&ring=${RING}`]: { body: sums },
          [`${BASE}?dl=SHA256SUMS.txt.sigstore.json&ring=${RING}&sig=1`]: {
            body: JSON.stringify(signed),
          },
          [`${BASE}?dl=wego-linux-x64&ring=${RING}`]: { body: latest },
        }),
      },
      enc("OLD"),
    );
    expect(await update(["-y"], deps)).toBe(EXIT.PERMANENT);
    const out = err.join("\n");
    expect(out).toContain("not vouched for");
    expect(out).toContain("Reinstall the latest with:");
    expect(out).toContain("curl -fsSL");
    expect(out).toContain("retrying will not change that");
    expect(out).not.toContain("may be mid-update");
  });

  // Through the same first-party endpoint, so the release store's hostname stays
  // server-side.
  it("fetches the record for the ring it follows, marked as a record", async () => {
    const latest = enc("NEW");
    const sums = await sumsFor({ "wego-linux-x64": latest });
    const seen: string[] = [];
    const recordingFetch = (async (url: string) => {
      seen.push(String(url));
      const body = await servedBody(
        new URL(String(url)).searchParams.get("dl"),
        sums,
        latest,
      );
      const bytes = typeof body === "string" ? enc(body) : body;
      return {
        ok: true,
        status: 200,
        text: async () => new TextDecoder().decode(bytes),
        arrayBuffer: async () => new Uint8Array(bytes).buffer,
      } as Response;
    }) as unknown as typeof fetch;
    const { deps } = makeDeps({ fetch: recordingFetch }, enc("OLD"));
    expect(await update(["-y"], deps)).toBe(EXIT.OK);
    expect(
      seen.includes(
        `${BASE}?dl=SHA256SUMS.txt.sigstore.json&ring=${RING}&sig=1`,
      ),
    ).toBe(true);
  });

  it("rejects a non-HTTPS channel base at runtime (defense-in-depth)", async () => {
    const { deps, err } = makeDeps({
      readInstallRecord: async () => ({
        ring: "latest",
        installUrl: "http://evil.example/install",
      }),
      // No routes: the guard must fire before any network call.
      fetch: fakeFetch({}),
    });
    expect(await update(["--check"], deps)).toBe(EXIT.PERMANENT);
    expect(err[0]).toMatch(/HTTPS/);
  });

  it("allows a loopback http base for local dev", async () => {
    const base = "http://127.0.0.1:8799/install";
    const current = enc("SAME");
    const sums = await sumsFor({ "wego-linux-x64": current });
    const { deps, out } = makeDeps(
      {
        readInstallRecord: async () => ({ ring: "staging", installUrl: base }),
        fetch: fakeFetch({
          [`${base}?dl=SHA256SUMS.txt&ring=staging`]: { body: sums },
        }),
      },
      current,
    );
    expect(await update(["--check"], deps)).toBe(EXIT.OK);
    expect(out.join("\n")).toMatch(/Already up to date/);
  });

  it("sweeps stale temp siblings before downloading", async () => {
    const latest = enc("NEW");
    const sums = await sumsFor({ "wego-linux-x64": latest });
    const { deps, sweeps } = makeDeps(
      {
        fetch: fakeFetch({
          [`${BASE}?dl=SHA256SUMS.txt&ring=${RING}`]: { body: sums },
          [`${BASE}?dl=wego-linux-x64&ring=${RING}`]: { body: latest },
        }),
      },
      enc("OLD"),
    );
    expect(await update(["-y"], deps)).toBe(EXIT.OK);
    expect(sweeps()).toBe(1);
  });

  it("reports an actionable disk-space error (ENOSPC)", async () => {
    const latest = enc("NEW");
    const sums = await sumsFor({ "wego-linux-x64": latest });
    const { deps, err } = makeDeps(
      {
        writeFile: async () => {
          throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
        },
        fetch: fakeFetch({
          [`${BASE}?dl=SHA256SUMS.txt&ring=${RING}`]: { body: sums },
          [`${BASE}?dl=wego-linux-x64&ring=${RING}`]: { body: latest },
        }),
      },
      enc("OLD"),
    );
    expect(await update(["-y"], deps)).toBe(EXIT.ERROR);
    expect(err[0]).toMatch(/disk space/);
  });
});
