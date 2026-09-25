/**
 * `update-smoke.sh` proves a published predecessor can self-update onto the ring
 * under test (`release-cli.yml` Smoke 3). It copies the predecessor to a temp file
 * and, when that binary refuses for want of a ring record, writes the record the
 * installer would have written and retries.
 *
 * Both halves depend on the copy's file name. Binaries up to and including 1.2.7
 * scope their config by the name they were invoked as, so a copy called
 * `old-binary` looks in `$XDG_CONFIG_HOME/old-binary/` and never sees the record
 * written to the `wego` directory. The smoke then fails on an artifact that is
 * fine.
 *
 * The script only runs on a release, with a published predecessor and real
 * network, and the failure looks like a bad build, so the invariant is pinned as
 * text here.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = readFileSync(join(import.meta.dir, "update-smoke.sh"), "utf8");

describe("update-smoke.sh keeps the predecessor's name and its config scope aligned", () => {
  test("copies the predecessor to a file named `wego`", () => {
    // The basename is the install scope for older predecessors, and `wego` is
    // what both the name-keyed and flavor-keyed scope rules resolve to.
    expect(SCRIPT).toContain('OLD="$tmp/bin/wego"');
    expect(SCRIPT).not.toContain('OLD="$tmp/old-binary"');
  });

  test("arranges the ring record in the directory that copy will read", () => {
    // Fails if either side is renamed alone.
    expect(SCRIPT).toContain('mkdir -p "$XDG_CONFIG_HOME/wego"');
    expect(SCRIPT).toContain('> "$XDG_CONFIG_HOME/wego/install.json"');
  });

  test("keeps the record inside the run's throwaway config home", () => {
    // A record that escaped into the operator's real `~/.config` could silently
    // satisfy a later run.
    expect(SCRIPT).toContain('XDG_CONFIG_HOME="$tmp/config"');
    expect(SCRIPT).toContain("export XDG_CONFIG_HOME");
  });
});
