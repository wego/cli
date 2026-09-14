import { describe, expect, it } from "bun:test";
import {
  interpretUpdate,
  refusedAsUnreleased,
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
    // The exact stderr a v1.2.0 binary produced against production, which every
    // lane check passed over.
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
      // Points at the SAN, not at the bridge: since wego/cli#29 the bridge's
      // `cli-v1.1.0` record verifies, so it is no longer a route to exit 6.
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
    // `update.ts:364` returns EXIT.OK here, so an exit-code-only gate would go
    // green having exercised no network path at all.
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
