import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultCredentialsPath, defaultUpdateCheckPath } from "./config";
import { buildVersionNoticeDeps } from "./index";
import { INSTALL_RECORD_FILE } from "./ring-follow";

/**
 * Wiring guard for the proactive new-version notice.
 *
 * `version-notice.test.ts` covers the DECISION logic against injected deps; this
 * covers the other half — that the real deps touch the right path with the right
 * permissions. The split matters because a mis-wired dep fails **silently**: a
 * `readState` that always threw would look exactly like "no state yet", so the
 * throttle would evaporate and every command would hit the channel, with no error
 * anywhere.
 *
 * Everything here runs against a FIXTURE `XDG_CONFIG_HOME`, never the developer's
 * real one — this code writes files, and `bun test` is documented as hermetic.
 */

let home: string;
let previousXdg: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "wego-notice-"));
  previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = home;
});

afterEach(async () => {
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
  await rm(home, { recursive: true, force: true });
});

describe("defaultUpdateCheckPath", () => {
  it("is a sibling of the credentials file, under the flavor dir", () => {
    // Flavor scoping is what keeps the prod and staging cadences independent
    // without any extra bookkeeping.
    expect(defaultUpdateCheckPath({ XDG_CONFIG_HOME: home }, "wego")).toBe(
      join(home, "wego", ".update-check"),
    );
    expect(
      defaultUpdateCheckPath({ XDG_CONFIG_HOME: home }, "wegostaging"),
    ).toBe(join(home, "wegostaging", ".update-check"));
    // Same directory as the credentials file — that shared parent is why the
    // owner-only `mkdir` rule has to be shared too.
    expect(
      dirname(defaultUpdateCheckPath({ XDG_CONFIG_HOME: home }, "wego")),
    ).toBe(dirname(defaultCredentialsPath({ XDG_CONFIG_HOME: home }, "wego")));
  });

  it("falls back to ~/.config when XDG_CONFIG_HOME is unset", () => {
    expect(defaultUpdateCheckPath({}, "wego")).toMatch(
      /\.config[/\\]wego[/\\]\.update-check$/,
    );
  });
});

describe("buildVersionNoticeDeps", () => {
  it("reports a from-source run, which is what keeps `bun test` silent", async () => {
    // Every other suite in this app is protected by exactly this: under `bun test`
    // the exec path is `bun`, so the notice short-circuits and no test can start
    // seeing an unexpected stderr line (nor make a network call).
    expect(buildVersionNoticeDeps().fromSource).toBe(true);
  });

  it("round-trips the stored answer and the throttle stamp", async () => {
    const d = buildVersionNoticeDeps();
    expect(await d.readState()).toBeNull();
    expect(await d.claimWindow()).toBe(true);
    const claimed = await d.readState();
    expect(claimed?.latest).toBe("");
    expect(claimed?.checkedAt).toBeGreaterThan(0);
    await d.writeLatest("0.4.2");
    const state = await d.readState();
    expect(state?.latest).toBe("0.4.2");
    // TWO LINES: the channel's answer, then the version that wrote it. The stamp
    // is what lets a later build tell this answer was not its own - the check
    // that covers a REINSTALL, which never runs `update` and so can never be
    // covered by deleting the file on swap.
    const onDisk = await readFile(join(home, "wego", ".update-check"), "utf8");
    const [line1, line2] = onDisk.split("\n");
    expect(line1).toBe("0.4.2");
    // Not hardcoded: the running version is whatever this process was built as.
    expect(line2).toBe(d.version);
    expect(line2).not.toBe("");
    expect(state?.writtenBy).toBe(d.version);
    expect(onDisk.endsWith("\n")).toBe(true);
  });

  // A file in the OLD one-line form must read back as "written by nobody I know"
  // rather than as this binary's own answer - otherwise every cache in the field
  // today would keep being reported after a reinstall, which is the bug.
  it("reads a pre-stamp one-line file as having no writer", async () => {
    const d = buildVersionNoticeDeps();
    await d.claimWindow();
    await writeFile(join(home, "wego", ".update-check"), "0.4.2\n");
    const state = await d.readState();
    expect(state?.latest).toBe("0.4.2");
    expect(state?.writtenBy).toBeUndefined();
  });

  it("clears the stored answer without removing the stamp", async () => {
    const d = buildVersionNoticeDeps();
    await d.writeLatest("0.4.2");
    await d.writeLatest("");
    const state = await d.readState();
    expect(state?.latest).toBe("");
    expect(state?.checkedAt).toBeGreaterThan(0);
  });

  it("claiming the window does not truncate an answer we are about to nag about", async () => {
    const d = buildVersionNoticeDeps();
    await d.writeLatest("0.4.2");
    expect(await d.claimWindow()).toBe(true);
    expect((await d.readState())?.latest).toBe("0.4.2");
  });

  it("advances the stamp on every claim", async () => {
    const d = buildVersionNoticeDeps();
    await d.claimWindow();
    const path = join(home, "wego", ".update-check");
    // Backdate by an hour, then re-claim: the stamp must move forward, or the
    // throttle would never expire.
    const backdated = new Date(Date.now() - 3_600_000);
    await utimes(path, backdated, backdated);
    expect((await stat(path)).mtimeMs).toBeLessThan(Date.now() - 3_000_000);
    expect(await d.claimWindow()).toBe(true);
    expect((await stat(path)).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
  });

  it("creates the flavor dir owner-only, so credentials landing later stay 0700", async () => {
    // The regression this prevents: `mode` applies on creation only, and this
    // notice now runs on a fresh machine before any `login`. If it created
    // ~/.config/<scope>/ at 0755, `saveCredentials` would see an existing dir,
    // skip its chmod, and quietly store tokens in a world-readable directory.
    const d = buildVersionNoticeDeps();
    await d.claimWindow();
    expect(statSync(join(home, "wego")).mode & 0o777).toBe(0o700);
  });

  it("writes the state file owner-only", async () => {
    const d = buildVersionNoticeDeps();
    await d.claimWindow();
    expect(statSync(join(home, "wego", ".update-check")).mode & 0o777).toBe(
      0o600,
    );
    await d.writeLatest("0.4.2");
    expect(statSync(join(home, "wego", ".update-check")).mode & 0o777).toBe(
      0o600,
    );
  });

  it("creates every level it has to create as 0700, intermediates included", async () => {
    // Recursive `mkdir` applies `mode` to EVERY directory it creates, not just the
    // leaf — so on a machine with no `~/.config` yet, `~/.config` itself lands 0700.
    // Pinned because it is surprising and it reaches outside this CLI's own
    // directory. It is not new: `saveCredentials` has always made the same call with
    // the same mode, so whichever writer got there first already did this. Worth
    // knowing before anyone "fixes" the mode.
    const nested = join(home, "fresh", "config");
    process.env.XDG_CONFIG_HOME = nested;
    await buildVersionNoticeDeps().claimWindow();
    expect(statSync(join(nested, "wego")).mode & 0o777).toBe(0o700);
    expect(statSync(nested).mode & 0o777).toBe(0o700);
  });

  it("replaces the state file atomically, never truncating it in place", async () => {
    // A truncating write is observable by a concurrent command as an EMPTY file
    // whose mtime already looks fresh; that reader concludes "checked recently,
    // nothing to report" and a real notice goes silent for the whole window. So the
    // write must land by rename, and must leave no temp file behind.
    const d = buildVersionNoticeDeps();
    await d.writeLatest("0.4.2");
    await d.writeLatest("0.4.3");
    expect((await d.readState())?.latest).toBe("0.4.3");
    const leftovers = readdirSync(join(home, "wego")).filter((f) =>
      f.endsWith(".tmp"),
    );
    expect(leftovers).toEqual([]);
  });

  it("never chmods a directory it did not create", async () => {
    const dir = join(home, "wego");
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o755);
    await buildVersionNoticeDeps().claimWindow();
    expect(statSync(dir).mode & 0o777).toBe(0o755);
  });

  it("reads unreadable state as absent rather than throwing", async () => {
    // A corrupt or racing read must degrade to "we don't know" — the caller turns
    // that into a fresh check, never a crash on someone else's command.
    const d = buildVersionNoticeDeps();
    await writeFile(join(home, "wego"), "not a directory");
    expect(await d.readState()).toBeNull();
    expect(await d.claimWindow()).toBe(false);
  });
});

/**
 * The install record is read through ONE function shared with `update`'s wiring,
 * so its three "no recorded channel" inputs are pinned here rather than in each
 * caller: both callers REFUSE on `null` instead of substituting a ring, which
 * only holds if all three really do collapse to it.
 */
describe("buildVersionNoticeDeps().readInstallRecord", () => {
  const recordPath = () => join(home, "wego", INSTALL_RECORD_FILE);

  it("reads an absent record as null, the fresh-machine case", async () => {
    expect(await buildVersionNoticeDeps().readInstallRecord()).toBeNull();
  });

  it("reads a malformed record as null, not a throw", async () => {
    await mkdir(dirname(recordPath()), { recursive: true });
    await writeFile(recordPath(), "{ not json");
    expect(await buildVersionNoticeDeps().readInstallRecord()).toBeNull();
  });

  it("reads a well-formed-JSON-but-wrong-shape record as null", async () => {
    // Discriminates from the parse case above: this one parses cleanly and is
    // still rejected, which is the schema arm rather than the JSON arm.
    await mkdir(dirname(recordPath()), { recursive: true });
    await writeFile(recordPath(), JSON.stringify({ ring: 42 }));
    expect(await buildVersionNoticeDeps().readInstallRecord()).toBeNull();
  });

  it("reads the record the installer wrote under this install's scope", async () => {
    // The positive case, and the one that proves the three nulls above are the
    // guard rather than the path simply being wrong: the same path returns a
    // record once a valid one is there.
    await mkdir(dirname(recordPath()), { recursive: true });
    await writeFile(
      recordPath(),
      JSON.stringify({
        ring: "stable",
        installUrl: "https://api.wego.com/install",
      }),
    );
    expect(await buildVersionNoticeDeps().readInstallRecord()).toMatchObject({
      ring: "stable",
      installUrl: "https://api.wego.com/install",
    });
  });
});
