import { describe, expect, it } from "bun:test";
import {
  interpretUpdate,
  refusedAsUnreleased,
  reportedReplaced,
  reportedUnchanged,
} from "./assert-self-update";

describe("the self-update gate's verdict", () => {
  it("passes a clean run", () => {
    expect(interpretUpdate({ code: 0, stdout: "", stderr: "" })).toEqual({
      ok: true,
    });
  });

  it("fails a non-zero exit and quotes the first line", () => {
    const v = interpretUpdate({
      code: 1,
      stdout: "",
      stderr:
        "could not check for updates: failed to fetch https://api.wego.com/install?dl=SHA256SUMS.txt&ring=stable (HTTP 404)\nsecond line",
    });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toContain("exited 1");
      expect(v.reason).toContain("HTTP 404");
      expect(v.reason).not.toContain("second line");
    }
  });

  it("names the fail-closed refusal on exit 6 - the shape v1.2.0 shipped", () => {
    // The exact stderr a v1.2.0 binary produced against production.
    const v = interpretUpdate({
      code: 6,
      stdout: "",
      stderr:
        "SHA256SUMS.txt on ring stable is not vouched for: the signed build record names https://github.com/wego/wego-ai/.github/workflows/release-cli.yml@refs/tags/cli-v1.1.0, not ... - refusing it",
    });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toContain("exited 6");
      expect(v.reason).toContain("fail-closed refusal");
      // Points at the SAN, not the bridge: the bridge's `cli-v1.1.0` record
      // verifies (wego/cli#29), so it is not a route to exit 6.
      expect(v.reason).toContain("SAN");
      expect(v.reason).toContain("wego/cli#29");
      expect(v.reason).not.toContain("legacy bridge");
    }
  });

  it("reads the up-to-date report", () => {
    expect(reportedUnchanged("wego is already up to date (1.2.1).")).toBe(true);
    expect(
      reportedUnchanged(
        "Updated wego from ring next -> /home/u/.local/bin/wego.",
      ),
    ).toBe(false);
  });
});

describe("the gate refuses to pass on a binary that tests nothing", () => {
  it("detects the from-source / dev-version short circuit", () => {
    // `src/update.ts` returns EXIT.OK here, so an exit-code-only gate would pass
    // having exercised no network path.
    const out =
      "Self-update applies to installed release binaries (running from source – use `git pull`). Reinstall the latest with:\n  curl -fsSL https://api.wego.com/install | bash";
    expect(refusedAsUnreleased(out)).toBe(true);
  });

  it("does not fire on a real update", () => {
    expect(
      refusedAsUnreleased(
        "Updated wego from ring next -> /home/u/.local/bin/wego.",
      ),
    ).toBe(false);
  });
});

describe("the replace-path claim (--force-replace, the macOS leg)", () => {
  // The success line `downloadAndReplace` prints. Matched loosely enough to
  // survive a reworded path suffix, tightly enough that the up-to-date line can
  // never satisfy it.
  it("reads a real swap out of the success line", () => {
    expect(
      reportedReplaced(
        "Updated wego from ring next → /Users/runner/work/wego. Run `wego version` to confirm.",
      ),
    ).toBe(true);
  });

  it("is not satisfied by the up-to-date short circuit", () => {
    // With --force this line means the flag never took and the quarantine
    // clear went unrun, which must fail.
    expect(reportedReplaced("Already up to date (1.2.7, ring next).")).toBe(
      false,
    );
  });

  it("is not satisfied by a refusal that merely mentions the ring", () => {
    expect(
      reportedReplaced(
        "SHA256SUMS.txt on ring next is not vouched for - refusing it",
      ),
    ).toBe(false);
  });

  it("stays the exact complement of the unchanged report", () => {
    const swapped = "Updated wego from ring next → /home/u/.local/bin/wego.";
    const unchanged = "Already up to date (1.2.7, ring next).";
    expect([reportedReplaced(swapped), reportedUnchanged(swapped)]).toEqual([
      true,
      false,
    ]);
    expect([reportedReplaced(unchanged), reportedUnchanged(unchanged)]).toEqual(
      [false, true],
    );
  });
});
