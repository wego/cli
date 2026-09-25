import { describe, expect, it } from "bun:test";
import { helpText } from "./index";

/**
 * Only the root help text, which is pure. Dispatch, the help forms, the version
 * and the usage errors are what the compiled binary prints, so they live in
 * `integration/cli.test.ts`.
 */

describe("helpText", () => {
  const commands = [
    "login",
    "whoami",
    "logout",
    "places",
    "info",
    "flights",
    "hotels",
    "config",
    "feedback",
    "skill",
    "update",
    "uninstall",
    "telemetry",
    "version",
  ];

  it("is an index: names every command under any invoked name, no flag rows", () => {
    for (const prog of ["wego", "wego-linux-x64", "mywego"]) {
      const text = helpText(prog);
      for (const cmd of commands) {
        expect(text).toMatch(new RegExp(`^ {2}${cmd} `, "m"));
      }
      expect(text).toContain(`Run ${prog} <command> --help for flags.`);
      expect(text).not.toMatch(/^\s+--/m);
      expect(text).not.toContain("STAGING-TESTING");
      expect(text).not.toContain("send-telemetry");
    }
  });

  it("says Research Preview up front, and names the flavor's own feedback command", () => {
    expect(helpText("wego")).toContain(
      "wego – Wego API CLI (Research Preview)",
    );
    expect(helpText("wegostaging")).toContain("`wegostaging feedback`");
  });

  // `--target` and `WEGO_TARGET` still work (`src/target.test.ts` proves it) but
  // are deliberately left out of help: staging and local are backends no public
  // user can reach.
  it("keeps the run-time target axis out of help, and keeps the user controls in", () => {
    const text = helpText("wego");
    expect(text).not.toContain("--target");
    expect(text).not.toContain("WEGO_TARGET");
    expect(text).not.toContain("staging");
    expect(text).toContain("WEGO_CLI_TELEMETRY");
    expect(text).toContain("WEGO_CREDENTIALS_PATH");
  });
});
