/**
 * `verify-published.sh`, driven end to end against a fake Blob base.
 *
 * The script is the release path's last gate before a ring pointer moves. Its one
 * real decision is which native assets to check: a hardcoded name would refuse a
 * set that names its native differently, and ignore any second native.
 *
 * The harness is two PATH stubs and a temp dir, because the real script wants a
 * Linux release runner: `curl` becomes a copy out of a local `serve/` dir, the
 * "native binary" is a shell script that prints a version, and `sha256sum` is
 * shimmed to `shasum -a 256` only on hosts that lack it (macOS). The awk, the
 * manifest parsing and the control flow are the shipped ones.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "verify-published.sh");
const VERSION = "0.9.9";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const sha256 = (bytes: string) =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/** A stub `curl -fsSL … <url> -o <dest>` that copies out of `$SERVE`. */
const CURL_STUB = `#!/bin/sh
url=""; dest=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) dest="$2"; shift 2 ;;
    --connect-timeout|--max-time) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
name="\${url##*/}"
[ -f "$SERVE/$name" ] || exit 22
cp "$SERVE/$name" "$dest"
`;

/** A fake published asset set: name → file contents. */
type Assets = Record<string, string>;

/** A binary that answers `version` with `v`, so the run-and-compare step is real. */
const nativeBinary = (v: string) => `#!/bin/sh\necho ${v}\n`;

function stage(assets: Assets): { base: string; env: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), "verify-published-"));
  roots.push(root);
  const serve = join(root, "serve");
  const bin = join(root, "bin");
  mkdirSync(serve);
  mkdirSync(bin);

  const lines: string[] = [];
  for (const [name, body] of Object.entries(assets)) {
    writeFileSync(join(serve, name), body);
    lines.push(`${sha256(body)}  ${name}`);
  }
  writeFileSync(join(serve, "SHA256SUMS.txt"), `${lines.join("\n")}\n`);

  writeFileSync(join(bin, "curl"), CURL_STUB);
  chmodSync(join(bin, "curl"), 0o755);
  // Only shim where the real tool is absent; CI runs Linux and keeps its own.
  if (!Bun.which("sha256sum")) {
    writeFileSync(
      join(bin, "sha256sum"),
      `#!/bin/sh\nexec shasum -a 256 "$@"\n`,
    );
    chmodSync(join(bin, "sha256sum"), 0o755);
  }

  return {
    base: "https://blob.example/cli/x",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      SERVE: serve,
      HOME: root,
    },
  };
}

async function run(assets: Assets, mode: "all" | "native") {
  const { base, env } = stage(assets);
  const proc = Bun.spawn(["sh", SCRIPT, base, VERSION, mode], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

// The shape both call sites (`all` on cli/<tag>, `native` on the ring) see.
const RELEASE_SET: Assets = {
  "wego-linux-x64": nativeBinary(VERSION),
  "wego-darwin-arm64": "mach-o pretend bytes",
};

// A native not named `wego-linux-x64`: the script must run whatever `*-linux-x64`
// the manifest lists, not a hardcoded name.
const RENAMED_NATIVE = "mywego-linux-x64";

describe("verify-published.sh derives the native asset from the manifest", () => {
  test('the release set passes in `all` mode ("Verify immutable artifact")', async () => {
    const { code, stdout } = await run(RELEASE_SET, "all");
    expect(stdout).toContain("ok: wego-linux-x64");
    expect(code).toBe(0);
  });

  test('the release set passes in `native` mode ("Verify cli/<ring>")', async () => {
    const { code, stdout } = await run(RELEASE_SET, "native");
    // `native` skips the whole-manifest sweep, so the non-linux asset is untouched.
    expect(stdout).not.toContain("wego-darwin-arm64");
    expect(code).toBe(0);
  });

  test("a set whose native is NOT named wego-linux-x64 still passes", async () => {
    const { code, stdout } = await run(
      { [RENAMED_NATIVE]: nativeBinary(VERSION) },
      "native",
    );
    expect(stdout).toContain(`ok: ${RENAMED_NATIVE}`);
    expect(code).toBe(0);
  });

  test("EVERY listed native is really checked, not just the first", async () => {
    // A bad second native alongside a good first one must not pass.
    const { code, stderr } = await run(
      {
        "wego-linux-x64": nativeBinary(VERSION),
        [RENAMED_NATIVE]: nativeBinary("0.0.1"),
      },
      "native",
    );
    expect(stderr).toContain(`version mismatch for ${RENAMED_NATIVE}`);
    expect(code).toBe(1);
  });

  test("a manifest with no runnable native is an error, not a pass", async () => {
    const { code, stderr } = await run(
      { "wego-darwin-arm64": "mach-o pretend bytes" },
      "all",
    );
    expect(stderr).toContain("lists no *-linux-x64 asset");
    expect(code).toBe(1);
  });
});
