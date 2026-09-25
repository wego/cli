import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EXIT } from "./error-report";
import { buildRealDeps } from "./index";

/**
 * Wiring guard for `update` and `uninstall`, whose real deps are assembled from
 * the install scope.
 *
 * `update.test.ts` and `uninstall.test.ts` cover the decisions against injected
 * deps; this proves `buildRealDeps()` can actually assemble them. Both closures
 * derive several per-install paths inline (`defaultUpdateCheckPath`,
 * `defaultSessionPath`, `defaultInstallRecordPath`), so a path helper that threw
 * would surface only when a user ran the command, and `update` cannot be
 * rehearsed after release.
 *
 * Reaching the from-source refusal proves it: the guard runs after the whole
 * dependency object has been evaluated, so an assembly fault cannot reach that
 * message. It is also side-effect free (no fetch, no rename, nothing removed),
 * which is what makes driving the real wiring safe here.
 *
 * Runs against a fixture `XDG_CONFIG_HOME`, never the developer's real one.
 */

let home: string;
let previousXdg: string | undefined;
let logged: string[];
let realLog: typeof console.log;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "wego-real-deps-"));
  previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = home;
  // `buildRealDeps`'s io writes straight to the console; capture it so the
  // refusal can be asserted and the suite stays quiet.
  logged = [];
  realLog = console.log;
  console.log = (m?: unknown) => {
    logged.push(String(m));
  };
});

afterEach(async () => {
  console.log = realLog;
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
  await rm(home, { recursive: true, force: true });
});

describe("buildRealDeps (real wiring)", () => {
  it("assembles `update` deps and reaches the from-source refusal", async () => {
    // `bun test` IS a source run, so this is the arm that runs here; the
    // assertion is that it was reached at all, past the full deps literal.
    expect(await buildRealDeps().update([])).toBe(EXIT.OK);
    expect(logged.join("\n")).toContain(
      "Self-update applies to installed release binaries",
    );
  });

  it("assembles `uninstall` deps and reaches the from-source refusal", async () => {
    // `-y` so the refusal is the only arm that can answer, never the confirm
    // prompt (which would block on a tty this suite does not have).
    expect(await buildRealDeps().uninstall(["-y"])).toBe(EXIT.OK);
    expect(logged.join("\n")).toContain("Running from source");
  });

  it("removes nothing while assembling `uninstall`, which is why this is safe", async () => {
    // Seed the file the command would delete, so a regression that moved the
    // source guard below the deletions fails here rather than on a developer's
    // machine.
    const credentials = join(home, "wego", "credentials.json");
    await mkdir(dirname(credentials), { recursive: true });
    await writeFile(credentials, "sentinel");
    await buildRealDeps().uninstall(["-y"]);
    expect(await Bun.file(credentials).text()).toBe("sentinel");
  });
});
