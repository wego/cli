/**
 * Pure helpers for the plugin publish/verify pipeline. The entry scripts
 * (`publish-plugin.ts`, `verify-plugin-published.ts`) are thin shells over
 * these, the same split as `release-config.ts` and `build-release.ts`.
 */
/** A missing token is a graceful skip (exit 0) unless `REQUIRE_PUBLISH=true`
 *  forces a hard failure (a deliberate release). Mirrors
 *  `upload-release-blob.ts`'s token gate. */
export function publishGate(
  token: string | undefined,
  requirePublish: boolean,
  what: string,
): { publish: boolean; hardFail: boolean; message: string } {
  if (token?.trim()) return { publish: true, hardFail: false, message: "" };
  const message = `${what} is unset – skipping the skill publish.`;
  return { publish: false, hardFail: requirePublish, message };
}

/** The directory whose contents are published to the plugin repo verbatim,
 *  relative to the repository root. A constant so relocating it is one edit.
 *  It should move to its own package only once the plugin needs to derive
 *  content rather than copy it, since that makes it a build. */
export const PLUGIN_SOURCE_DIR = "plugin";

export interface PluginPublishPair {
  /** Relative to this repository's root. */
  readonly from: string;
  /** Relative to the plugin repo root. */
  readonly to: string;
}

/**
 * Every file a promote writes to the plugin repo, and nothing else.
 *
 * Data rather than a sequence of copy calls, so the publisher copies it,
 * `--print-plan` prints it, and the after-clone predicate uses its destinations
 * as the expected set, all from one answer.
 *
 * The skill body is included because third-party discovery reads it from the
 * plugin repo; the CLI's own installs get the same source embedded in the
 * binary.
 *
 * `LICENSE` is required: the repo exists for third parties to read, and without
 * a licence it grants them no rights (the blocker to making `wego/skills`
 * public, foundations#98). It has a source file under `plugin/` like every
 * other published path, because the after-clone predicate relies on every
 * published path having a verbatim source.
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
 * One check covers an empty repo (nothing unexpected), the steady state
 * (exactly our paths), and a hand-committed stray file (named, and the publish
 * refuses). A modified tracked file is not an offender: correcting it is the
 * publish's job.
 *
 * Fail-closed and never deletes: a file we did not write is either a mistake or
 * something that belongs, and a publisher cannot tell which. A human removes it
 * with `git rm` or adds it to the plan.
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
 * {@link unexpectedPluginFiles} compares pathnames, and `git ls-files` lists a
 * symlink like a file, so a symlink committed at an expected destination passes
 * it. The copy that follows currently replaces it with a regular file rather
 * than writing through it, but that is a property of the copy call, so the mode
 * is checked explicitly.
 *
 * Regular blobs are `100644` / `100755`; a symlink is `120000` and a gitlink
 * (submodule) `160000`. Anything not a plain blob is returned and refuses the
 * publish.
 */
export function nonRegularTrackedFiles(lsFilesStaged: string): string[] {
  const out: string[] = [];
  for (const line of lsFilesStaged.split("\n")) {
    if (!line) continue;
    // `<mode> <object> <stage>\t<path>`: the path is after the first tab, so a
    // path containing a tab cannot split it wrong.
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const mode = line.slice(0, line.indexOf(" "));
    if (mode !== "100644" && mode !== "100755") out.push(line.slice(tab + 1));
  }
  return out;
}

/** Which of the plan's source files are absent under `root`, in plan order.
 *
 *  Both plugin-lane scripts must check this before touching git: otherwise a
 *  missing source throws ENOENT deep inside the work block, escapes the
 *  exit-code handling, and names only the first offender. Pure so it can be
 *  tested without a subprocess whose `cliRoot` cannot be redirected. */
export function missingPlanSources(
  root: string,
  plan: readonly PluginPublishPair[],
  exists: (path: string) => boolean,
): string[] {
  return plan.map((p) => p.from).filter((from) => !exists(`${root}/${from}`));
}

/** The env var both plugin-lane scripts gate on. Shared so the verify skips
 *  exactly when the publish skips.
 *
 *  The name is transport-neutral on purpose: it carries a GitHub App
 *  installation token, but both scripts only take the remote from
 *  `SKILLS_PLUGIN_REPO` and shell out to `git`. */
export const PLUGIN_TOKEN_ENV = "SKILLS_PUBLISH_TOKEN";

/** Strip any `user:password@` from a remote URL before it is logged.
 *
 *  In CI the token travels in an HTTP header, not the remote URL, so this is
 *  defence in depth: a `SKILLS_PLUGIN_REPO` carrying a token in its userinfo
 *  would otherwise be echoed into CI logs by every message that names the
 *  remote, including the `git clone` line an operator is told to paste. */
export function redactRemote(text: string): string {
  // Matches anywhere, not just at the start: `git()` renders a failed command
  // as `git clone <remote> failed: ...`.
  //
  // Redacts only userinfo containing a `:` (a password). `ssh://git@host/repo`
  // names an identity, not a secret, and rewriting it would break the pasteable
  // `git clone` line. An scp-style address (`git@host:path`) has no `//` and is
  // left alone.
  //
  // The password test is in code rather than the pattern, and every quantifier
  // is bounded, to avoid the O(n^2) backtracking of a pattern like
  // `[^/@\s]*:[^/@\s]*@` on input with no `@`. The limits are far above any
  // real scheme or userinfo.
  return text.replaceAll(
    /([a-zA-Z][\w+.-]{0,31}:\/\/)([^/@\s]{0,255})@/g,
    (whole, scheme: string, userinfo: string) =>
      userinfo.includes(":") ? `${scheme}***@` : whole,
  );
}

/** Where two published/source buffers first differ. The offset plus both
 *  lengths locates the problem without dumping the bodies.
 *
 *  When one buffer is a prefix of the other, the reported offset is the shorter
 *  length: a truncated publish, which comparing only the overlap would call
 *  equal. */
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
