import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultTelemetryPath } from "./config";
import {
  clearTelemetryState,
  loadTelemetryState,
  persistDeviceId,
  saveTelemetryState,
  setTelemetryEnabled,
} from "./telemetry-state";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wego-telemetry-"));
  path = join(dir, "nested", "telemetry.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("telemetry state file", () => {
  it("round-trips the machine id and the setting, creating the directory", async () => {
    await saveTelemetryState(path, { deviceId: "dev-1", enabled: false });
    expect(await loadTelemetryState(path)).toEqual({
      deviceId: "dev-1",
      enabled: false,
    });
  });

  it("reports enabled with no id when the file does not exist", async () => {
    expect(await loadTelemetryState(path)).toEqual({ enabled: true });
  });

  it("creates nothing when only read", async () => {
    await loadTelemetryState(path);
    await expect(stat(path)).rejects.toThrow();
  });

  it("fails CLOSED on malformed or unparseable contents", async () => {
    // The file may hold an opt-out, so an unreadable one must not be read as
    // consent. A torn write previously resurrected telemetry silently.
    await saveTelemetryState(path, { enabled: false });
    await writeFile(path, '{"enabled": false, "deviceI');
    expect(await loadTelemetryState(path)).toEqual({ enabled: false });
    await writeFile(path, JSON.stringify({ enabled: "yes-please" }));
    expect(await loadTelemetryState(path)).toEqual({ enabled: false });
  });

  it("fails closed when the file exists but cannot be read", async () => {
    await saveTelemetryState(path, { enabled: false });
    await chmod(path, 0o000);
    expect(await loadTelemetryState(path)).toEqual({ enabled: false });
    await chmod(path, 0o600);
  });

  it("leaves no temporary file behind, since the write is a rename", async () => {
    await saveTelemetryState(path, { deviceId: "dev-1", enabled: true });
    const leftovers = (await readdir(dirname(path))).filter((f) =>
      f.endsWith(".tmp"),
    );
    expect(leftovers).toEqual([]);
  });

  it("defaults a file with an id but no setting to enabled", async () => {
    await saveTelemetryState(path, { deviceId: "dev-1", enabled: true });
    await writeFile(path, JSON.stringify({ deviceId: "dev-1" }));
    expect(await loadTelemetryState(path)).toEqual({
      deviceId: "dev-1",
      enabled: true,
    });
  });

  it("writes owner-only, in an owner-only directory", async () => {
    await saveTelemetryState(path, { deviceId: "dev-1", enabled: true });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "nested")).then((s) => s.mode)) & 0o777).toBe(
      0o700,
    );
  });

  it("keeps the machine id when the setting is toggled", async () => {
    await persistDeviceId(path, "dev-1");
    expect(await setTelemetryEnabled(path, false)).toEqual({
      deviceId: "dev-1",
      enabled: false,
    });
    expect(await setTelemetryEnabled(path, true)).toEqual({
      deviceId: "dev-1",
      enabled: true,
    });
  });

  it("refuses to store a machine id while telemetry is disabled", async () => {
    // Otherwise the read-modify-write would overwrite an opt-out that landed
    // between the read and the write with a stale `enabled: true`.
    await setTelemetryEnabled(path, false);
    await persistDeviceId(path, "dev-2");
    expect(await loadTelemetryState(path)).toEqual({ enabled: false });
  });

  it("removes the file, and tolerates it already being gone", async () => {
    await persistDeviceId(path, "dev-1");
    await clearTelemetryState(path);
    await expect(stat(path)).rejects.toThrow();
    await clearTelemetryState(path);
  });
});

describe("defaultTelemetryPath", () => {
  it("honours an explicitly passed scope, which is how targets stay apart", () => {
    // The scope is still a parameter: `loadCliConfig` passes the target-aware leaf
    // (`targetConfigScope`) for the token-issuer state, and the bare `wego` for the
    // rest. Only the DEFAULT stopped varying.
    expect(defaultTelemetryPath({ XDG_CONFIG_HOME: "/cfg" }, "wego")).toBe(
      "/cfg/wego/telemetry.json",
    );
    expect(
      defaultTelemetryPath(
        { XDG_CONFIG_HOME: "/cfg" },
        "wego/auth.wegostaging.com",
      ),
    ).toBe("/cfg/wego/auth.wegostaging.com/telemetry.json");
  });

  it("is a sibling of the credentials file, not part of it", () => {
    expect(defaultTelemetryPath({ XDG_CONFIG_HOME: "/cfg" }, "wego")).toBe(
      "/cfg/wego/telemetry.json",
    );
  });

  it("falls back to ~/.config when XDG_CONFIG_HOME is unset", () => {
    expect(defaultTelemetryPath({}, "wego")).toMatch(
      /\/\.config\/wego\/telemetry\.json$/,
    );
  });
});
