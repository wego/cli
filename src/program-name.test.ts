import { describe, expect, it } from "bun:test";
import { programName, runningFromSource } from "./program-name";

describe("programName", () => {
  it("uses the on-disk binary name (compiled binary → execPath is the real path)", () => {
    expect(programName("/usr/local/bin/wegostaging")).toBe("wegostaging");
    expect(programName("/tmp/wego-test-bin/wego")).toBe("wego");
    expect(programName("/opt/renamed")).toBe("renamed");
  });

  it("falls back to `wego` when run from source (execPath is bun/node)", () => {
    expect(programName("/opt/homebrew/bin/bun")).toBe("wego");
    expect(programName("/usr/bin/node")).toBe("wego");
  });

  it("strips a trailing .exe on Windows (source falls back, renamed keeps its name)", () => {
    // Forward slashes so node's posix `basename` splits on the test runner; the
    // point is the `.exe` strip (separator handling is node:path's per-OS job).
    expect(programName("C:/Program Files/bun/bun.exe")).toBe("wego");
    expect(programName("C:/tools/node.exe")).toBe("wego");
    expect(programName("C:/Users/x/bin/wegostaging.exe")).toBe("wegostaging");
    expect(programName("C:/Users/x/bin/wego.exe")).toBe("wego");
  });
});

describe("runningFromSource", () => {
  it("is true only when execPath is the bun/node runtime (a source run)", () => {
    expect(runningFromSource("/opt/homebrew/bin/bun")).toBe(true);
    expect(runningFromSource("/usr/bin/node")).toBe(true);
    expect(runningFromSource("C:/Program Files/bun/bun.exe")).toBe(true);
    expect(runningFromSource("C:/tools/node.exe")).toBe(true);
  });

  it("is false for an installed/compiled binary (execPath is the CLI itself), regardless of name", () => {
    expect(runningFromSource("/usr/local/bin/wego")).toBe(false);
    expect(runningFromSource("/usr/local/bin/wegostaging")).toBe(false);
    expect(runningFromSource("/tmp/dist/wego-linux-x64")).toBe(false);
    expect(runningFromSource("/opt/renamed")).toBe(false);
  });
});
