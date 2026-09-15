import { isHelpArg } from "./commands";
import { EXIT, exitCodeForError } from "./error-report";
import { programName } from "./program-name";
import { usage, usageErrorLabel } from "./usage";

// The invoked command name, so a renamed install's `--help` names itself.
const PROG = programName();

/**
 * `wego uninstall` — the counterpart to the `curl … | bash` installer: remove
 * everything the CLI put on the machine, in one command (clig.dev's "make
 * uninstallation easy").
 *
 * A POSIX process can unlink its own executable while running (the kernel keeps
 * the open inode until exit), so `uninstall` self-deletes `process.execPath` the
 * same way `update` self-replaces it. Windows can't delete a running `.exe`, so
 * it does the rest and prints a one-line manual step (matching `update`/install).
 *
 * By default it also clears the stored credentials and removes the agent skill
 * this CLI installed; `--keep-credentials` / `--keep-skill` retain either.
 * Injected deps keep the flow unit-testable without touching the real fs.
 */

/** The from-source version stamp (matches `index.ts`'s `VERSION` fallback). */
const DEV_VERSION = "0.0.0-dev";

export interface UninstallDeps {
  log: (message: string) => void;
  error: (message: string) => void;
  /** The running binary's version; `0.0.0-dev` from source. */
  version: string;
  /** True when running from source (a runtime exec-path signal, NOT the
   *  env-stamped version which a stray `WEGO_BUILD_VERSION` can spoof). When
   *  true there is no installed binary to remove and `execPath` is the Bun/Node
   *  runtime, so the command refuses. */
  fromSource: boolean;
  /** `process.platform`. */
  platform: NodeJS.Platform;
  /** Absolute path of the running binary (`process.execPath`). */
  execPath: string;
  /** Where credentials live (for the removal summary). */
  credentialsPath: string;
  /** The user's travel preferences (issue #1386). Removed with the credentials
   *  group — `--keep-credentials` keeps both. */
  settingsPath: string;
  /** The update-notice throttle file (`version-notice.ts`). Removed unconditionally
   *  — it is this binary's own bookkeeping, not the user's login, so
   *  `--keep-credentials` has no say in it. */
  updateCheckPath: string;
  /** The release-ring record this install followed (`ring-follow.ts`). Removed
   *  unconditionally with the rest of this binary's bookkeeping: it describes an
   *  install that no longer exists, and a reinstall writes it again. */
  installRecordPath: string;
  /** The analytics session file. Removed unconditionally like the throttle: it
   *  carries no opt-out, so there is nothing to preserve across a reinstall. */
  sessionPath: string;
  /** The last-auth-failure diagnostic record (investigation #1360). Removed
   *  unconditionally like the throttle and the session: this binary's own
   *  bookkeeping, so `--keep-credentials` has no say in it. */
  authFailurePath: string;
  /** The agent skill directory (for the removal summary). */
  skillPath: string;
  /** Local telemetry state (machine id + setting). */
  telemetryStatePath: string;
  /** True when the stored setting is an explicit opt-out, which is kept so a
   *  reinstall does not silently turn telemetry back on. */
  telemetryOptedOut: () => Promise<boolean>;
  /** Best-effort remove (force). */
  rm: (path: string) => Promise<void>;
  /** Clear stored credentials (force-rm; no-op when already absent). */
  removeCredentials: () => Promise<void>;
  /** Remove the wego-owned agent skill (reuses `skill uninstall`; a foreign or
   *  absent skill is left/ignored). */
  removeSkill: () => Promise<void>;
  /** Confirm the removal; bypassed by `-y`. */
  confirm: (question: string) => Promise<boolean>;
}

interface UninstallOptions {
  yes: boolean;
  keepCredentials: boolean;
  keepSkill: boolean;
}

export const UNINSTALL_USAGE = usage({
  cmd: "uninstall",
  what: `Remove this ${PROG} binary, its stored login, and the user-scope agent skill.`,
  flags: [
    ["-y", "Skip the confirm."],
    ["--keep-credentials", "Keep the login."],
    ["--keep-skill", "Keep the agent skill in ~/.claude/skills/wego."],
  ],
  note: `A project-scope or --dir skill install is not touched. Remove it with ${PROG} skill uninstall --scope project or --dir PATH.`,
});

/** Parse `wego uninstall` argv. Valueless boolean flags only; anything else is a
 *  usage error the caller renders with exit 2. */
export function parseUninstallArgs(args: string[]): UninstallOptions {
  const opts: UninstallOptions = {
    yes: false,
    keepCredentials: false,
    keepSkill: false,
  };
  for (const arg of args) {
    switch (arg) {
      case "-y":
      case "--yes":
        opts.yes = true;
        break;
      case "--keep-credentials":
        opts.keepCredentials = true;
        break;
      case "--keep-skill":
        opts.keepSkill = true;
        break;
      default:
        throw new Error(`${usageErrorLabel(arg)}: ${arg}\n${UNINSTALL_USAGE}`);
    }
  }
  return opts;
}

/** Self-delete the running binary. POSIX unlinks its own execPath; Windows can't
 *  and returns a manual-step notice. Returns an exit code. */
async function removeBinary(deps: UninstallDeps): Promise<number> {
  if (deps.platform === "win32") {
    deps.log(
      `Delete ${deps.execPath} manually to finish – a running .exe can't remove itself on Windows.`,
    );
    return EXIT.OK;
  }
  try {
    await deps.rm(deps.execPath);
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException | undefined)?.code;
    if (errno === "EACCES" || errno === "EPERM") {
      deps.error(
        `cannot remove ${deps.execPath} (permission denied). Delete it manually with sufficient permissions.`,
      );
      return EXIT.ERROR;
    }
    deps.error(
      `failed to remove ${deps.execPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return exitCodeForError(err);
  }
  deps.log(`Removed wego (${deps.execPath}).`);
  return EXIT.OK;
}

/** Build the removal summary and ask to proceed. The summary lists exactly the
 *  paths this run will remove, so a `-y`-less caller sees them before confirming. */
async function confirmUninstall(
  opts: UninstallOptions,
  deps: UninstallDeps,
): Promise<boolean> {
  // Windows can't self-delete a running .exe, so the summary must say the binary
  // is a manual follow-up there, not something this command removes.
  const targets = [
    deps.platform === "win32"
      ? `manually delete the wego binary at ${deps.execPath} after this command`
      : `the wego binary at ${deps.execPath}`,
    `local state at ${deps.updateCheckPath}`,
    `the release-ring record at ${deps.installRecordPath}`,
    `the analytics session at ${deps.sessionPath}`,
    `the last-auth-failure record at ${deps.authFailurePath}`,
  ];
  if (!opts.keepCredentials) {
    targets.push(`stored credentials at ${deps.credentialsPath}`);
    targets.push(`your travel preferences at ${deps.settingsPath}`);
  }
  if (!opts.keepSkill) {
    targets.push(
      `the default user-scope agent skill at ${deps.skillPath} (a project-scoped or --dir install is left in place - use \`wego skill uninstall\` for those)`,
    );
  }
  targets.push(
    `local telemetry state at ${deps.telemetryStatePath} (an explicit telemetry opt-out is kept)`,
  );
  return deps.confirm(
    `Uninstall wego? This removes:\n  - ${targets.join("\n  - ")}\nProceed?`,
  );
}

/** Clear the secondary footprint (credentials + skill) after the binary is gone,
 *  best-effort: each failure is logged and skipped, never failing a command whose
 *  main job (binary removal) already succeeded. */
/** Force-remove one path, reporting a failure instead of failing the uninstall. */
async function removeQuietly(
  deps: UninstallDeps,
  path: string,
  label: string,
): Promise<void> {
  try {
    await deps.rm(path);
  } catch (err) {
    deps.error(
      `could not remove ${label} (${path}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function removeFootprint(
  opts: UninstallOptions,
  deps: UninstallDeps,
): Promise<void> {
  // Neither is gated by a --keep flag: both are this binary's own bookkeeping,
  // and leaving them behind is pure litter once the binary is gone.
  await removeQuietly(deps, deps.updateCheckPath, "local state");
  await removeQuietly(deps, deps.installRecordPath, "the release-ring record");
  await removeQuietly(deps, deps.sessionPath, "the analytics session");
  await removeQuietly(
    deps,
    deps.authFailurePath,
    "the last-auth-failure record",
  );
  if (!opts.keepCredentials) {
    // Grouped with the credentials, and gated by the same flag: preferences are
    // the user's own data, unlike the telemetry opt-out below, which is KEPT so a
    // reinstall cannot silently resume sending. A stale currency has no such
    // safety argument, so `--keep-credentials` is the only way to retain it.
    await removeQuietly(deps, deps.settingsPath, "your travel preferences");
    try {
      await deps.removeCredentials();
      deps.log(`Removed stored credentials (${deps.credentialsPath}).`);
    } catch (err) {
      deps.error(
        `could not remove stored credentials (${deps.credentialsPath}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (!opts.keepSkill) {
    try {
      await deps.removeSkill();
    } catch (err) {
      deps.error(
        `could not remove the agent skill (${deps.skillPath}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  await clearTelemetryFootprint(deps);
}

/** Remove the local telemetry state, keeping an explicit opt-out so that
 *  reinstalling does not silently turn telemetry back on. */
async function clearTelemetryFootprint(deps: UninstallDeps): Promise<void> {
  try {
    if (await deps.telemetryOptedOut()) {
      deps.log(
        `Kept your telemetry opt-out (${deps.telemetryStatePath}) so a reinstall stays opted out.`,
      );
      return;
    }
    await deps.rm(deps.telemetryStatePath);
    deps.log(`Removed local telemetry state (${deps.telemetryStatePath}).`);
  } catch (err) {
    deps.error(
      `could not remove local telemetry state (${deps.telemetryStatePath}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** `wego uninstall [-y] [--keep-credentials] [--keep-skill]`. */
export async function uninstall(
  args: string[],
  deps: UninstallDeps,
): Promise<number> {
  if (isHelpArg(args)) {
    deps.log(UNINSTALL_USAGE);
    return EXIT.OK;
  }
  let opts: UninstallOptions;
  try {
    opts = parseUninstallArgs(args);
  } catch (err) {
    deps.error(err instanceof Error ? err.message : String(err));
    return EXIT.USAGE;
  }

  // From source there is no installed binary to remove; deleting `bun` (which is
  // `process.execPath` under `bun run src/index.ts`) would be wrong, so refuse
  // cleanly. Gate on the exec-path signal first: a stray `WEGO_BUILD_VERSION` in
  // the environment can make `version` non-dev on a source run, so version alone
  // is not a safe source check.
  if (deps.fromSource || deps.version === DEV_VERSION) {
    deps.log(
      "Running from source – nothing to uninstall (this isn't an installed binary). Remove the checkout/worktree instead.",
    );
    return EXIT.OK;
  }

  if (!opts.yes && !(await confirmUninstall(opts, deps))) {
    deps.log("Cancelled.");
    return EXIT.OK;
  }

  // Remove the binary first. It is the point of the command, and a POSIX process
  // keeps running off its already-open inode after unlinking its own execPath, so
  // nothing here depends on the binary still being on disk. Doing it first means a
  // non-removable binary (e.g. installed under a root-owned dir, run unprivileged)
  // stops us BEFORE we wipe the user's credentials/skill: the worst outcome would
  // be a stranded binary with the login and agent setup already gone.
  const binaryExit = await removeBinary(deps);
  if (binaryExit !== EXIT.OK) return binaryExit;

  // Binary handled: clear the secondary footprint (credentials + skill), best-effort.
  await removeFootprint(opts, deps);
  return EXIT.OK;
}
