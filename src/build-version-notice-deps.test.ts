import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { statSync } from "node:fs";
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
 * Wiring guard for the new-version notice: `version-notice.test.ts` covers the
 * decision logic; this checks the real deps touch the right path with the right
 * permissions. A mis-wired dep fails silently: a `readState` that always threw
 * would look like "no state yet", so every command would hit the channel.
 *
 * Runs against a fixture `XDG_CONFIG_HOME`, never the developer's real one, since
 * this code writes files and `bun test` is hermetic.
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
    // Flavor scoping keeps the prod and staging cadences independent.
    expect(defaultUpdateCheckPath({ XDG_CONFIG_HOME: home }, "wego")).toBe(
      join(home, "wego", ".update-check"),
    );
    expect(
      defaultUpdateCheckPath({ XDG_CONFIG_HOME: home }, "wegostaging"),
    ).toBe(join(home, "wegostaging", ".update-check"));
    // Same directory as the credentials file, which is why the owner-only
    // `mkdir` rule has to be shared too.
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
    // Under `bun test` the exec path is `bun`, so the notice short-circuits and no
    // other suite sees an unexpected stderr line or makes a network call.
    expect(buildVersionNoticeDeps().fromSource).toBe(true);
  });

  it("advances the stamp on every claim", async () => {
    const d = buildVersionNoticeDeps();
    await d.claimWindow();
    const path = join(home, "wego", ".update-check");
    // The stamp must move forward on re-claim, or the throttle would never expire.
    const backdated = new Date(Date.now() - 3_600_000);
    await utimes(path, backdated, backdated);
    expect((await stat(path)).mtimeMs).toBeLessThan(Date.now() - 3_000_000);
    expect(await d.claimWindow()).toBe(true);
    expect((await stat(path)).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
  });

  it("creates the flavor dir owner-only, so credentials landing later stay 0700", async () => {
    // `mode` applies on creation only, and the notice can run on a fresh machine
    // before any `login`. If it created ~/.config/<scope>/ at 0755,
    // `saveCredentials` would see an existing dir, skip its chmod, and store
    // tokens in a world-readable directory.
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
  });

  // The file is only a timestamp, by design: a stored answer would be half of a
  // comparison whose other half changes on every update and reinstall
  // (wego/cli#33, #35).
  it("stores nothing but the stamp", async () => {
    const d = buildVersionNoticeDeps();
    await d.claimWindow();
    expect(await readFile(join(home, "wego", ".update-check"), "utf8")).toBe(
      "",
    );
    expect(Object.keys((await d.readState()) ?? {})).toEqual(["checkedAt"]);
  });

  it("creates every level it has to create as 0700, intermediates included", async () => {
    // Recursive `mkdir` applies `mode` to every directory it creates, so on a
    // machine with no `~/.config` yet, `~/.config` itself lands 0700. Pinned
    // because it is surprising and reaches outside this CLI's own directory;
    // `saveCredentials` makes the same call with the same mode.
    const nested = join(home, "fresh", "config");
    process.env.XDG_CONFIG_HOME = nested;
    await buildVersionNoticeDeps().claimWindow();
    expect(statSync(join(nested, "wego")).mode & 0o777).toBe(0o700);
    expect(statSync(nested).mode & 0o777).toBe(0o700);
  });

  it("never chmods a directory it did not create", async () => {
    const dir = join(home, "wego");
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o755);
    await buildVersionNoticeDeps().claimWindow();
    expect(statSync(dir).mode & 0o777).toBe(0o755);
  });

  it("reads unreadable state as absent rather than throwing", async () => {
    // A corrupt or racing read must degrade to "unknown", which the caller turns
    // into a fresh check rather than a crash on someone else's command.
    const d = buildVersionNoticeDeps();
    await writeFile(join(home, "wego"), "not a directory");
    expect(await d.readState()).toBeNull();
    expect(await d.claimWindow()).toBe(false);
  });
});

/**
 * The install record is read through one function shared with `update`'s wiring,
 * so its three "no recorded ring" inputs are pinned here rather than in each
 * caller. Both callers refuse on `null`, which only holds if all three collapse
 * to it.
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
    // Parses cleanly, so this exercises the schema check rather than JSON.parse.
    await mkdir(dirname(recordPath()), { recursive: true });
    await writeFile(recordPath(), JSON.stringify({ ring: 42 }));
    expect(await buildVersionNoticeDeps().readInstallRecord()).toBeNull();
  });

  it("reads the record the installer wrote under this install's scope", async () => {
    // Proves the nulls above come from the guard, not a wrong path.
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
