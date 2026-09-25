import { isHelpArg } from "./commands";
import { EXIT } from "./error-report";
import { programName } from "./program-name";
import { parseTelemetryMode, type TelemetryMode } from "./telemetry";
import type { TelemetryState } from "./telemetry-state";
import { usage, usageErrorLabel } from "./usage";

/** `wego telemetry status|enable|disable`. `WEGO_CLI_TELEMETRY` always wins. */

const PROG = programName();

export const TELEMETRY_USAGE = usage({
  cmd: "telemetry <status|enable|disable>",
  what: `Show or change whether ${PROG} sends one usage event per command.`,
  env: [
    [
      "WEGO_CLI_TELEMETRY",
      "on | off | log. Wins over the stored setting for one run. log prints the event and sends nothing.",
    ],
  ],
  note: "Collected, per command, prod builds only: command, flag names, a few enum values, exit code, duration, version, OS, arch, a per-machine device id and a session id. Keyed on your Wego account id when logged in, anonymous when logged out. Never your search text, dates or messages. On by default: `wego telemetry disable` turns it off. The API session header is separate from this opt-out; WEGO_CLI_NO_SESSION=1 drops it.",
});

export type TelemetrySource = "environment" | "setting" | "default";

export interface TelemetryCommandDeps {
  log: (message: string) => void;
  error: (message: string) => void;
  env: Record<string, string | undefined>;
  statePath: string;
  loadState: () => Promise<TelemetryState>;
  setEnabled: (enabled: boolean) => Promise<TelemetryState>;
}

export function effectiveTelemetry(
  mode: TelemetryMode | undefined,
  state: TelemetryState,
): { enabled: boolean; source: TelemetrySource } {
  if (mode === "off") return { enabled: false, source: "environment" };
  // `log` builds the payload and sends nothing, so `enabled` (which answers "do
  // events leave this machine") is false; `mode` explains why.
  if (mode === "log") return { enabled: false, source: "environment" };
  if (mode === "on") return { enabled: true, source: "environment" };
  return state.enabled
    ? { enabled: true, source: "default" }
    : { enabled: false, source: "setting" };
}

export async function telemetry(
  args: readonly string[],
  deps: TelemetryCommandDeps,
): Promise<number> {
  if (isHelpArg([...args])) {
    deps.log(TELEMETRY_USAGE);
    return EXIT.OK;
  }
  const action = args[0] ?? "status";
  const mode = parseTelemetryMode(deps.env.WEGO_CLI_TELEMETRY);
  if (action === "status") {
    const state = await deps.loadState();
    const { enabled, source } = effectiveTelemetry(mode, state);
    deps.log(
      JSON.stringify(
        {
          enabled,
          source,
          mode: mode ?? null,
          setting: state.enabled,
          path: deps.statePath,
        },
        null,
        2,
      ),
    );
    return EXIT.OK;
  }
  if (action !== "enable" && action !== "disable") {
    deps.error(
      `${action.startsWith("-") ? "Unknown option" : "Unknown subcommand"}: ${action}\n${TELEMETRY_USAGE}`,
    );
    return EXIT.USAGE;
  }
  const extra = args[1];
  if (extra !== undefined) {
    deps.error(`${usageErrorLabel(extra)}: ${extra}\n${TELEMETRY_USAGE}`);
    return EXIT.USAGE;
  }
  const wanted = action === "enable";
  const state = await deps.setEnabled(wanted);
  // Say so rather than let the JSON imply the setting took effect.
  if (mode !== undefined && (mode === "off") === wanted) {
    deps.error(
      `WEGO_CLI_TELEMETRY=${deps.env.WEGO_CLI_TELEMETRY} overrides this setting – unset it for the stored choice to apply.`,
    );
  }
  deps.log(
    JSON.stringify({ enabled: state.enabled, path: deps.statePath }, null, 2),
  );
  return EXIT.OK;
}
