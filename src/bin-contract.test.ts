import { describe, expect, it } from "bun:test";
import {
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

interface PackageManifest {
  bin?: Record<string, string>;
  scripts?: Record<string, string>;
}

const cliRoot = join(import.meta.dir, "..");
const manifest = JSON.parse(
  readFileSync(join(cliRoot, "package.json"), "utf8"),
) as PackageManifest;

describe("local wego bin contract", () => {
  it("links the executable Bun source entrypoint through package.json", () => {
    expect(manifest.bin).toEqual({ wego: "src/index.ts" });

    const entrypoint = join(cliRoot, manifest.bin?.wego ?? "");
    expect(statSync(entrypoint).mode & 0o111).not.toBe(0);
    expect(readFileSync(entrypoint, "utf8").split("\n", 1)[0]).toBe(
      "#!/usr/bin/env bun",
    );
  });

  it("exposes the live-source wego on PATH via the direnv golden path", () => {
    // The repo-root `.envrc` prepends `.bin` to PATH, and `.bin/wego` is a
    // relative symlink to the `bin` entrypoint, so `wego` runs the TS source with
    // no compile and no dev launcher scripts.
    expect(manifest.scripts?.["dev:claude"]).toBeUndefined();
    expect(manifest.scripts?.["dev:codex"]).toBeUndefined();

    const shim = join(cliRoot, ".bin", "wego");
    expect(lstatSync(shim).isSymbolicLink()).toBe(true);
    // Relative, never a machine-local absolute path.
    expect(readlinkSync(shim).startsWith("/")).toBe(false);
    const entrypoint = join(cliRoot, manifest.bin?.wego ?? "");
    expect(realpathSync(shim)).toBe(realpathSync(entrypoint));

    expect(readFileSync(join(cliRoot, ".envrc"), "utf8")).toContain(
      "PATH_add .bin",
    );
  });
});
