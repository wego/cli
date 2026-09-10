import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultTelemetryPath } from "./config";
import {
  clearTelemetryState,
  inheritTelemetryOptOut,
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
  it("is flavor-scoped, so wego and wegostaging keep separate state", () => {
    const prod = defaultTelemetryPath({ XDG_CONFIG_HOME: "/cfg" }, "wego");
    const staging = defaultTelemetryPath(
      { XDG_CONFIG_HOME: "/cfg" },
      "wegostaging",
    );
    expect(prod).toBe("/cfg/wego/telemetry.json");
    expect(staging).toBe("/cfg/wegostaging/telemetry.json");
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

/**
 * The one file whose move is compensated rather than merely reported.
 *
 * Making the command name the config scope moved every per-install file. All but
 * this one fail in a direction that announces itself (the install looks logged
 * out; `update` refuses and names the old directory). Absent telemetry state means
 * ENABLED, so this one would fail by silently sending data a user had opted out
 * of - so the opt-out, and only the opt-out, is carried forward.
 */
describe("inheritTelemetryOptOut", () => {
  let legacy: string;
  beforeEach(() => {
    legacy = join(dir, "legacy", "telemetry.json");
  });

  it("carries an opt-out forward when the new path has no file yet", async () => {
    await saveTelemetryState(legacy, { deviceId: "dev-old", enabled: false });
    expect(await inheritTelemetryOptOut(path, legacy)).toBe(true);
    // The setting travels; the machine id does NOT - two installs sharing one
    // device id would report as one machine, and re-minting one is harmless.
    expect(await loadTelemetryState(path)).toEqual({ enabled: false });
  });

  it("does not carry an ENABLED legacy setting forward", async () => {
    // Nothing to protect: the default is already on, so seeding a file here would
    // only freeze a setting the user never chose.
    await saveTelemetryState(legacy, { deviceId: "dev-old", enabled: true });
    expect(await inheritTelemetryOptOut(path, legacy)).toBe(false);
    await expect(stat(path)).rejects.toThrow();
  });

  it("never overwrites a setting the new install already has", async () => {
    await saveTelemetryState(path, { deviceId: "dev-new", enabled: true });
    await saveTelemetryState(legacy, { enabled: false });
    expect(await inheritTelemetryOptOut(path, legacy)).toBe(false);
    expect(await loadTelemetryState(path)).toEqual({
      deviceId: "dev-new",
      enabled: true,
    });
  });

  it("is a no-op when there is no legacy directory to inherit from", async () => {
    // Every install whose command name still matches its release: `legacyScopeDir`
    // is undefined, so this costs no I/O at all.
    expect(await inheritTelemetryOptOut(path, undefined)).toBe(false);
    expect(await inheritTelemetryOptOut(path, path)).toBe(false);
    // An absent legacy file reads as enabled, so there is nothing to carry.
    expect(await inheritTelemetryOptOut(path, legacy)).toBe(false);
    await expect(stat(path)).rejects.toThrow();
  });

  it("inherits an unreadable legacy file as an opt-out", async () => {
    // `loadTelemetryState` fails closed on a file it cannot parse, and this keeps
    // the same answer: a file that may hold an opt-out is treated as one.
    // Written through the real saver first, so the directory exists, then
    // corrupted: an unparseable file's previous CONTENT is irrelevant.
    await saveTelemetryState(legacy, { enabled: true });
    await writeFile(legacy, "{ truncated", "utf8");
    expect(await inheritTelemetryOptOut(path, legacy)).toBe(true);
    expect(await loadTelemetryState(path)).toEqual({ enabled: false });
  });

  it("runs at most once, because the seed it writes is itself a setting", async () => {
    await saveTelemetryState(legacy, { enabled: false });
    expect(await inheritTelemetryOptOut(path, legacy)).toBe(true);
    expect(await inheritTelemetryOptOut(path, legacy)).toBe(false);
  });

  it("leaves a re-enable alone on the next run", async () => {
    // The seed must not fight the user: opting back IN on the new install has to
    // stick, even though the legacy file still says off.
    await saveTelemetryState(legacy, { enabled: false });
    await inheritTelemetryOptOut(path, legacy);
    await saveTelemetryState(path, { enabled: true });
    expect(await inheritTelemetryOptOut(path, legacy)).toBe(false);
    expect((await loadTelemetryState(path)).enabled).toBe(true);
  });
});
