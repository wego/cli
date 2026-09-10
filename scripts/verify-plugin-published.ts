/**
 * Read the plugin repo back after a publish (foundations#101 rung 4b).
 *
 *   bun run scripts/verify-plugin-published.ts
 *
 * `publish-plugin.ts` proves that the repo holds only paths the plan names. It
 * never looks at what those paths CONTAIN once pushed, so the lane's own probe
 * is "paths, not bytes". This closes that: re-clone the published repo and
 * compare every `{from, to}` pair byte for byte against source, failing the
 * promote when any is missing or differs.
 *
 * IT MUST RE-CLONE. Inspecting the working copy the publish pushed from would
 * only confirm we did what we thought we did - it reads our own copy of the
 * truth, and it would pass the case this exists to catch. `publish-plugin.ts`
 * ends with `git push origin HEAD`; on an EMPTY remote the clone has an unborn
 * HEAD, and which branch name that resolves to depends on what the remote
 * advertises versus the runner's `init.defaultBranch`. Resolve it wrong and the
 * push succeeds, the step exits 0, and the channel everyone installs from is
 * still empty. Only an independent fetch can tell.
 *
 * Gated on `SKILLS_PUBLISH_TOKEN` exactly like the publish, so it skips precisely
 * when the publish skipped. A verify that ran while nothing was published would
 * fail every promote until the lane is armed. Armed, not provisioned: the App
 * credentials already exist, and `SKILLS_PUBLISH_ENABLED` is the separate switch
 * rung 5(b) flips - see `publish-plugin.ts`.
 *
 * WHILE `wego/skills` IS PRIVATE this clone is authenticated, and it therefore
 * proves the bytes and nothing about reachability. Once the repo is public the
 * read should drop the credential and clone anonymously: that reads the channel
 * the way a user does, and it is the only version that catches the repo being
 * flipped back to private - an authenticated read sails through that while every
 * `skills add` in the world breaks. The licence blocker (#98) is cleared - the
 * plan now publishes `LICENSE` - so what is left is the flip itself, and this
 * change lands AFTER it: an anonymous clone of a still-private repo fails every
 * promote.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SKILLS } from "../src/skill-embed";
import { Done, git } from "./plugin-git";
import {
  describeMismatch,
  missingPlanSources,
  PLUGIN_TOKEN_ENV,
  pluginPublishPlan,
  publishGate,
  redactRemote,
} from "./plugin-publish";

const cliRoot = join(import.meta.dir, "..");
const REPO = process.env.SKILLS_PLUGIN_REPO || "git@github.com:wego/skills.git";
const TOKEN_NAME = PLUGIN_TOKEN_ENV;

const plan = pluginPublishPlan(SKILLS.map((s) => s.id));

// Every source is stat'd BEFORE the gate and before any clone, exactly as
// `publish-plugin.ts` does it. Without this a missing source throws ENOENT from
// inside the work block, escapes the `Done` handler, and the step dies with a
// raw stack trace instead of the report every other failure here produces - and
// it dies on the FIRST bad source rather than naming them all.
const missingSources = missingPlanSources(cliRoot, plan, existsSync);
if (missingSources.length > 0) {
  console.error(
    `plugin verify: ${missingSources.length} source file(s) named by the plan ` +
      `do not exist:\n` +
      missingSources.map((m) => `  apps/cli/${m}`).join("\n"),
  );
  process.exit(1);
}

const gate = publishGate(
  process.env[TOKEN_NAME],
  process.env.REQUIRE_PUBLISH === "true",
  TOKEN_NAME,
);
if (!gate.publish) {
  console.log(`plugin verify: ${gate.message}`);
  process.exit(gate.hardFail ? 1 : 0);
}

const work = mkdtempSync(join(tmpdir(), "wego-plugin-verify-"));
let exitCode = 0;
try {
  // Shallow and fresh. The point is to read what the remote serves, not to
  // re-read anything this machine already has.
  git(work, "clone", "--depth", "1", REPO, "repo");
  const repo = join(work, "repo");

  const failures: string[] = [];
  let absent = 0;
  for (const { from, to } of plan) {
    const expected = readFileSync(join(cliRoot, from));
    let actual: Buffer;
    try {
      actual = readFileSync(join(repo, to));
    } catch (err) {
      // ENOENT is the only error that means "absent". A directory at the path
      // (EISDIR/ENOTDIR) or an unreadable one is a DIFFERENT fault, and calling
      // it MISSING sends the operator to check branches - see the hint below,
      // which fires only on absence for exactly this reason.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        absent += 1;
        failures.push(`  ${to} - MISSING from the published repo`);
      } else {
        failures.push(`  ${to} - UNREADABLE in the published repo (${code})`);
      }
      continue;
    }
    if (!expected.equals(actual)) {
      failures.push(`  ${to} - ${describeMismatch(expected, actual)}`);
    }
  }

  if (failures.length > 0) {
    // The branch hint is earned ONLY when the clone shows every planned file
    // absent, which is the signature of a clone that landed on a ref the push
    // did not write. Printed on any failure it would be boilerplate: it would
    // send someone hunting branches over a single tampered byte, and it would
    // make a test asserting it prove nothing, since every failure would say it.
    const everythingAbsent = absent === plan.length;
    console.error(
      `plugin verify FAILED: ${failures.length} of ${plan.length} published ` +
        `file(s) do not match source in ${redactRemote(REPO)}:\n` +
        failures.join("\n") +
        "\n\nThe publish reported success, so this is what it actually wrote." +
        (everythingAbsent
          ? "\nEVERY published file is absent. A push that reported success and\n" +
            "left nothing behind landed on a ref this clone does not check out -\n" +
            "compare the repo's default branch with the one the push resolved to.\n" +
            "See apps/cli/docs/skill-distribution.md."
          : ""),
    );
    throw new Done(1);
  }

  console.log(
    `plugin verify: ${plan.length} file(s) in ${redactRemote(REPO)} match source:\n` +
      plan.map((p) => `  ${p.to}`).join("\n"),
  );
} catch (e) {
  if (!(e instanceof Done)) throw e;
  exitCode = e.code;
} finally {
  rmSync(work, { recursive: true, force: true });
}

process.exit(exitCode);
