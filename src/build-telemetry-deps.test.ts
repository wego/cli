import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultCredentialsPath, defaultTelemetryPath } from "./config";
import {
  buildTelemetryDeps,
  forgetsIdentity,
  readTelemetrySnapshot,
  resolveAnalyticsHeaders,
  shouldResolveSession,
  shouldSendInline,
} from "./index";
import { TELEMETRY_SENDER_COMMAND } from "./telemetry";

/**
 * Wiring guard for telemetry. `telemetry.test.ts` covers the send DECISION against
 * injected deps; this covers the other half — that the real deps read and write the
 * right paths. A mis-wired dep here fails silently: a `loadState` that always threw
 * would look exactly like "no state yet", so a stored opt-out would stop being
 * honored with no error anywhere.
 *
 * Runs against a FIXTURE `XDG_CONFIG_HOME`, never the developer's real one.
 */

let home: string;
let previousXdg: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "wego-telemetry-wiring-"));
  previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = home;
});

afterEach(async () => {
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
  await rm(home, { recursive: true, force: true });
});

const statePath = () => defaultTelemetryPath(process.env, "wego");

describe("buildTelemetryDeps (real wiring)", () => {
  it("reports a from-source run, which is what keeps `bun test` silent", () => {
    expect(buildTelemetryDeps(0, 1).fromSource).toBe(true);
  });

  it("bakes no key from source, the second guard on the same thing", () => {
    expect(buildTelemetryDeps(0, 1).posthogKey).toBeUndefined();
  });

  it("reads the state file the config helper points at", async () => {
    await writeFile(statePath().replace("/telemetry.json", "-probe"), "").catch(
      () => {},
    );
    const deps = buildTelemetryDeps(0, 1);
    expect(await deps.loadState()).toEqual({ enabled: true });
    await deps.persistDeviceId("dev-wired");
    expect(await deps.loadState()).toEqual({
      enabled: true,
      deviceId: "dev-wired",
    });
    expect(JSON.parse(await readFile(statePath(), "utf8")).deviceId).toBe(
      "dev-wired",
    );
  });

  it("honors a stored opt-out through the real reader", async () => {
    const deps = buildTelemetryDeps(0, 1);
    await deps.persistDeviceId("dev-1");
    await writeFile(statePath(), JSON.stringify({ enabled: false }));
    expect((await deps.loadState()).enabled).toBe(false);
  });

  it("writes the state file owner-only, in an owner-only dir", async () => {
    await buildTelemetryDeps(0, 1).persistDeviceId("dev-1");
    expect((await stat(statePath())).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, "wego"))).mode & 0o777).toBe(0o700);
  });

  it("reads the uid from the credentials file the config helper points at", async () => {
    const claims = Buffer.from(JSON.stringify({ uid: 227935 })).toString(
      "base64url",
    );
    await buildTelemetryDeps(0, 1).persistDeviceId("dev-1"); // creates the dir
    await writeFile(
      defaultCredentialsPath(process.env, "wego"),
      JSON.stringify({ accessToken: `h.${claims}.s` }),
    );
    expect(await buildTelemetryDeps(0, 1).readUid()).toBe("227935");
  });

  it("reports no uid when there are no credentials", async () => {
    expect(await buildTelemetryDeps(0, 1).readUid()).toBeUndefined();
  });

  it("falls back to the pre-run snapshot once the real files are gone", async () => {
    // This is the `uninstall` case: the command deletes both files before the
    // post-command hook runs, and without the fallback the event is unattributed.
    const deps = buildTelemetryDeps(0, 1, {
      uid: "227935",
      deviceId: "dev-snapshot",
    });
    expect(await deps.readUid()).toBe("227935");
    expect((await deps.loadState()).deviceId).toBe("dev-snapshot");
  });

  it("does NOT fall back to the pre-run uid for `logout`", async () => {
    // Verified leak: without this, the inline sender (Windows, or a deleted
    // binary) reports the pre-logout account while the detached child reports
    // nobody — one command, two identities depending on the platform.
    const argv = process.argv;
    process.argv = ["/usr/local/bin/wego", "wego", "logout"];
    try {
      const deps = buildTelemetryDeps(0, 1, { uid: "227935" });
      expect(await deps.readUid()).toBeUndefined();
    } finally {
      process.argv = argv;
    }
  });

  it("still falls back to the pre-run uid for `uninstall`", async () => {
    const argv = process.argv;
    process.argv = ["/usr/local/bin/wego", "wego", "uninstall", "-y"];
    try {
      const deps = buildTelemetryDeps(0, 1, { uid: "227935" });
      expect(await deps.readUid()).toBe("227935");
    } finally {
      process.argv = argv;
    }
  });

  it("prefers the live files over the snapshot", async () => {
    const deps = buildTelemetryDeps(0, 1, { deviceId: "dev-stale" });
    await deps.persistDeviceId("dev-live");
    expect((await deps.loadState()).deviceId).toBe("dev-live");
  });

  it("prints the log payload to stderr, never stdout", () => {
    const deps = buildTelemetryDeps(0, 1);
    const original = process.stderr.write.bind(process.stderr);
    const seen: string[] = [];
    process.stderr.write = (chunk: string | Uint8Array) => {
      seen.push(String(chunk));
      return true;
    };
    try {
      deps.printPayload('{"probe":1}');
    } finally {
      process.stderr.write = original;
    }
    expect(seen.join("")).toContain('{"probe":1}');
  });

  it("mints distinct ids, so a machine id is not a constant", () => {
    const deps = buildTelemetryDeps(0, 1);
    expect(deps.randomUUID()).not.toBe(deps.randomUUID());
  });

  it("threads the exit code and duration through untouched", () => {
    const deps = buildTelemetryDeps(4, 1830);
    expect(deps.exitCode).toBe(4);
    expect(deps.durationMs).toBe(1830);
  });
});

describe("readTelemetrySnapshot (real wiring)", () => {
  it("reports nothing on a machine with no state and no credentials", async () => {
    expect(await readTelemetrySnapshot()).toEqual({
      uid: undefined,
      deviceId: undefined,
      telemetryEnabled: true,
    });
  });

  it("reads both the uid and the machine id when they exist", async () => {
    const claims = Buffer.from(JSON.stringify({ uid: 227935 })).toString(
      "base64url",
    );
    await buildTelemetryDeps(0, 1).persistDeviceId("dev-1");
    await writeFile(
      defaultCredentialsPath(process.env, "wego"),
      JSON.stringify({ accessToken: `h.${claims}.s` }),
    );
    expect(await readTelemetrySnapshot()).toEqual({
      uid: "227935",
      deviceId: "dev-1",
      telemetryEnabled: true,
    });
  });

  it("carries an id_token the API would still accept", async () => {
    const exp = Math.floor((Date.now() - 60_000) / 1000);
    const idToken = `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`;
    // Through the real dep first, so the flavor dir exists to write into.
    await buildTelemetryDeps(0, 1).persistDeviceId("dev-1");
    await writeFile(
      defaultCredentialsPath(process.env, "wego"),
      JSON.stringify({ accessToken: "h.e30.s", idToken }),
    );
    expect((await readTelemetrySnapshot()).idToken).toBe(idToken);
  });

  it("withholds one past the API's tolerance, which would ride every request of this process", async () => {
    const exp = Math.floor((Date.now() - 25 * 60 * 60 * 1000) / 1000);
    // Through the real dep first, so the flavor dir exists to write into.
    await buildTelemetryDeps(0, 1).persistDeviceId("dev-1");
    await writeFile(
      defaultCredentialsPath(process.env, "wego"),
      JSON.stringify({
        accessToken: "h.e30.s",
        idToken: `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`,
      }),
    );
    expect((await readTelemetrySnapshot()).idToken).toBeUndefined();
  });

  it("reports the opt-out, so the client-id header can honor it", async () => {
    // Through the real dep first, so the flavor dir exists to write into.
    await buildTelemetryDeps(0, 1).persistDeviceId("dev-1");
    await writeFile(
      defaultTelemetryPath(process.env, "wego"),
      JSON.stringify({ deviceId: "dev-1", enabled: false }),
    );
    expect((await readTelemetrySnapshot()).telemetryEnabled).toBe(false);
  });

  it("honors the WEGO_CLI_TELEMETRY env opt-out, which wins over the file", async () => {
    // Verified leak: reading only the file sent the device id to the API after
    // the user opted out with the env var the docs call authoritative.
    await buildTelemetryDeps(0, 1).persistDeviceId("dev-1");
    const previous = process.env.WEGO_CLI_TELEMETRY;
    try {
      for (const value of ["0", "off", "false", "log", "nonsense"]) {
        process.env.WEGO_CLI_TELEMETRY = value;
        expect((await readTelemetrySnapshot()).telemetryEnabled).toBe(false);
      }
      process.env.WEGO_CLI_TELEMETRY = "1";
      expect((await readTelemetrySnapshot()).telemetryEnabled).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.WEGO_CLI_TELEMETRY;
      else process.env.WEGO_CLI_TELEMETRY = previous;
    }
  });

  it("lets the env var re-enable over a stored opt-out, as documented", async () => {
    await buildTelemetryDeps(0, 1).persistDeviceId("dev-1");
    await writeFile(
      defaultTelemetryPath(process.env, "wego"),
      JSON.stringify({ deviceId: "dev-1", enabled: false }),
    );
    const previous = process.env.WEGO_CLI_TELEMETRY;
    process.env.WEGO_CLI_TELEMETRY = "on";
    try {
      expect((await readTelemetrySnapshot()).telemetryEnabled).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.WEGO_CLI_TELEMETRY;
      else process.env.WEGO_CLI_TELEMETRY = previous;
    }
  });
});

describe("shouldResolveSession (the sender-child and kill-switch branches)", () => {
  const argv = ["bun", "wego", "flights", "search"];

  it("resolves for a real user command", () => {
    expect(shouldResolveSession(argv, {})).toBe(true);
    expect(shouldResolveSession(["bun", "wego", "logout"], {})).toBe(true);
  });

  it("does NOT resolve in the detached sender, which re-enters the entrypoint", () => {
    // Otherwise the child bumps the session and re-creates what `logout` deleted.
    expect(
      shouldResolveSession(["bun", "wego", TELEMETRY_SENDER_COMMAND], {}),
    ).toBe(false);
  });

  it("honors WEGO_CLI_NO_SESSION, so a harness can keep $HOME untouched", () => {
    expect(shouldResolveSession(argv, { WEGO_CLI_NO_SESSION: "1" })).toBe(
      false,
    );
    expect(shouldResolveSession(argv, { WEGO_CLI_NO_SESSION: "yes" })).toBe(
      false,
    );
  });

  it("reads the kill switch liberally, like the other WEGO_CLI_NO_* vars", () => {
    expect(shouldResolveSession(argv, { WEGO_CLI_NO_SESSION: "" })).toBe(true);
    expect(shouldResolveSession(argv, { WEGO_CLI_NO_SESSION: "0" })).toBe(true);
    expect(shouldResolveSession(argv, { WEGO_CLI_NO_SESSION: "false" })).toBe(
      true,
    );
  });
});

describe("resolveAnalyticsHeaders (the consent rule)", () => {
  const DEVICE = "11111111-2222-4333-8444-555555555555";
  const SESSION = "b05d7226-701f-4892-abc3-dd92727b5683";

  it("sends the device id only when telemetry is on", () => {
    expect(
      resolveAnalyticsHeaders(
        { deviceId: DEVICE, telemetryEnabled: true },
        SESSION,
      ).clientId,
    ).toBe(DEVICE);
  });

  it("withholds the device id when telemetry is off", () => {
    expect(
      resolveAnalyticsHeaders(
        { deviceId: DEVICE, telemetryEnabled: false },
        SESSION,
      ).clientId,
    ).toBeUndefined();
  });

  it("still sends the session id when telemetry is off, by design", () => {
    expect(
      resolveAnalyticsHeaders(
        { deviceId: DEVICE, telemetryEnabled: false },
        SESSION,
      ).sessionId,
    ).toBe(SESSION);
  });

  it("drops the ephemeral sentinel, which the API would warn about", () => {
    expect(
      resolveAnalyticsHeaders(
        { deviceId: "ephemeral", telemetryEnabled: true },
        SESSION,
      ).clientId,
    ).toBeUndefined();
  });

  it("sends no client id on a machine that has never minted one", () => {
    expect(
      resolveAnalyticsHeaders({ telemetryEnabled: true }, SESSION).clientId,
    ).toBeUndefined();
  });
});

describe("shouldSendInline (the platform branch)", () => {
  it("detaches on posix while the binary is present", () => {
    expect(shouldSendInline("darwin", true)).toBe(false);
    expect(shouldSendInline("linux", true)).toBe(false);
  });

  it("waits inline on Windows, where detach is unverified", () => {
    expect(shouldSendInline("win32", true)).toBe(true);
  });

  it("waits inline once the binary is gone, on every platform", () => {
    // `uninstall` unlinks it before this runs; spawning it would ENOENT and the
    // event would be lost silently.
    const platforms: NodeJS.Platform[] = ["darwin", "linux", "win32"];
    for (const platform of platforms) {
      expect(shouldSendInline(platform, false)).toBe(true);
    }
  });
});

describe("forgetsIdentity", () => {
  it("is true only for logout", () => {
    const argv = (cmd: string) => ["/usr/local/bin/wego", "wego", cmd];
    expect(forgetsIdentity(argv("logout"))).toBe(true);
    for (const cmd of ["uninstall", "whoami", "version", "flights"]) {
      expect(forgetsIdentity(argv(cmd))).toBe(false);
    }
  });
});
