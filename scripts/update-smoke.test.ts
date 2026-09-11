/**
 * `update-smoke.sh` — the one invariant a release run would otherwise discover for
 * us.
 *
 * The script proves a PUBLISHED predecessor can self-update onto the ring under
 * test (`release-cli.yml` Smoke 3). To do that it copies the predecessor to a temp
 * file and, when that binary refuses for want of a ring record, writes the record
 * the installer would have written and retries.
 *
 * Both halves depend on ONE thing agreeing: the copy's **file name**. A CLI scopes
 * its config by the name it is invoked as (`src/config.ts` `installScope`), so a
 * copy called `old-binary` looks for its record in `$XDG_CONFIG_HOME/old-binary/`
 * and the arranged record — written to the `wego` directory — is invisible to it.
 * The retry then refuses exactly as the first attempt did, and the smoke fails on
 * an artifact that is in fact fine.
 *
 * Nothing else in the repo can catch that: the script only runs on a release, needs
 * a published predecessor and real network, and the failure looks like a bad build
 * rather than a misnamed temp file. So the invariant is pinned as text here.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = readFileSync(join(import.meta.dir, "update-smoke.sh"), "utf8");

describe("update-smoke.sh keeps the predecessor's name and its config scope aligned", () => {
  test("copies the predecessor to a file named `wego`", () => {
    // Not `$tmp/old-binary`: the basename IS the install scope. `wego` is also the
    // name both scope rules resolve to — the name-keyed one, and the flavor-keyed
    // one used by any predecessor built before that change — so the script works
    // against a predecessor from either side of it.
    expect(SCRIPT).toContain('OLD="$tmp/bin/wego"');
    expect(SCRIPT).not.toContain('OLD="$tmp/old-binary"');
  });

  test("arranges the ring record in the directory that copy will read", () => {
    // The two literals have to name the same leaf; this is the assertion that fails
    // if either side is renamed alone.
    expect(SCRIPT).toContain('mkdir -p "$XDG_CONFIG_HOME/wego"');
    expect(SCRIPT).toContain('> "$XDG_CONFIG_HOME/wego/install.json"');
  });

  test("keeps the record inside the run's throwaway config home", () => {
    // A record that escaped into the operator's real `~/.config` could silently
    // satisfy a later run, which is the other way this smoke can lie.
    expect(SCRIPT).toContain('XDG_CONFIG_HOME="$tmp/config"');
    expect(SCRIPT).toContain("export XDG_CONFIG_HOME");
  });
});
