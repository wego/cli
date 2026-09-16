/**
 * `outgoing-stable.sh` is read by its CALLER as `outgoing=$(…)`, so its stdout is
 * not a log — it is a return value. The whole risk of extracting the duplicated
 * resolution into a script is that someone later adds a friendly `echo` and it
 * lands inside that variable, pointing the upgrade path at garbage. That failure
 * would surface as a bad release rather than a bad echo, so the stream discipline
 * is pinned here rather than left to review.
 *
 * The other half is the annotations. Before the extraction each job raised three
 * separate `::error::` lines with wording tuned to its stage; collapsing them into
 * one generic message would have kept the check and lost the half of the diagnosis
 * that says what to do. `--stage` is what preserves that, so each stage's wording
 * is asserted rather than assumed.
 *
 * The version probe is served locally: the script's `--probe-url` exists for this
 * and the lane never passes it (asserted in `release-platform-coverage.test.ts`).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = "scripts/outgoing-stable.sh";
const VERSION = "1.2.8";

let dir: string;
let server: ReturnType<typeof Bun.serve>;
let probe: string;
/** What the fake `cli/stable` answers with on the next request. */
let serves = "1.2.7";

/** A stand-in for a built binary: `version` prints what it was baked with. */
function fakeBinary(reports: string): string {
  const p = join(dir, `wego-${reports || "dev"}`);
  writeFileSync(
    p,
    `#!/bin/sh\n[ "$1" = version ] && printf '%s\\n' '${reports}'\n`,
  );
  chmodSync(p, 0o755);
  return p;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "outgoing-stable-"));
  server = Bun.serve({
    port: 0,
    fetch: () => new Response(serves),
  });
  probe = `http://127.0.0.1:${server.port}/install`;
});

afterAll(() => {
  server?.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

/** Async on purpose: `Bun.spawnSync` blocks the event loop, and the version probe
 *  above is served by `Bun.serve` IN THIS PROCESS — so a synchronous spawn would
 *  hold the loop while curl waits for a reply that cannot be sent, and every case
 *  would "fail" by timing out rather than by disagreeing. */
async function run(bin: string, stage: string, version = VERSION) {
  const p = Bun.spawn(
    ["sh", SCRIPT, bin, version, "--stage", stage, "--probe-url", probe],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [out, err] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  await p.exited;
  return { code: p.exitCode, out, err };
}

describe("outgoing-stable.sh: stdout is a return value, not a log", () => {
  test("prints the outgoing version and NOTHING else on success", async () => {
    serves = "1.2.7";
    const r = await run(fakeBinary(VERSION), "pre-publish");
    expect(r.code).toBe(0);
    // Exactly one line, exactly the version. A caller does `outgoing=$(…)`, so any
    // extra token here becomes part of the value.
    expect(r.out).toBe("1.2.7\n");
    expect(r.out.trim().split(/\s+/)).toHaveLength(1);
    expect(r.err).toBe("");
  });

  for (const stage of ["pre-publish", "post-advance"]) {
    test(`writes nothing to stdout when it refuses (${stage})`, async () => {
      serves = "";
      const empty = await run(fakeBinary(VERSION), stage);
      expect(empty.code).toBe(1);
      expect(empty.out).toBe("");

      serves = VERSION;
      const same = await run(fakeBinary(VERSION), stage);
      expect(same.code).toBe(1);
      expect(same.out).toBe("");

      serves = "1.2.7";
      const unbaked = await run(fakeBinary("0.0.0-dev"), stage);
      expect(unbaked.code).toBe(1);
      expect(unbaked.out).toBe("");
    });
  }
});

describe("outgoing-stable.sh: the three refusals each keep their own annotation", () => {
  test("an unbaked version is named as such, per stage", async () => {
    serves = "1.2.7";
    const pre = await run(fakeBinary("0.0.0-dev"), "pre-publish");
    expect(pre.err).toContain("::error::");
    expect(pre.err).toContain("WEGO_BUILD_VERSION");
    expect(pre.err).toContain("this gate would prove nothing");

    const post = await run(fakeBinary("0.0.0-dev"), "post-advance");
    expect(post.err).toContain("this leg would prove nothing");
    // Different consequence, different wording — that is the point of --stage.
    expect(post.err).not.toBe(pre.err);
  });

  test("an empty cli/stable refuses to PUBLISH before the ring moves", async () => {
    serves = "";
    const pre = await run(fakeBinary(VERSION), "pre-publish");
    expect(pre.err).toContain("Refusing to publish");

    const post = await run(fakeBinary(VERSION), "post-advance");
    expect(post.err).toContain("unforced path cannot be exercised");
    expect(post.err).not.toContain("Refusing to publish");
  });

  test("a cli/stable already on this version says to cut a new one", async () => {
    serves = VERSION;
    for (const stage of ["pre-publish", "post-advance"]) {
      const r = await run(fakeBinary(VERSION), stage);
      expect(r.err).toContain("::error::");
      expect(r.err.toLowerCase()).toContain("cut a new version");
    }
  });
});

describe("outgoing-stable.sh: refuses to run on an unusable invocation", () => {
  test("a missing or unknown stage is a usage error, not a default", () => {
    serves = "1.2.7";
    const bin = fakeBinary(VERSION);
    // A silently-defaulted stage would emit the wrong job's advice on failure.
    for (const args of [
      [bin, VERSION],
      [bin, VERSION, "--stage", "whenever"],
    ]) {
      const p = Bun.spawnSync(["sh", SCRIPT, ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(p.exitCode).toBe(2);
      expect(p.stdout.toString()).toBe("");
    }
  });
});
