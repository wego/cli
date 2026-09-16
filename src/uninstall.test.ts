import { describe, expect, it } from "bun:test";
import { EXIT } from "./error-report";
import {
  parseUninstallArgs,
  UNINSTALL_USAGE,
  type UninstallDeps,
  uninstall,
} from "./uninstall";

const EXEC = "/home/u/.local/bin/wego";
const CREDS = "/home/u/.config/wego/credentials.json";
const STATE = "/home/u/.config/wego/.update-check";
const INSTALL_RECORD = "/home/u/.config/wego/install.json";
const SKILL = "/home/u/.claude/skills/wego";
const TELEMETRY = "/home/u/.config/wego/telemetry.json";
const SESSION = "/home/u/.config/wego/session.json";
const SETTINGS = "/home/u/.config/wego/settings.json";
const AUTH_FAILURE = "/home/u/.config/wego/last-auth-failure.json";

function makeDeps(overrides: Partial<UninstallDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const removed: string[] = [];
  const confirmCalls: string[] = [];
  let credsRemoved = false;
  let skillRemoved = false;
  const deps: UninstallDeps = {
    log: (m) => out.push(m),
    error: (m) => err.push(m),
    version: "0.2.2",
    fromSource: false,
    platform: "linux",
    execPath: EXEC,
    credentialsPath: CREDS,
    settingsPath: SETTINGS,
    updateCheckPath: STATE,
    installRecordPath: INSTALL_RECORD,
    sessionPath: SESSION,
    authFailurePath: AUTH_FAILURE,
    skillPath: SKILL,
    telemetryStatePath: TELEMETRY,
    telemetryOptedOut: async () => false,
    rm: async (path) => {
      removed.push(path);
    },
    removeCredentials: async () => {
      credsRemoved = true;
    },
    removeSkill: async () => {
      skillRemoved = true;
    },
    confirm: async () => true,
    ...overrides,
  };
  // Record every confirm call regardless of any override, so a test that
  // overrides confirm (e.g. to cancel) can still assert on the prompt text.
  const answer = deps.confirm;
  deps.confirm = async (q) => {
    confirmCalls.push(q);
    return answer(q);
  };
  return {
    deps,
    out,
    err,
    removed,
    confirmCalls,
    flags: () => ({ credsRemoved, skillRemoved }),
  };
}

describe("parseUninstallArgs", () => {
  it("defaults to remove-everything, no yes", () => {
    expect(parseUninstallArgs([])).toEqual({
      yes: false,
      keepCredentials: false,
      keepSkill: false,
    });
  });

  it("parses -y/--yes, --keep-credentials, --keep-skill", () => {
    expect(parseUninstallArgs(["-y"])).toMatchObject({ yes: true });
    expect(
      parseUninstallArgs(["--keep-credentials", "--keep-skill"]),
    ).toMatchObject({ keepCredentials: true, keepSkill: true });
  });

  it("rejects an unknown flag and a stray positional", () => {
    expect(() => parseUninstallArgs(["--nope"])).toThrow(
      /Unknown option: --nope/,
    );
    expect(() => parseUninstallArgs(["x"])).toThrow(/Unexpected argument: x/);
  });
});

describe("uninstall", () => {
  it("prints usage for --help", async () => {
    const { deps, out } = makeDeps();
    expect(await uninstall(["--help"], deps)).toBe(EXIT.OK);
    expect(out[0]).toBe(UNINSTALL_USAGE);
  });

  it("returns a usage error on a bad flag", async () => {
    const { deps, err } = makeDeps();
    expect(await uninstall(["--bogus"], deps)).toBe(EXIT.USAGE);
    expect(err[0]).toMatch(/Unknown option: --bogus/);
  });

  it("refuses to uninstall a from-source run", async () => {
    const { deps, out, removed, flags } = makeDeps({ version: "0.0.0-dev" });
    expect(await uninstall(["-y"], deps)).toBe(EXIT.OK);
    expect(out.join("\n")).toMatch(/Running from source/);
    expect(removed).toHaveLength(0);
    expect(flags()).toEqual({ credsRemoved: false, skillRemoved: false });
  });

  it("refuses a source run even when WEGO_BUILD_VERSION spoofs a release version (fromSource wins over version)", async () => {
    // A source run (`bun run src/index.ts`) that inherits WEGO_BUILD_VERSION reports
    // a non-dev version, but execPath is still the Bun runtime — must NOT be removed.
    const { deps, out, removed, flags } = makeDeps({
      version: "0.2.2",
      fromSource: true,
    });
    expect(await uninstall(["-y"], deps)).toBe(EXIT.OK);
    expect(out.join("\n")).toMatch(/Running from source/);
    expect(removed).toHaveLength(0);
    expect(flags()).toEqual({ credsRemoved: false, skillRemoved: false });
  });

  it("removes binary + credentials + skill + telemetry state by default (-y)", async () => {
    const { deps, out, removed, flags } = makeDeps();
    expect(await uninstall(["-y"], deps)).toBe(EXIT.OK);
    expect(removed).toEqual([
      EXEC,
      STATE,
      INSTALL_RECORD,
      SESSION,
      AUTH_FAILURE,
      SETTINGS,
      TELEMETRY,
    ]);
    expect(flags()).toEqual({ credsRemoved: true, skillRemoved: true });
    expect(out.join("\n")).toMatch(/Removed wego \(/);
    expect(out.join("\n")).toMatch(/Removed local telemetry state/);
  });

  it("keeps an explicit telemetry opt-out, so a reinstall stays opted out", async () => {
    const { deps, out, removed } = makeDeps({
      telemetryOptedOut: async () => true,
    });
    expect(await uninstall(["-y"], deps)).toBe(EXIT.OK);
    // The update-check throttle still goes; only the opt-out is preserved.
    expect(removed).toEqual([
      EXEC,
      STATE,
      INSTALL_RECORD,
      SESSION,
      AUTH_FAILURE,
      SETTINGS,
    ]);
    expect(out.join("\n")).toMatch(/Kept your telemetry opt-out/);
  });

  it("reports but survives a failure to clear telemetry state", async () => {
    const { deps, err } = makeDeps({
      telemetryOptedOut: async () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
    });
    expect(await uninstall(["-y"], deps)).toBe(EXIT.OK);
    expect(err.join("\n")).toMatch(/could not remove local telemetry state/);
  });

  it("prompts and cancels without removing anything when declined", async () => {
    const { deps, out, removed, flags } = makeDeps({
      confirm: async () => false,
    });
    expect(await uninstall([], deps)).toBe(EXIT.OK);
    expect(out.join("\n")).toBe("Cancelled.");
    expect(removed).toHaveLength(0);
    expect(flags()).toEqual({ credsRemoved: false, skillRemoved: false });
  });

  it("lists the exact targets in the confirm prompt", async () => {
    const { deps, confirmCalls } = makeDeps({ confirm: async () => false });
    await uninstall([], deps);
    expect(confirmCalls[0]).toContain(EXEC);
    expect(confirmCalls[0]).toContain(CREDS);
    expect(confirmCalls[0]).toContain(STATE);
    expect(confirmCalls[0]).toContain(SKILL);
    // The skill line names its scope so a project-/--dir-scoped install left in
    // place isn't a surprise (the summary only removes the default user-scope skill).
    expect(confirmCalls[0]).toMatch(/default user-scope agent skill/);
  });

  it("confirm prompt says the Windows binary is a manual follow-up, not removed", async () => {
    const { deps, confirmCalls } = makeDeps({
      platform: "win32",
      confirm: async () => false,
    });
    await uninstall([], deps);
    expect(confirmCalls[0]).toMatch(/manually delete .* after this command/);
    expect(confirmCalls[0]).toContain(CREDS);
    expect(confirmCalls[0]).toContain(SKILL);
  });

  it("--keep-credentials retains the login", async () => {
    const { deps, confirmCalls, flags } = makeDeps();
    expect(await uninstall(["-y", "--keep-credentials"], deps)).toBe(EXIT.OK);
    expect(flags()).toEqual({ credsRemoved: false, skillRemoved: true });
    // confirm bypassed by -y
    expect(confirmCalls).toHaveLength(0);
  });

  it("--keep-skill retains the agent skill", async () => {
    const { deps, flags } = makeDeps();
    expect(await uninstall(["-y", "--keep-skill"], deps)).toBe(EXIT.OK);
    expect(flags()).toEqual({ credsRemoved: true, skillRemoved: false });
  });

  it("on Windows removes creds/skill but prints a manual binary step", async () => {
    const { deps, out, removed, flags } = makeDeps({ platform: "win32" });
    expect(await uninstall(["-y"], deps)).toBe(EXIT.OK);
    // Can't delete the running .exe, but the rest of the footprint still goes.
    expect(removed).toEqual([
      STATE,
      INSTALL_RECORD,
      SESSION,
      AUTH_FAILURE,
      SETTINGS,
      TELEMETRY,
    ]);
    expect(flags()).toEqual({ credsRemoved: true, skillRemoved: true });
    expect(out.join("\n")).toMatch(/Delete .* manually/);
  });

  it("logs and continues when only the local state file can't be removed", async () => {
    // The state removal is best-effort like every other cleanup step: a failure
    // there must not strand the uninstall or skip the credentials/skill removal
    // that follows it.
    const { deps, err, flags } = makeDeps({
      rm: async (path) => {
        if (path === STATE)
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
    });
    expect(await uninstall(["-y"], deps)).toBe(EXIT.OK);
    expect(err.join("\n")).toMatch(/could not remove local state/);
    expect(flags()).toEqual({ credsRemoved: true, skillRemoved: true });
  });

  it("reports a permission error when the binary can't be removed", async () => {
    const { deps, err } = makeDeps({
      rm: async () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
    });
    expect(await uninstall(["-y"], deps)).toBe(EXIT.ERROR);
    expect(err[0]).toMatch(/permission denied/);
  });

  it("preserves credentials + skill when the binary can't be removed", async () => {
    // The binary goes first, so an unremovable binary (e.g. a root-owned dir run
    // unprivileged) must NOT leave the login/agent wiped while the binary stays.
    const { deps, flags } = makeDeps({
      rm: async () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
    });
    expect(await uninstall(["-y"], deps)).toBe(EXIT.ERROR);
    expect(flags()).toEqual({ credsRemoved: false, skillRemoved: false });
  });

  it("cleanup is best-effort: a credentials-removal failure doesn't strand the uninstall", async () => {
    // The binary is already gone; a cleanup hiccup is logged and skipped, the skill
    // is still removed, and the command still succeeds.
    const { deps, out, err, removed, flags } = makeDeps({
      removeCredentials: async () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
    });
    expect(await uninstall(["-y"], deps)).toBe(EXIT.OK);
    expect(removed).toEqual([
      EXEC,
      STATE,
      INSTALL_RECORD,
      SESSION,
      AUTH_FAILURE,
      SETTINGS,
      TELEMETRY,
    ]);
    expect(err.join("\n")).toMatch(/could not remove stored credentials/);
    expect(flags()).toEqual({ credsRemoved: false, skillRemoved: true });
    expect(out.join("\n")).toMatch(/Removed wego \(/);
  });
});
