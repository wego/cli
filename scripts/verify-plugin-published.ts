/**
 * Read the plugin repo back after a publish.
 *
 *   bun run scripts/verify-plugin-published.ts
 *
 * `publish-plugin.ts` proves the repo holds only paths the plan names, not what
 * those paths contain once pushed. This re-clones the published repo and compares
 * every `{from, to}` pair byte for byte against source, failing the promote when
 * any is missing or differs.
 *
 * It must re-clone. The working copy the publish pushed from would pass the case
 * this exists to catch: `publish-plugin.ts` ends with `git push origin HEAD`, and
 * on an empty remote the clone has an unborn HEAD whose branch name depends on
 * what the remote advertises versus the runner's `init.defaultBranch`. Resolve it
 * wrong and the push succeeds while the channel everyone installs from stays
 * empty.
 *
 * Gated on `SKILLS_PUBLISH_TOKEN` like the publish, so it skips exactly when the
 * publish skipped; otherwise it would fail every promote until the lane is armed.
 * `SKILLS_PUBLISH_ENABLED` is the separate switch (see `publish-plugin.ts`).
 *
 * While `wego/skills` is private this clone is authenticated, so it proves the
 * bytes and nothing about reachability. Once the repo is public it should clone
 * anonymously: that reads the channel the way a user does, and catches the repo
 * being flipped back to private. Not before: an anonymous clone of a private repo
 * fails every promote.
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

// Every source is stat'd before the gate and any clone, as in `publish-plugin.ts`.
// Otherwise a missing source throws ENOENT inside the work block, escapes the
// `Done` handler, and the step dies with a raw stack trace on the first bad
// source rather than naming them all.
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
      // Only ENOENT means absent. A directory at the path (EISDIR/ENOTDIR) or an
      // unreadable file is a different fault, and calling it MISSING would feed
      // the branch hint below, which fires only on absence.
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
    // The branch hint is printed only when every planned file is absent, the
    // signature of a clone that landed on a ref the push did not write. On any
    // other failure it would send someone hunting branches over one bad byte.
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
            "See wego/foundations#127."
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
