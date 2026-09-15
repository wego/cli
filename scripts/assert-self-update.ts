/**
 * THE GATE: a released binary must be able to update itself.
 *
 * Usage:
 *   bun run scripts/assert-self-update.ts <binary> <installUrl> <ring> [--expect <version>] [--expect-unchanged] [--force-replace]
 *
 * wego/cli v1.2.0 shipped a binary that could not `wego update` at all. Its
 * update path set no user agent, so Bun's default `Bun/<version>` went out -
 * which is the exact string `apps/api`'s legacy bridge pin keys on. Every
 * install was redirected to the frozen bridge `cli/cli-v1.1.0/`, whose record
 * it cannot verify, and refused it: exit 6, `not vouched for`. Machines that
 * reached 1.2.0 were frozen there and had to reinstall (wego/cli#25).
 *
 * EVERY CHECK IN THE RELEASE AND PROMOTE LANES PASSED. They verified machines
 * ARRIVING at the new version - SMOKE 3 updates the PREDECESSOR onto it - and
 * nothing ever ran `wego update` FROM the binary being shipped.
 *
 * So this asserts the OUTCOME, not a property that implies it. A guard that
 * checked "the user agent is not Bun-shaped" would have caught that one bug and
 * almost nothing else. Running the real thing against the real route covers the
 * pin, record verification, manifest coverage, hash comparison, URL
 * composition, the replace step and exit codes - including the next failure,
 * which will not look like the last one.
 *
 * `--force-replace` IS THE macOS LEG, and the reason it exists. Without `--force`
 * the gate's binary and the ring it follows hold the same bytes, so `update`
 * reports "already up to date" and returns before `downloadAndReplace` — the
 * fetch, the checksum, the chmod, the quarantine clear and the atomic rename all
 * go unrun. That is fine on the arriving direction (SMOKE 3 drives a real swap,
 * with the PREDECESSOR's code doing it), but the replace code that ships in THIS
 * binary is compiled per platform and has a branch Linux never reaches:
 * `if (os === "darwin") await deps.clearQuarantine(tmp)`. `--force` makes the
 * same-bytes case do the whole replace anyway, so a macOS runner exercises that
 * branch for real; the bytes landing identical is then itself an assertion (the
 * ring is serving what this run built).
 *
 * WHAT IT DOES NOT COVER, so nobody reads more into a green run than it earns:
 *   - Other platforms. CI executes linux-x64 and darwin-arm64 (the latter through
 *     `--force-replace` in the release lane); darwin-x64, linux-arm64 and Windows
 *     are built and never run. Narrower than the 3c soak waiver's gap, not gone.
 *   - A user's pre-existing install state: odd config, permissions, a
 *     half-written binary.
 *   - A regression that only appears on the NEXT release rather than this one.
 */
import { chmod, copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Everything the lane needs to know from one run, as data. Pure so the
 *  interpretation is unit-testable without spawning a 100 MB binary. */
export function interpretUpdate(r: {
  code: number;
  stdout: string;
  stderr: string;
}): { ok: true } | { ok: false; reason: string } {
  if (r.code === 0) return { ok: true };
  const detail = (r.stderr || r.stdout).trim().split("\n")[0] ?? "(no output)";
  // Exit 6 is EXIT.PERMANENT, which is what a record that does not verify
  // returns - the shape v1.2.0 shipped. Named because it is the one failure a
  // reader of a red run is most likely to misdiagnose as a network blip.
  //
  // The hint no longer points at the legacy bridge. Since wego/cli#29 the
  // bridge's `cli-v1.1.0` record VERIFIES, so being served it is not a way to
  // reach exit 6 any more - a binary that gets the bridge downgrades onto it
  // instead. What is left here is a genuine identity or signature failure, so
  // the message says to read the SAN rather than to suspect the agent.
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
 * `update.ts:364` returns EXIT.OK for `fromSource || version === DEV_VERSION`,
 * so a binary compiled without `WEGO_BUILD_VERSION` passes an exit-code check
 * having done nothing at all - the same shape of hole this gate exists to
 * close, one level up. Detected explicitly rather than left to the version
 * assertion, so the failure names its own cause.
 */
export function refusedAsUnreleased(stdout: string): boolean {
  return /Self-update applies to installed release binaries/i.test(stdout);
}

/** True when the run reports the binary was already current. */
export function reportedUnchanged(stdout: string): boolean {
  return /already up to date|up to date/i.test(stdout);
}

/**
 * True when the run reports it actually swapped the binary — `downloadAndReplace`
 * ran to completion.
 *
 * The claim `--force-replace` makes. Asserted on the MESSAGE and not on the exit
 * code because "already up to date" also exits 0: a `--force` that failed to
 * reach the replace path would otherwise pass while proving exactly what this
 * leg exists to stop being unproven.
 */
export function reportedReplaced(stdout: string): boolean {
  return /\bUpdated\b[^\n]*\bfrom ring\b/i.test(stdout);
}

/** Lowercase hex sha256 of a file, for the before/after comparison below. */
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
  // Opposite claims about the same run: one asserts `update` stopped before the
  // replace, the other that it went all the way through it. A caller passing both
  // has one of them wrong, and a silent precedence rule would decide which.
  if (forceReplace && expectUnchanged) {
    console.error(
      "::error::--force-replace and --expect-unchanged are mutually exclusive: the first requires a real byte-swap, the second requires that none happened.",
    );
    process.exit(1);
  }

  const dir = await mkdtemp(join(tmpdir(), "wego-selfupdate-"));
  const home = join(dir, "home");
  await mkdir(join(home, ".config", "wego"), { recursive: true });
  // THE BINARY MUST BE NAMED `wego`. The config directory is derived from the
  // name it is invoked as, so `wego-linux-x64` looks for `.config/wego-linux-x64/`,
  // finds no install record, and exits without ever reaching the network - a
  // green run that tested nothing.
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
  // Read before the swap so the post-swap comparison below has something to be
  // about; skipped otherwise, since hashing ~64 MB earns nothing without it.
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
    // The swap landed; now say WHAT landed. The ring was published from the same
    // dist/ this binary came out of, so identical bytes is the only correct
    // outcome — anything else means the ring is not serving this build.
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
