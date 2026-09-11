import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearCredentials, loadCredentials, saveCredentials } from "./storage";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wego-cli-"));
  path = join(dir, "nested", "credentials.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("storage", () => {
  it("round-trips credentials and creates the directory", async () => {
    await saveCredentials(path, {
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: 123,
    });
    expect(await loadCredentials(path)).toEqual({
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: 123,
    });
  });

  it("writes the credentials file 0600 (owner-only)", async () => {
    await saveCredentials(path, { accessToken: "at" });
    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("tightens an existing world-readable file back to 0600 on save", async () => {
    await saveCredentials(path, { accessToken: "old" });
    await chmod(path, 0o644); // simulate a pre-existing loose-mode file
    await saveCredentials(path, { accessToken: "new" });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("returns null when the file is missing", async () => {
    expect(await loadCredentials(join(dir, "nope.json"))).toBeNull();
  });

  it("returns null on malformed or tokenless content", async () => {
    await saveCredentials(path, { accessToken: "at" });
    await Bun.write(path, "{ not json");
    expect(await loadCredentials(path)).toBeNull();
    await Bun.write(path, JSON.stringify({ refreshToken: "rt" }));
    expect(await loadCredentials(path)).toBeNull();
  });

  it("clear removes the file and is idempotent", async () => {
    await saveCredentials(path, { accessToken: "at" });
    await clearCredentials(path);
    expect(await loadCredentials(path)).toBeNull();
    await clearCredentials(path); // no throw on missing
  });
});
