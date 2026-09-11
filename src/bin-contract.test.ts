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

// The repo root: in wego-ai this was `apps/cli`, two levels below the monorepo
// root; here the CLI *is* the repository, so the two are the same directory.
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
    // The golden path is a repo-root `.envrc` that prepends `.bin` to PATH
    // (`apps/cli/.bin` while the CLI lived in wego-ai); `.bin/wego` is a relative
    // symlink to the same entrypoint `bin` names, so `wego` runs the TS source
    // with no compile. No dev launcher scripts.
    expect(manifest.scripts?.["dev:claude"]).toBeUndefined();
    expect(manifest.scripts?.["dev:codex"]).toBeUndefined();

    const shim = join(cliRoot, ".bin", "wego");
    expect(lstatSync(shim).isSymbolicLink()).toBe(true);
    // A relative link (never a machine-local absolute path) resolving to the
    // declared bin target — the same file `wego` would run when installed.
    expect(readlinkSync(shim).startsWith("/")).toBe(false);
    const entrypoint = join(cliRoot, manifest.bin?.wego ?? "");
    expect(realpathSync(shim)).toBe(realpathSync(entrypoint));

    expect(readFileSync(join(cliRoot, ".envrc"), "utf8")).toContain(
      "PATH_add .bin",
    );
  });
});
