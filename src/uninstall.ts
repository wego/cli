import { isHelpArg } from "./commands";
import { EXIT, exitCodeForError } from "./error-report";
import { programName } from "./program-name";
import { usage, usageErrorLabel } from "./usage";

// So a renamed install's `--help` names itself.
const PROG = programName();

/**
 * `wego uninstall`: the counterpart to the `curl … | bash` installer, removing
 * everything the CLI put on the machine (clig.dev's "make uninstallation easy").
 *
 * A POSIX process can unlink its own executable while running (the kernel keeps
 * the open inode until exit), so this self-deletes `process.execPath` the way
 * `update` self-replaces it. Windows cannot delete a running `.exe`, so there it
 * does the rest and prints a manual step, as `update` and the installer do.
 */

/** Matches `index.ts`'s `VERSION` fallback. */
const DEV_VERSION = "0.0.0-dev";

export interface UninstallDeps {
  log: (message: string) => void;
  error: (message: string) => void;
  /** `0.0.0-dev` from source. */
  version: string;
  /** A runtime exec-path signal, not the env-stamped version, which a stray
   *  `WEGO_BUILD_VERSION` can spoof. When true, `execPath` is the Bun/Node
   *  runtime, so the command refuses. */
  fromSource: boolean;
  platform: NodeJS.Platform;
  execPath: string;
  credentialsPath: string;
  /** Travel preferences (issue #1386). `--keep-credentials` keeps them too. */
  settingsPath: string;
  /** The update-notice throttle file (`version-notice.ts`). The following paths
   *  are this binary's own bookkeeping, so they are removed regardless of
   *  `--keep-credentials`. */
  updateCheckPath: string;
  /** Describes an install that no longer exists; a reinstall writes it again. */
  installRecordPath: string;
  /** Carries no opt-out, so there is nothing to preserve across a reinstall. */
  sessionPath: string;
  /** The last-auth-failure diagnostic record (investigation #1360). */
  authFailurePath: string;
  skillPath: string;
  /** Machine id and setting. */
  telemetryStatePath: string;
  /** An explicit opt-out is kept so a reinstall does not silently turn telemetry
   *  back on. */
  telemetryOptedOut: () => Promise<boolean>;
  /** Best-effort remove (force). */
  rm: (path: string) => Promise<void>;
  /** No-op when already absent. */
  removeCredentials: () => Promise<void>;
  /** Reuses `skill uninstall`, so a foreign or absent skill is left alone. */
  removeSkill: () => Promise<void>;
  /** Bypassed by `-y`. */
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

/** Lists exactly the paths this run will remove. */
async function confirmUninstall(
  opts: UninstallOptions,
  deps: UninstallDeps,
): Promise<boolean> {
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

/** Reports a failure instead of failing the uninstall. */
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

/** Best-effort: each failure is logged and skipped, never failing a command
 *  whose main job (removing the binary) already succeeded. */
async function removeFootprint(
  opts: UninstallOptions,
  deps: UninstallDeps,
): Promise<void> {
  // Not gated by a --keep flag: this binary's own bookkeeping is litter once the
  // binary is gone.
  await removeQuietly(deps, deps.updateCheckPath, "local state");
  await removeQuietly(deps, deps.installRecordPath, "the release-ring record");
  await removeQuietly(deps, deps.sessionPath, "the analytics session");
  await removeQuietly(
    deps,
    deps.authFailurePath,
    "the last-auth-failure record",
  );
  if (!opts.keepCredentials) {
    // Preferences are the user's own data, gated with the credentials. Unlike the
    // telemetry opt-out below, a stale preference has no safety reason to survive
    // a reinstall, so `--keep-credentials` is the only way to retain it.
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

/** Keeps an explicit opt-out so reinstalling does not silently turn telemetry
 *  back on. */
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

  // Under `bun run src/index.ts`, `process.execPath` is `bun` itself. Gate on the
  // exec-path signal first: a stray `WEGO_BUILD_VERSION` can make `version`
  // non-dev on a source run.
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

  // Binary first: a POSIX process keeps running off its open inode, and a
  // non-removable binary (say, under a root-owned dir, run unprivileged) then
  // stops us before the credentials and skill are wiped. The worst outcome would
  // be a stranded binary with the login and agent setup already gone.
  const binaryExit = await removeBinary(deps);
  if (binaryExit !== EXIT.OK) return binaryExit;

  await removeFootprint(opts, deps);
  return EXIT.OK;
}
