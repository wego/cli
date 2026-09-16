/**
 * `upgrade-path.sh`, driven end to end against a fake self-updating binary.
 *
 * The script's whole value is in the ASSERTIONS it makes about a multi-hop
 * chain — converges, advances, terminates, routes, settles — and every one of
 * them only fires on a real `wego update`, against a real ring, over the
 * network. So in production it is exercised once per merge and once per
 * release, on paths that are supposed to be green; the cases where it must FAIL
 * would otherwise never run at all, and a gate whose failure branch is untested
 * is a gate nobody should trust.
 *
 * The harness replaces only the binary. `$LADDER` is a `from>to` version map and
 * the fake `wego` walks it, rewriting its OWN `#VERSION=` line to "self-replace"
 * — so the bytes genuinely change, `version` genuinely reports the new value, and
 * the script's hashing, loop memory and route bookkeeping are the shipped ones.
 *
 * The fake also REFUSES unless it finds `$XDG_CONFIG_HOME/wego/install.json`,
 * exactly as a real post-foundations#74 binary does. That makes the config-scope
 * invariant behavioural rather than a text pin: a CLI scopes its config by the
 * name it is invoked as (`src/config.ts` `installScope`), so if the script ever
 * stops copying the start binary to a file named `wego`, the arranged record
 * lands in a directory the copy does not read and every case here fails.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "upgrade-path.sh");
const INSTALL_URL = "https://example.test/install";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

/**
 * A `wego` that self-updates along `$LADDER`.
 *
 * `#VERSION=` is both what `version` prints and what the "replace" rewrites, so
 * a hop changes the file's bytes for the same reason a real one does. `#PAD=`
 * exists only for the one case that needs bytes to move while the version does
 * not — the disagreement branch.
 */
const fakeBinary = (opts: { settled?: boolean } = {}) => `#!/bin/sh
#VERSION=0.0.0
#PAD=0
set -eu
me="$0"
# The config scope is the name this binary was INVOKED as, exactly as
# \`src/config.ts\` \`installScope\` derives it. That is what makes the script's
# choice of copy name testable here: point it at a copy called anything but
# \`wego\` and the arranged record becomes invisible, as on a real machine.
scope=$(basename "$me")
cur=$(sed -n 's/^#VERSION=//p' "$me")
next=""
for pair in \${LADDER:-}; do
  case "$pair" in
    "$cur>"*) next=\${pair#*>} ;;
  esac
done
case "\${1:-}" in
  version) printf '%s\\n' "$cur" ;;
  update)
    # A real binary refuses rather than guessing which ring to follow, and prints
    # the reinstall hint the script reads when no --install-url is given.
    if [ ! -f "\${XDG_CONFIG_HOME:-}/$scope/install.json" ]; then
      echo "no release ring recorded - refusing to guess which ring to update from."
      echo "  curl -fsSL ${INSTALL_URL} | bash"
      exit 6
    fi
    if [ "\${2:-}" = "--check" ]; then
      ${
        opts.settled === false
          ? 'echo "An update is available."; exit 0'
          : 'if [ -n "$next" ]; then echo "An update is available."; else echo "Already up to date"; fi; exit 0'
      }
    fi
    if [ "$next" = "EXIT6" ]; then
      echo "SHA256SUMS.txt on this ring is not vouched for - refusing it" >&2
      exit 6
    fi
    if [ "$next" = "PADONLY" ]; then
      sed "s/^#PAD=.*/#PAD=$(date +%s)$$/" "$me" > "$me.new"
      mv "$me.new" "$me"; chmod +x "$me"
      echo "Updated wego (bytes only)"
      exit 0
    fi
    if [ -z "$next" ]; then echo "Already up to date ($cur)."; exit 0; fi
    sed "s/^#VERSION=.*/#VERSION=$next/" "$me" > "$me.new"
    mv "$me.new" "$me"; chmod +x "$me"
    echo "Updated wego from ring."
    ;;
  *) echo "Unknown command: \${1:-}" >&2; exit 64 ;;
esac
`;

interface Case {
  /** `from>to` pairs the fake walks. `EXIT6` and `PADONLY` are behaviours. */
  ladder: string;
  start: string;
  expected: string;
  args?: string[];
  /** The fake's `update --check` claims an update is still available. */
  settled?: boolean;
}

function run({ ladder, start, expected, args = [], settled }: Case) {
  const dir = mkdtempSync(join(tmpdir(), "upgrade-path-"));
  roots.push(dir);
  const bin = join(dir, "start-binary");
  writeFileSync(
    bin,
    fakeBinary({ settled }).replace("#VERSION=0.0.0", `#VERSION=${start}`),
  );
  chmodSync(bin, 0o755);

  const proc = Bun.spawnSync(
    [
      "sh",
      SCRIPT,
      bin,
      "testring",
      expected,
      "--install-url",
      INSTALL_URL,
      ...args,
    ],
    { env: { ...process.env, LADDER: ladder }, stdout: "pipe", stderr: "pipe" },
  );
  return {
    code: proc.exitCode,
    out: proc.stdout.toString() + proc.stderr.toString(),
  };
}

describe("a chain that reaches the ring's version", () => {
  test("walks every hop and reports how many it took", () => {
    const r = run({
      ladder: "1.0.1>1.1.0 1.1.0>1.2.5",
      start: "1.0.1",
      expected: "1.2.5",
    });
    expect(r.out).toContain("converged: 1.0.1 1.1.0 1.2.5 (2 hop(s))");
    expect(r.out).toContain("in 2 hop(s), settled.");
    expect(r.code).toBe(0);
  });

  test("accepts a single hop", () => {
    const r = run({ ladder: "1.1.0>1.2.5", start: "1.1.0", expected: "1.2.5" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("in 1 hop(s), settled.");
  });
});

describe("--via pins the route, not just the destination", () => {
  // The pre-relay path is only correct if it goes THROUGH the frozen bridge. A
  // chain that arrived by some other route would converge and pass without this.
  test("passes when the waypoints match", () => {
    const r = run({
      ladder: "1.0.1>1.1.0 1.1.0>1.2.5",
      start: "1.0.1",
      expected: "1.2.5",
      args: ["--via", "1.1.0"],
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("route matches --via: 1.1.0 1.2.5");
  });

  test("fails when the chain took a different route to the same version", () => {
    const r = run({
      ladder: "1.0.1>1.0.9 1.0.9>1.2.5",
      start: "1.0.1",
      expected: "1.2.5",
      args: ["--via", "1.1.0"],
    });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("expected the route to be '1.1.0 1.2.5'");
    expect(r.out).toContain("got '1.0.9 1.2.5'");
  });
});

describe("the failures a single-hop smoke cannot see", () => {
  // wego/cli#25: an agent-less build updated to 1.1.0, which read the live
  // pointer, which served the agent-less build. Every hop exits 0. Only the
  // SEQUENCE is wrong, so only a driver that remembers the sequence can say so.
  test("names a self-update loop rather than letting the budget expire", () => {
    const r = run({
      ladder: "1.0.1>9.9.9 9.9.9>1.0.1",
      start: "1.0.1",
      expected: "2.0.0",
    });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("That is a self-update LOOP");
    expect(r.out).toContain("returned to 1.0.1");
    // The loop must be named at the repeat, not diagnosed as a slow chain.
    expect(r.out).not.toContain("still at");
  });

  // The failure that looks most like success: `update` exits 0, replaces
  // nothing, and the chain is still short of the destination.
  test("refuses a hop that succeeds without replacing anything", () => {
    const r = run({ ladder: "", start: "1.1.0", expected: "1.2.5" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("replaced nothing");
    expect(r.out).toContain("serving this binary back to itself");
  });

  test("refuses a hop whose bytes moved but whose version did not", () => {
    const r = run({
      ladder: "1.1.0>PADONLY",
      start: "1.1.0",
      expected: "1.2.5",
    });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("version and the bytes disagreeing");
  });

  // Exit 6 is a signed record the binary's baked trust set rejects — the single
  // most likely way a change in this repository strands an old install.
  test("surfaces a refused signature as a failure, never a skip", () => {
    const r = run({
      ladder: "1.1.0>EXIT6",
      start: "1.1.0",
      expected: "1.2.5",
    });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("exited 6");
    expect(r.out).toContain("baked trust set does not accept");
  });

  test("fails when the arrived binary does not consider itself current", () => {
    const r = run({
      ladder: "1.1.0>1.2.5",
      start: "1.1.0",
      expected: "1.2.5",
      settled: false,
    });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("post-arrival --check did not report up to date");
  });

  test("stops at the hop budget and shows the route it got", () => {
    const r = run({
      ladder: "1.0.1>1.1.0 1.1.0>1.2.5",
      start: "1.0.1",
      expected: "1.2.5",
      args: ["--max-hops", "1"],
    });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("still at 1.1.0 after 1 hop(s)");
  });
});

describe("a run that would prove nothing is refused, not passed", () => {
  // The same greenwash `update-smoke.sh` refuses under --require-replace: on a
  // re-run the pointer may simply have moved to meet the start binary.
  test("refuses a start binary that is already the expected version", () => {
    const r = run({ ladder: "", start: "1.2.5", expected: "1.2.5" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("already 1.2.5, so no upgrade path was exercised");
  });
});

describe("argument handling", () => {
  const bare = (args: string[]) =>
    Bun.spawnSync(["sh", SCRIPT, ...args], { stdout: "pipe", stderr: "pipe" });

  test("usage error when a positional is missing", () => {
    const p = bare(["/nope", "stable"]);
    expect(p.exitCode).toBe(2);
    expect(p.stderr.toString()).toContain("usage: upgrade-path.sh");
  });

  test("rejects a non-numeric --max-hops instead of treating it as zero", () => {
    const p = bare(["/nope", "stable", "1.0.0", "--max-hops", "lots"]);
    expect(p.exitCode).toBe(2);
    expect(p.stderr.toString()).toContain("--max-hops must be a whole number");
  });

  test("rejects --max-hops 0, which could never exercise a path", () => {
    const p = bare(["/nope", "stable", "1.0.0", "--max-hops", "0"]);
    expect(p.exitCode).toBe(2);
    expect(p.stderr.toString()).toContain("at least 1");
  });

  test("rejects an unknown option rather than reading it as a positional", () => {
    const p = bare(["/nope", "stable", "1.0.0", "--requrie-replace"]);
    expect(p.exitCode).toBe(2);
    expect(p.stderr.toString()).toContain("unknown option");
  });

  test("rejects a trailing flag that was given no value", () => {
    const p = bare(["/nope", "stable", "1.0.0", "--via"]);
    expect(p.exitCode).toBe(2);
    expect(p.stderr.toString()).toContain("--via needs a value");
  });

  test("fails on a start binary that does not exist", () => {
    const p = bare([
      "/nope/missing",
      "stable",
      "1.0.0",
      "--install-url",
      INSTALL_URL,
    ]);
    expect(p.exitCode).toBe(1);
    expect(p.stderr.toString()).toContain("no such file");
  });
});
