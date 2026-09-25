/**
 * Release gate: a released binary must be able to update itself.
 *
 * Usage:
 *   bun run scripts/assert-self-update.ts <binary> <installUrl> <ring> [--expect <version>] [--expect-unchanged] [--force-replace]
 *
 * wego/cli v1.2.0 shipped a binary that could not `wego update`: its update path
 * set no user agent, so Bun's default `Bun/<version>` went out, which is the
 * string `apps/api`'s legacy bridge pin keys on. Every install was redirected to
 * the frozen bridge `cli/cli-v1.1.0/`, whose record it could not verify, and
 * refused with exit 6. Machines on 1.2.0 had to reinstall (wego/cli#25). Every
 * release and promote check passed, because they only verified machines
 * arriving at the new version (SMOKE 3 updates the predecessor onto it).
 *
 * So this asserts the outcome by running the real update against the real
 * route, which covers the pin, record verification, manifest coverage, hash
 * comparison, URL composition, the replace step and exit codes, rather than
 * checking one property such as the user agent.
 *
 * `--force-replace`: without `--force`, the gate's binary and the ring hold the
 * same bytes, so `update` reports "already up to date" and returns before
 * `downloadAndReplace` (fetch, checksum, chmod, quarantine clear, atomic
 * rename). SMOKE 3 does a real swap but with the predecessor's code, so the
 * shipping build's replace code would first run after publication. `--force`
 * runs the whole replace on identical bytes, and the bytes staying identical
 * then asserts the ring is serving what this run built.
 *
 * linux-x64 runs in the release job; darwin-arm64 runs in `replace-macos`,
 * because the replace code is compiled per platform and
 * `if (os === "darwin") await deps.clearQuarantine(tmp)` cannot run on Linux.
 *
 * Not covered:
 *   - Other platforms. darwin-x64, linux-arm64 and Windows are built and
 *     published but never run. darwin-x64's Intel runner image is being
 *     retired, and Windows has no replace path (`update` refuses because a
 *     running .exe cannot be swapped).
 *   - A user's pre-existing install state: odd config, permissions, a
 *     half-written binary.
 *   - A regression that only appears on the next release rather than this one.
 */
import { chmod, copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Pure so the interpretation is unit-testable without spawning the binary. */
export function interpretUpdate(r: {
  code: number;
  stdout: string;
  stderr: string;
}): { ok: true } | { ok: false; reason: string } {
  if (r.code === 0) return { ok: true };
  const detail = (r.stderr || r.stdout).trim().split("\n")[0] ?? "(no output)";
  // Exit 6 is EXIT.PERMANENT, returned for a record that does not verify.
  // Called out because it is easy to misdiagnose as a network blip. The
  // bridge's `cli-v1.1.0` record verifies (wego/cli#29), so exit 6 here means a
  // genuine identity or signature failure: the hint points at the SAN.
  const hint =
    r.code === 6
      ? " This is the fail-closed refusal: the binary fetched a signed record it does not accept. Read the SAN the message names and compare it with `identitiesForRing` - a tag shape that matches no rule is wego/cli#29 all over again."
      : "";
  return {
    ok: false,
    reason: `\`wego update\` exited ${r.code}: ${detail}${hint}`,
  };
}

/**
 * True when `update` short-circuited because it does not consider itself an
 * installed release binary.
 *
 * `src/update.ts` returns EXIT.OK for `fromSource || version === DEV_VERSION`,
 * so a binary compiled without `WEGO_BUILD_VERSION` passes an exit-code check
 * having done nothing. Detected explicitly rather than left to the version
 * assertion, so the failure names its own cause.
 */
export function refusedAsUnreleased(stdout: string): boolean {
  return /Self-update applies to installed release binaries/i.test(stdout);
}

export function reportedUnchanged(stdout: string): boolean {
  return /already up to date|up to date/i.test(stdout);
}

/**
 * True when `downloadAndReplace` ran to completion.
 *
 * Asserted on the message, not the exit code, because "already up to date" also
 * exits 0: a `--force` that never reached the replace path would otherwise pass.
 */
export function reportedReplaced(stdout: string): boolean {
  return /\bUpdated\b[^\n]*\bfrom ring\b/i.test(stdout);
}

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(path).bytes());
  return hasher.digest("hex");
}

async function main(): Promise<void> {
  const [binary, installUrl, ring, ...rest] = process.argv.slice(2);
  if (!binary || !installUrl || !ring) {
    console.error(
      "usage: assert-self-update.ts <binary> <installUrl> <ring> [--expect <version>] [--expect-unchanged] [--force-replace]",
    );
    process.exit(1);
  }
  const expectAt = rest.indexOf("--expect");
  const expect = expectAt >= 0 ? rest[expectAt + 1] : undefined;
  const expectUnchanged = rest.includes("--expect-unchanged");
  const forceReplace = rest.includes("--force-replace");
  // Opposite claims about the same run. Refuse rather than let a silent
  // precedence rule pick one.
  if (forceReplace && expectUnchanged) {
    console.error(
      "::error::--force-replace and --expect-unchanged are mutually exclusive: the first requires a real byte-swap, the second requires that none happened.",
    );
    process.exit(1);
  }

  const dir = await mkdtemp(join(tmpdir(), "wego-selfupdate-"));
  const home = join(dir, "home");
  await mkdir(join(home, ".config", "wego"), { recursive: true });
  // The binary must be named `wego`. The config directory is derived from the
  // invoked name, so `wego-linux-x64` would look in `.config/wego-linux-x64/`,
  // find no install record, and exit green without reaching the network.
  const bin = join(dir, "wego");
  await copyFile(binary, bin);
  await chmod(bin, 0o755);
  await writeFile(
    join(home, ".config", "wego", "install.json"),
    `${JSON.stringify({ ring, installUrl })}\n`,
  );

  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    WEGO_CLI_TELEMETRY: "0",
  };

  console.log(
    `self-update gate: ${binary} following ring ${ring} at ${installUrl}${
      forceReplace
        ? " (--force: the replace path runs even on identical bytes)"
        : ""
    }`,
  );
  // Only needed for the post-swap comparison; hashing ~64 MB is skipped otherwise.
  const before = forceReplace ? await sha256(bin) : "";
  const run = Bun.spawnSync(
    forceReplace ? [bin, "update", "-y", "--force"] : [bin, "update", "-y"],
    { env },
  );
  const stdout = run.stdout.toString();
  const stderr = run.stderr.toString();
  if (stdout.trim()) console.log(stdout.trim());
  if (stderr.trim()) console.log(stderr.trim());

  if (refusedAsUnreleased(stdout)) {
    console.error(
      "::error::the binary handed to this gate does not consider itself a release build, so `update` returned without doing anything and this check proved NOTHING. Build it with WEGO_BUILD_VERSION set to the release version.",
    );
    process.exit(1);
  }

  const verdict = interpretUpdate({ code: run.exitCode ?? 1, stdout, stderr });
  if (!verdict.ok) {
    console.error(
      `::error::A binary built from this revision cannot update itself. ${verdict.reason}`,
    );
    process.exit(1);
  }

  if (forceReplace) {
    if (!reportedReplaced(stdout)) {
      console.error(
        `::error::--force-replace asked ${binary} to replace itself from ring ${ring} and it reported no swap. The replace path — fetch, checksum, chmod, quarantine clear, atomic rename — did not run, so this leg proved nothing.`,
      );
      process.exit(1);
    }
    // The ring was published from the same dist/ as this binary, so identical
    // bytes is the only correct outcome.
    const after = await sha256(bin);
    if (after !== before) {
      console.error(
        `::error::after replacing itself from ring ${ring} the binary's bytes changed (${before} -> ${after}). The ring is not serving the artifact this run built.`,
      );
      process.exit(1);
    }
    console.log(`replaced in place; bytes unchanged (sha256 ${after}).`);
  }

  if (expectUnchanged && !reportedUnchanged(stdout)) {
    console.error(
      `::error::expected the binary to report it was already up to date on ring ${ring}, but it replaced itself. The ring is not serving the bytes this run just published.`,
    );
    process.exit(1);
  }

  const after = Bun.spawnSync([bin, "version"], { env })
    .stdout.toString()
    .trim();
  console.log(`after update: ${after}`);
  if (expect && after !== expect) {
    console.error(
      `::error::after updating from ring ${ring} the binary reports ${after}, expected ${expect}.`,
    );
    process.exit(1);
  }
  console.log(
    `ok: self-update succeeded against ${installUrl} (ring ${ring}).`,
  );
}

if (import.meta.main) await main();
