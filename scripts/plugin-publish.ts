/**
 * Pure, importable helpers for the plugin publish/verify pipeline. The
 * imperative entry scripts (`publish-plugin.ts`, `verify-plugin-published.ts`)
 * are thin shells over these — the testable logic lives here, mirroring how
 * `release-config.ts` is split from `build-release.ts`.
 *
 * In wego-ai these helpers shared a module with the skill Blob channel
 * (`skill-publish.ts`). The skill channel is gone (this repo publishes no skill
 * body; the skill ships embedded in the binary and `update` re-runs
 * `skill install --owned-only`), so its half of that module went with it and
 * the plugin half moved here, beside the `plugin-publish.test.ts` that already
 * covered it. The bodies below are unchanged.
 */
/** Whether a publish step can run given its required token; a skip is graceful
 *  (exit 0) unless `REQUIRE_PUBLISH=true` forces a hard failure (a deliberate
 *  release). Mirrors `upload-release-blob.ts`'s token gate. */
export function publishGate(
  token: string | undefined,
  requirePublish: boolean,
  what: string,
): { publish: boolean; hardFail: boolean; message: string } {
  if (token?.trim()) return { publish: true, hardFail: false, message: "" };
  const message = `${what} is unset – skipping the skill publish.`;
  return { publish: false, hardFail: requirePublish, message };
}

/** The ONE directory under `apps/cli/` whose contents are published to the
 *  plugin repo verbatim, relative to the app root.
 *
 *  A single constant because relocating the source root must be one edit, not a
 *  search. The move to `packages/wego-plugin/` is triggered by the plugin
 *  needing to DERIVE content from a second app - not by a second file appearing
 *  here - because deriving is what makes it a build rather than a copy. */
export const PLUGIN_SOURCE_DIR = "plugin";

/** One published file: where it comes from under `apps/cli/`, and the path it
 *  takes in the plugin repo. */
export interface PluginPublishPair {
  /** Source path, relative to the `apps/cli` app root. */
  readonly from: string;
  /** Destination path, relative to the plugin repo root. */
  readonly to: string;
}

/**
 * Every file a promote writes to the plugin repo, and nothing else.
 *
 * The published set is a DATA structure rather than a sequence of copy calls, so
 * the three things that need it can share one answer: the publisher copies it,
 * `--print-plan` prints it, and the after-clone predicate uses its destinations
 * as the expected set. Adding `mcp.json` later is one entry here; relocating the
 * sources is {@link PLUGIN_SOURCE_DIR}. Neither touches publisher logic.
 *
 * The skill body is included because the plugin repo is where third-party
 * discovery reads it from - the Blob channel serves the CLI's own installs, and
 * these are two consumers of the same canonical source, never two sources.
 *
 * `LICENSE` is published for the same reason and is load-bearing rather than
 * decorative: the repo exists to be READ by third parties, and a repo with no
 * licence grants no rights to the people it is published for. It was the one
 * blocker named against making `wego/skills` public (foundations#98), and the
 * verbatim Apache 2.0 text carries it. It gets a source file under `plugin/`
 * like every other published path, because "every published path has a verbatim
 * source file" is the rule the after-clone predicate depends on.
 */
export function pluginPublishPlan(
  skillIds: readonly string[],
): PluginPublishPair[] {
  return [
    { from: `${PLUGIN_SOURCE_DIR}/plugin.json`, to: "plugin.json" },
    { from: `${PLUGIN_SOURCE_DIR}/README.md`, to: "README.md" },
    { from: `${PLUGIN_SOURCE_DIR}/LICENSE`, to: "LICENSE" },
    ...skillIds.map((id) => ({
      from: `skills/${id}/SKILL.md`,
      to: `skills/${id}/SKILL.md`,
    })),
  ];
}

/**
 * The after-clone subset predicate: every path tracked in the plugin repo must
 * be one this plan writes. Returns the offenders, empty when the tree is clean.
 *
 * ONE check covers three states that would otherwise need three: an empty repo
 * (nothing tracked, so nothing unexpected), the steady state (exactly our
 * paths), and a stray file somebody hand-committed (named here, and the publish
 * refuses). A modified tracked file is not an offender at all - it is the case
 * the publish exists to correct.
 *
 * Fail-closed on purpose, and it never deletes: a file we did not write is
 * either somebody's mistake or something that turned out to belong, and a
 * publisher cannot tell which. A human removes it with one `git rm`, or adds it
 * to the plan.
 */
export function unexpectedPluginFiles(
  tracked: readonly string[],
  plan: readonly PluginPublishPair[],
): string[] {
  const expected = new Set(plan.map((p) => p.to));
  return tracked.filter((path) => path.length > 0 && !expected.has(path));
}

/**
 * Tracked entries that are not regular files, from `git ls-files -s` output.
 *
 * {@link unexpectedPluginFiles} compares PATHNAMES, and `git ls-files` lists a
 * tracked symlink by its pathname exactly like a file - so a symlink committed
 * AT one of the expected destinations passes that check untouched. Today the
 * copy that follows replaces it with a regular file rather than writing through
 * it, so nothing escapes the repo, but that is a property of the copy call
 * rather than of this lane, and "we only write regular files" is the thing this
 * publisher actually means. So the mode is checked rather than inferred.
 *
 * Regular blobs are `100644` / `100755`; a symlink is `120000` and a gitlink
 * (submodule) `160000`. Anything not a plain blob is returned and refuses the
 * publish.
 */
export function nonRegularTrackedFiles(lsFilesStaged: string): string[] {
  const out: string[] = [];
  for (const line of lsFilesStaged.split("\n")) {
    if (!line) continue;
    // `<mode> <object> <stage>\t<path>` - the path is after the FIRST tab, so a
    // path containing a tab cannot split it wrong.
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const mode = line.slice(0, line.indexOf(" "));
    if (mode !== "100644" && mode !== "100755") out.push(line.slice(tab + 1));
  }
  return out;
}

/** Which of the plan's SOURCE files are absent under `root`, in plan order.
 *
 *  Both plugin-lane scripts must check this BEFORE they touch git: a source
 *  that is not there throws ENOENT from deep inside the work block, escapes the
 *  exit-code handling, and kills the step with a stack trace instead of a
 *  report - naming only the first offender rather than all of them. Pure and
 *  exported so the rule is tested directly rather than through a subprocess
 *  whose `cliRoot` cannot be pointed elsewhere. */
export function missingPlanSources(
  root: string,
  plan: readonly PluginPublishPair[],
  exists: (path: string) => boolean,
): string[] {
  return plan.map((p) => p.from).filter((from) => !exists(`${root}/${from}`));
}

/** The env var both plugin-lane scripts gate on. Shared, not re-declared: the
 *  docs claim the verify "skips precisely when the publish skips", and two
 *  independent string literals agreeing is a coincidence rather than a
 *  guarantee. One constant makes the claim structural.
 *
 *  TRANSPORT-NEUTRAL BY NAME. This was `SKILLS_DEPLOY_KEY` when the lane
 *  authenticated with an SSH deploy key; it now carries a GitHub App
 *  installation token. Neither script cares - both take the remote from
 *  `SKILLS_PLUGIN_REPO` and shell out to `git` - which is exactly why the name
 *  must not describe a mechanism the code does not depend on. */
export const PLUGIN_TOKEN_ENV = "SKILLS_PUBLISH_TOKEN";

/** Strip any `user:password@` from a remote URL before it is logged.
 *
 *  Today the plugin remote is an SSH URL carrying no credential, so this is a
 *  no-op. It stops being one the moment the lane moves to a token transport
 *  (`https://x-access-token:<token>@github.com/...`), which is the documented
 *  direction: GitHub recommends a GitHub App over a deploy key, and an App token
 *  in the URL would otherwise be echoed into CI logs by every message that names
 *  the remote - including the `git clone` line the refusal tells an operator to
 *  paste. Actions would mask a registered secret, but a masked token in a
 *  pasteable command is still a broken command. */
export function redactRemote(text: string): string {
  // TWO THINGS THIS GETS RIGHT, BOTH MEASURED, BOTH WRONG IN THE FIRST VERSION.
  //
  // 1. It matches ANYWHERE, not just at the start. The first version was
  //    anchored, so it redacted a bare URL and silently did nothing to the same
  //    URL inside a sentence - which is exactly where one appears: `git()`
  //    renders a failed command as `git clone <remote> failed: ...`.
  //
  // 2. It redacts only userinfo carrying a PASSWORD - a `:` inside it.
  //    `ssh://git@host/repo` and `https://user@host/repo` name an identity, not
  //    a secret, and the first version rewrote them to `ssh://***@host/repo`.
  //    That breaks the `git clone` line an operator is told to paste, for no
  //    gain - the same objection that keeps the token out of the URL to begin
  //    with. An `scp`-style address (`git@host:path`) has no password field at
  //    all and is left alone by construction, since it has no `//`.
  // ONE quantifier, terminated by `@`, with the password test in code rather
  // than in the pattern. The previous form was `[^/@\s]*:[^/@\s]*@` - two
  // unbounded classes split by a required `:` - so on input with no `@` the
  // engine retries every split point, which is O(n^2) and the shape static
  // analysis flags as a slow-regex hazard. This scans the userinfo once.
  // BOUNDED quantifiers, and `replaceAll`. Every quantifier here has a ceiling,
  // so there is no backtracking blow-up to reason about - the previous form was
  // `[^/@\s]*:[^/@\s]*@`, two unbounded classes split by a required `:`, which
  // retries every split point on input with no `@`. The limits are far above any
  // real scheme or userinfo and simply cap the work.
  return text.replaceAll(
    /([a-zA-Z][\w+.-]{0,31}:\/\/)([^/@\s]{0,255})@/g,
    (whole, scheme: string, userinfo: string) =>
      userinfo.includes(":") ? `${scheme}***@` : whole,
  );
}

/** Where two published/source buffers first differ, for an error a human can
 *  act on (foundations#101 rung 4b). Dumping the bodies would bury the answer;
 *  the offset plus both lengths locates it.
 *
 *  When one buffer is a PREFIX of the other no byte differs inside the overlap,
 *  so the reported offset is the shorter length - a truncated publish, which a
 *  scan that only compared the overlap would call equal. */
export function describeMismatch(expected: Buffer, actual: Buffer): string {
  const limit = Math.min(expected.length, actual.length);
  let at = limit;
  for (let i = 0; i < limit; i++) {
    if (expected[i] !== actual[i]) {
      at = i;
      break;
    }
  }
  return (
    `differs at byte ${at} ` +
    `(source ${expected.length} bytes, published ${actual.length} bytes)`
  );
}
