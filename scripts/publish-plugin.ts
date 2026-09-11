/**
 * Publish the plugin repo (foundations#101 rung 4).
 *
 *   bun run scripts/publish-plugin.ts              # clone, write the plan, push
 *   bun run scripts/publish-plugin.ts --print-plan # print the plan, write nothing
 *
 * Writes exactly the files `pluginPublishPlan()` names into `wego/skills`, the
 * repo third-party discovery reads. The plan is the whole contract: this file
 * holds the mechanics and no policy about WHAT is published.
 *
 * Deliberately simpler than the lane it replaces, which shipped a bounded push
 * retry, a rebase classifier and a post-push read-back and never ran once. What
 * is here instead is ONE after-clone check - the subset predicate - which covers
 * an empty repo, the steady state and a stray file together. A push that races
 * another writer fails the step; a re-run reconciles, because the publish is
 * idempotent (it commits nothing when the tree already matches source).
 *
 * Skips gracefully (exit 0) when `SKILLS_PUBLISH_TOKEN` is unset, unless
 * `REQUIRE_PUBLISH=true` - the same token gate `publish-skill-blob.ts` uses.
 *
 * PROVISIONED AND ARMED ARE TWO DIFFERENT EVENTS, and only the second one puts
 * a value in that variable. The App credentials this token is minted from
 * already exist, so "the credential is provisioned" no longer means the lane
 * publishes: `promote-cli.yml` mints the token only when the repository
 * variable `SKILLS_PUBLISH_ENABLED` is `true`, which rung 5(b) sets after the
 * publisher has been rehearsed against a real remote. Until then the token is
 * empty and every promote takes the skip branch by design.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SKILLS } from "../src/skill-embed";
import { Done, git, gitStatus, shellQuote } from "./plugin-git";
import {
  nonRegularTrackedFiles,
  PLUGIN_TOKEN_ENV,
  pluginPublishPlan,
  publishGate,
  redactRemote,
  unexpectedPluginFiles,
} from "./plugin-publish";

const cliRoot = join(import.meta.dir, "..");
const REPO = process.env.SKILLS_PLUGIN_REPO || "git@github.com:wego/skills.git";
const TOKEN_NAME = PLUGIN_TOKEN_ENV;

const plan = pluginPublishPlan(SKILLS.map((s) => s.id));

// Every source is stat'd BEFORE anything else happens, `--print-plan` included.
// Without this the flag would print the plan straight from a constant whether or
// not the files exist, so it would report three publishable files on a tree that
// has none - proving the plan's length rather than the publish.
const missing = plan
  .map((p) => p.from)
  .filter((from) => !existsSync(join(cliRoot, from)));
if (missing.length > 0) {
  console.error(
    `plugin publish: ${missing.length} source file(s) named by the plan do not exist:\n` +
      missing.map((m) => `  apps/cli/${m}`).join("\n"),
  );
  process.exit(1);
}

if (process.argv.includes("--print-plan")) {
  // Both sides, on purpose. The three destination names are fixed strings, so a
  // destination-only dump could never show that a source was drawn from the
  // eval corpus or the staging overlay - which is the mistake worth catching.
  for (const { from, to } of plan) console.log(`apps/cli/${from} -> ${to}`);
  process.exit(0);
}

const gate = publishGate(
  process.env[TOKEN_NAME],
  process.env.REQUIRE_PUBLISH === "true",
  TOKEN_NAME,
);
if (!gate.publish) {
  console.log(`plugin publish: ${gate.message}`);
  process.exit(gate.hardFail ? 1 : 0);
}

const work = mkdtempSync(join(tmpdir(), "wego-plugin-publish-"));
let exitCode = 0;
try {
  // Shallow: the publish reads the tip and writes on top of it. No history is
  // consulted, so fetching it would cost time and prove nothing.
  git(work, "clone", "--depth", "1", REPO, "repo");
  const repo = join(work, "repo");

  const staged = git(repo, "ls-files", "-s");
  const tracked = staged
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(line.indexOf("\t") + 1));
  // Two ways a clone can hold something this publish did not write: a path the
  // plan does not name, or a path it DOES name that is not a regular file.
  const offenders = [
    ...unexpectedPluginFiles(tracked, plan),
    ...nonRegularTrackedFiles(staged),
  ];
  if (offenders.length > 0) {
    const [first] = offenders;
    console.error(
      `plugin publish REFUSED: ${redactRemote(REPO)} holds ${offenders.length} entr(y/ies) this publish does not write:\n` +
        offenders.map((f) => `  ${f}`).join("\n") +
        "\n\nThis publisher never deletes. Unwedge it by hand, one of two ways:\n" +
        "  1. it does not belong - remove it from the repo:\n" +
        `       git clone ${shellQuote(redactRemote(REPO))} skills && cd skills && git rm -- ${shellQuote(first)} && git commit -m 'chore: drop stray entry' && git push\n` +
        "  2. it does belong - add it to `pluginPublishPlan()` in\n" +
        "     apps/cli/scripts/skill-publish.ts, with a source file to publish it from.\n" +
        "\nSee wego/foundations#127 for why this fails closed.",
    );
    throw new Done(1);
  }

  for (const { from, to } of plan) {
    const dest = join(repo, to);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(cliRoot, from), dest);
  }

  git(repo, "add", "-A");
  // `--quiet` + exit status: nothing staged means the repo already matches
  // source, which is the common case on a re-run and is not a failure.
  if (gitStatus(repo, "diff", "--cached", "--quiet") === 0) {
    console.log("plugin publish: already up to date, no commit made.");
    throw new Done(0);
  }

  git(
    repo,
    "-c",
    "user.name=wego-ai",
    "-c",
    "user.email=noreply@wego.com",
    "commit",
    "-m",
    "chore: sync the wego plugin from wego-ai",
  );
  git(repo, "push", "origin", "HEAD");
  console.log(
    `plugin publish: wrote ${plan.length} file(s) to ${redactRemote(REPO)}:\n` +
      plan.map((p) => `  ${p.to}`).join("\n"),
  );
} catch (e) {
  if (!(e instanceof Done)) throw e;
  exitCode = e.code;
} finally {
  rmSync(work, { recursive: true, force: true });
}

process.exit(exitCode);
