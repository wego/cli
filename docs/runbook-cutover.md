# Cutover runbook — 3b, in one sitting

This is the script for **wego/foundations#133**: the hour in which `wego/cli` takes
production `cli/edge` and `cli/next` from `wego/wego-ai`. Written at 2b
(wego/foundations#131) while there was time to get it right; read it end to end
before the sitting starts, then follow it line by line.

**Who runs what.** Lines marked **Human** need a credential or a right the coding
agent does not hold: an org admin, the Vercel team, a merge, a repository setting.
Lines marked **Agent** need only a repo-scoped GitHub token, `git`, `bun` and `curl`.
The agent never holds a token value, never runs `vercel`, never merges, never pushes
or moves a tag, never edits a ruleset or a setting.

**Do not stop between step 5 and step 6.** Between the lane deletion merging in
wego-ai and `wego/cli` 1.2.0 reaching `cli/next`, wego-ai cannot hotfix the CLI and
`wego/cli` has not yet released. Every other boundary in this file is a safe stop.

**Three code owners on the call for the whole sitting.** No CLI puts three people in
a room; this is the one prerequisite with no command.

---

## Measured state, and where it differs from the issue text

Everything below was read from the live repositories on 2026-09-11/12 while writing
this runbook. **Re-run each command at the start of the sitting** — this section is a
record, not an assumption, and a difference is a reason to stop and re-plan.

| What | Measured | Where the issue text differs |
|---|---|---|
| Rehearsal tags on `wego/cli` | `v1.0.2`, `v1.0.3`, `v1.0.4`, `v1.0.5` — four tags, four Releases | #131's checklist says "`v1.0.2` to `v1.0.4`". #133's 2026-09-11 amendment corrects it to `v1.0.5`. **Delete four, plus the probe tag from step 0.** |
| `wego/cli` `main` version | `.release-please-manifest.json` `{".": "1.0.5"}`, `package.json` `1.0.5` | Step 2 sets both to `1.1.0`. |
| `ci-cli` required on wego-ai `main` | **Not required by any mechanism.** `…/branches/main/protection/required_status_checks` → 404 "Required status checks not enabled"; `…/rules/branches/main` → `deletion`, `non_fast_forward`, `pull_request` only | #133's prerequisites table and its preflight both assume `ci-cli` is required. **#133's preflight line `… -q '.contexts[]' \| grep -qx ci-cli` exits non-zero and fails the preflight before step 1.** Step 5 is a no-op today; verify, do not assume. |
| Force-push on `wego/cli` `main` | Blocked **twice**: classic protection `allow_force_pushes: false`, *and* `non_fast_forward` from the **organization** ruleset `14768298` ("Default branch ruleset", source `wego`) | #133's table names only the classic toggle. **Lifting classic protection alone will not let the squash through.** See step 4. |
| `wego/cli` tag ruleset | `22870024` "v-tags", target `tag`, `refs/tags/v*`, rules `creation` + `update` + `deletion`; bypass actors `OrganizationAdmin` and one Integration (the release-please App) | Tag deletion in step 3 needs an **org admin**, not merely a code owner. A code owner's push is refused with `GH013 … Cannot create ref due to creations being restricted`. |
| `cli-frozen-until-cutover` ruleset | Does not exist | #128 dropped it by decision. The deletion command in Appendix B is kept for completeness and is expected to 404. |
| `rehearsal/cli-install` branch and its Vercel variables | Never created | #128 amended the preview away; #129's manual install runs on loopback. Nothing to delete in step 7. |
| `production` environment on `wego/cli` today | variables `SKILLS_PUBLISH_ENABLED`, `SMOKE_INSTALL_URL`, `WEGO_API_URL`, `WEGO_AUTH_AUTHORIZE_URL`, `WEGO_AUTH_TOKEN_URL`, `WEGO_CLI_CLIENT_ID`; secret `BLOB_READ_WRITE_TOKEN` | Step 1 adds `SKILLS_PUBLISH_APP_CLIENT_ID` and the secret `SKILLS_PUBLISH_APP_PRIVATE_KEY`, and overwrites the two that already exist. |
| Build-time variables (`WEGO_CLI_POSTHOG_PROJECT_KEY`, `WEGO_CLI_SKILL_ORIGIN`) | Belong at **repo** level, not in the `production` environment | `release-cli.yml`'s `build` job has no `environment:`, so it reads `vars.*` from the repository only. Setting these with `--env production` bakes an empty value and fails silently — see step 1. |
| Extraction source sha | `wego/wego-ai@0e9f6bfe60864e6226decbebdd3e5b7535c7080e` — the sha #133's drift check compares from | The squash commit subject in step 4 names it. |

Record the production rings before touching anything, and diff against
`prod-rings-before-phase-1.txt` (the 1b record, on wego/foundations#129):

```bash
rings() { for r in edge next stable; do printf '%s ' "$r"; \
  curl -fsSL "https://api.wego.com/install?dl=VERSION&ring=$r"; printf ' '; \
  curl -fsSL "https://api.wego.com/install?dl=SHA256SUMS.txt&ring=$r" | sha256sum | cut -c1-16; done; }
rings | tee prod-rings-before-3b.txt
diff prod-rings-before-phase-1.txt prod-rings-before-3b.txt
```

Expected at the start of 3b: `stable 1.1.0`, `next 1.1.0`, `edge` a wego-ai build.

---

## Step 0 — the commit-binding probe (**Human, org admin**), BEFORE anything else

Deferred into 3b from 1b (#129 item 9) because `refs/tags/v*` is restricted by the
`v-tags` ruleset and no org admin was free during 1b.

**It must run before step 1.** The probe publishes real artifacts to whatever store
the `production` environment's `BLOB_READ_WRITE_TOKEN` names. That is the *rehearsal*
store right now, and step 1 swaps it to production — run this after the swap and it
writes throwaway objects into the production store.

```bash
git fetch origin
git tag v1.0.6 <a commit on main> && git push origin v1.0.6
#   expect SUCCESS: publishes cli/v1.0.6/ + cli-sig/v1.0.6/, advances rehearsal cli/next to 1.0.6

git tag -f v1.0.6 <a DIFFERENT commit on main> && git push -f origin v1.0.6
#   expect FAILURE in the publisher:
#   "cli/v1.0.6/ was first published from commit <first>, but this run is <second>."
```

Two constraints 1b learned the hard way, both of which produce an identical gate
failure that proves nothing:

- **The tag must be a plain `vX.Y.Z`.** `release-cli.yml` refuses any version
  containing `-`, so `v0.0.1-throwaway` dies at the gate.
- **Both commits must already be on `main`.** The lane runs
  `git merge-base --is-ancestor HEAD refs/remotes/origin/main`, so a commit on a
  throwaway branch dies at the gate too.

Record both run IDs. The guard is `scripts/upload-release-blob.ts:431-437`; it exists
because `bun build --compile` is not reproducible, so a force-moved tag would
otherwise mix bytes from two commits under one version.

**Rollback:** none needed. The probe's blobs go with the rehearsal store in step 7;
its tag `v1.0.6` joins the deletion list in step 3. The first push advancing rehearsal
`cli/next` to `1.0.6` does not matter — that store is deleted in this sitting.

---

## Step 1 — the production environment (**Human**)

The token swap. After this line, `wego/cli`'s release lane writes the **production**
blob store.

Mint the token first and prove it reads production **before** storing it. Vercel has
no `vercel blob` token command: connect the production blob store to a project made
for the purpose (dashboard → Storage → the store → Connect project, then
`vercel env pull` there), or copy it from the store's page.

```bash
# Prove the token before it is stored. Run in the rights-holder's own shell; the
# value is never typed into a transcript.
BLOB_READ_WRITE_TOKEN="$PROD_TOKEN" vercel blob list --prefix cli/stable/   # must list production stable
```

Then set the environment. Values, in the order of the #133 prerequisites table:

**Two of these are REPO-level, not environment-level, and the difference is not
cosmetic.** `release-cli.yml`'s `build` job carries no `environment:` — deliberately,
so a build can never reach the store token. A job without an environment resolves
`vars.*` from the repository only, so a build-time variable set with `--env production`
is invisible to the job that bakes it: the build silently produces a binary with an
empty value and nothing fails. That is exactly what happened to the PostHog key, which
sat unset through the v1.2.0 release (fixed 2026-09-14). It is also why
`WEGO_API_URL`, `WEGO_AUTH_*` and `WEGO_CLI_CLIENT_ID` are duplicated at both levels.

The rule: **baked into the binary → repo level. Touches the store → `--env production`.**

```bash
# Repo level — read by release-cli.yml's `build` job, which has NO environment.
gh variable set WEGO_CLI_POSTHOG_PROJECT_KEY -R wego/cli --body <key>
gh variable set WEGO_CLI_SKILL_ORIGIN        -R wego/cli --body <store origin>

# Environment level — read only by jobs that enter `production`.
gh secret   set BLOB_READ_WRITE_TOKEN        --env production -R wego/cli < prod-token.txt
gh variable set SMOKE_INSTALL_URL            --env production -R wego/cli --body https://api.wego.com/install
gh variable set SKILLS_PUBLISH_ENABLED       --env production -R wego/cli --body true
gh variable set SKILLS_PUBLISH_APP_CLIENT_ID --env production -R wego/cli --body <id>
gh secret   set SKILLS_PUBLISH_APP_PRIVATE_KEY --env production -R wego/cli < skills-app.pem
```

- `WEGO_CLI_POSTHOG_PROJECT_KEY` — copied from wego-ai's `Production – cli`
  environment: `gh variable list -R wego/wego-ai --env 'Production – cli'`. Must be a
  write-only `phc_` project key; `release-config.ts` rejects anything else. Because it
  lives at repo level it is visible to **every** job, including `edge-cli.yml`'s — which
  is why that lane suppresses telemetry by not passing the variable to its build step
  rather than by relying on the key's absence from an environment.
- `WEGO_CLI_SKILL_ORIGIN` — the bare origin of the Blob store `wego skill install`
  fetches from. Must name the store `wego/cli`'s own production `BLOB_READ_WRITE_TOKEN`
  writes to; do not copy wego-ai's value without confirming it is the same store.
- `BLOB_READ_WRITE_TOKEN` — the production blob store token minted for `wego/cli`.
  Overwrites the rehearsal token. wego-ai keeps its own until the 3c tail.
- `SMOKE_INSTALL_URL` — `https://api.wego.com/install`. Repointing it away from
  loopback makes the Phase 1 resolver step **inert** (the variable is both the value
  and the switch: the step runs only when it names loopback) but does not remove it.
  Step 1b below deletes it in the same PR.
- `SKILLS_PUBLISH_ENABLED` — `true`.
- `SKILLS_PUBLISH_APP_CLIENT_ID` / `SKILLS_PUBLISH_APP_PRIVATE_KEY` — copied from
  wego-ai. The secret cannot be read back from wego-ai; whoever holds the PEM supplies
  it. **Arming this lane is all-or-nothing** — the flag without the credentials fails
  at token minting — and the lane has never executed; its first real run is #134's
  production promote.

Install the skills App on `wego/cli`:

```bash
gh api -X PUT /user/installations/<skills App installation id>/repositories/$(gh api repos/wego/cli -q .id)
```

**Verify:**

```bash
gh api repos/wego/cli/environments/production/secrets -q '.secrets[].name'   # BLOB_READ_WRITE_TOKEN, SKILLS_PUBLISH_APP_PRIVATE_KEY
gh variable list -R wego/cli --env production                                 # SMOKE_INSTALL_URL=https://api.wego.com/install, SKILLS_PUBLISH_ENABLED=true
gh variable list -R wego/cli                                                  # WEGO_CLI_POSTHOG_PROJECT_KEY and WEGO_CLI_SKILL_ORIGIN present HERE, not in the environment
```

Checking the environment listing alone is what let the missing PostHog key go
unnoticed: the build-time variables will never appear there.

**Rollback:** set `BLOB_READ_WRITE_TOKEN` back to the rehearsal token and
`SMOKE_INSTALL_URL` back to its loopback value. Nothing has been published yet, so
this fully undoes the step.

### Step 1b — delete the Phase 1 rehearsal scaffolding, in the same PR

Amended into #133 on 2026-09-11: repointing the variable makes the resolver step inert
but leaves it in the production tree as dead code nothing was scheduled to remove.

**Done 2026-09-14**, not in #133's PR — it was missed there and the scaffolding survived
into the v1.2.0 tree, inert but present.

Delete `scripts/rehearsal-install-resolver.ts`, its step in
`.github/workflows/release-cli.yml`, and SMOKE 3's `--install-url "$SMOKE_INSTALL_URL"`
argument — so the smoke reads the predecessor's own reinstall hint, as wego-ai always
did.

```bash
grep -rn rehearsal-install-resolver .github/ scripts/ src/   # must print nothing
grep -rn 'install-url' .github/          # must print nothing
```

**Rollback:** revert the PR. The variable is what makes the step inert, so a revert
alone changes no behaviour while `SMOKE_INSTALL_URL` names production.

---

## Step 2 — the version floor (**Agent**, merged by a **Human**)

`wego/cli` must claim `1.1.0` — the last version wego-ai released — so release-please
computes `1.2.0` from the single `feat` commit step 4 creates.

```bash
# .release-please-manifest.json
{
  ".": "1.1.0"
}
# package.json
"version": "1.1.0",
```

Open it as a PR, get `gh pr checks --required` green, and have a code owner merge it.

**Verify:** `gh api repos/wego/cli/contents/.release-please-manifest.json -q .content | base64 -d`

**Rollback:** revert the PR. Nothing downstream has read the manifest yet.

---

## Step 3 — delete the rehearsal tags and Releases (**Human, org admin**)

Four rehearsal tags plus the step 0 probe tag. `deletion` on `refs/tags/v*` is
restricted by ruleset `22870024`; only an `OrganizationAdmin` (or the release-please
App) can do this.

**Delete by tag, not by walking the Release list.** All four rehearsal Releases exist;
only `v1.0.5` carries a `SHA256SUMS.txt` asset, because only its run reached the
Release step. release-please's App creates the Release; the lane only attaches the
asset — so a Release can exist with nothing under it.

```bash
for t in v1.0.2 v1.0.3 v1.0.4 v1.0.5 v1.0.6; do
  gh release delete "$t" -R wego/cli --yes --cleanup-tag
done
```

**Verify — this is the assertion that a silent failure used to slip past:**

```bash
gh api repos/wego/cli/tags --jq length     # must be 0
gh release list -R wego/cli                # must be empty
```

A tag that survives here is a rehearsal build left in the production repository, and
after step 4's squash it points at an orphaned commit.

**Rollback:** none, and none is needed — these are rehearsal artifacts with no
production consumer. If a tag was deleted in error, re-create it from the sha in the
run log; but note this is exactly what step 4 makes impossible, so do it before step 4
or not at all.

---

## Step 4 — squash `main` to one commit (**Human, org admin**)

The history is squashed **before** the first production release, because the `COMMIT`
sidecar records the publishing sha and a rewrite after it would orphan the tag.

The commit subject is typed `feat`, which is what makes release-please compute
**1.2.0**:

```
feat: the wego CLI, extracted from wego/wego-ai@0e9f6bfe60864e6226decbebdd3e5b7535c7080e
```

**Force-push is blocked twice on this branch.** Classic protection's
`allow_force_pushes: false` is only half of it; `non_fast_forward` also applies from
the **organization** ruleset `14768298`, whose bypass actors this runbook's author
could not read (it needs `admin:org`). Before the sitting, confirm which of these two
is true and plan accordingly:

```bash
gh api repos/wego/cli/rules/branches/main -q '.[] | "\(.type) from ruleset \(.ruleset_id) (\(.ruleset_source_type) \(.ruleset_source))"'
gh api /orgs/wego/rulesets/14768298 -q '.bypass_actors'   # needs admin:org
```

- If the org ruleset grants `OrganizationAdmin` bypass (as `v-tags` does), an org
  admin force-pushes with no ruleset edit at all — lift classic protection only.
- If it does not, the org ruleset must be edited at **org** level for the minute the
  squash takes. See Appendix B; a repo-level `PUT` cannot touch an org ruleset.

```bash
# 1. lift classic protection (full object; see Appendix A)
gh api -X PUT repos/wego/cli/branches/main/protection --input protection-force-on.json

# 2. squash and push
git checkout main && git fetch origin && git reset --hard origin/main
OLD=$(git rev-parse HEAD)
git checkout --orphan squashed && git add -A
git commit -m "feat: the wego CLI, extracted from wego/wego-ai@0e9f6bfe60864e6226decbebdd3e5b7535c7080e"
git branch -M squashed main
git push --force origin main

# 3. restore protection IMMEDIATELY (full object; see Appendix A)
gh api -X PUT repos/wego/cli/branches/main/protection --input protection.json
```

**Verify — the tree must be byte-identical to what was there before:**

```bash
git diff "$OLD" main                       # must be empty
git log --reverse --oneline origin/main | head -1   # the feat: import commit, and nothing before it
gh api repos/wego/cli/branches/main/protection -q '.allow_force_pushes.enabled'   # false again
```

Then: **everyone re-clones.** Close and reopen any open `wego/cli` PR — their bases
are gone.

**Rollback:** `git push --force origin $OLD:main` within the same window, before any
release runs. Once step 6's tag exists, the squash is permanent — the sidecar binds
the release to the squashed sha.

---

## Step 5 — hand the rings over in wego-ai (**Human**) · ⚠️ DO NOT STOP AFTER THIS LINE

First remove `ci-cli` from wego-ai's required status checks — **a required check that
never reports blocks every PR in the repository.** As measured above, wego-ai has no
required status checks at all today, so this is expected to be a no-op. Verify rather
than assume:

```bash
gh api repos/wego/wego-ai/branches/main/protection/required_status_checks -q '.contexts[]'
gh api repos/wego/wego-ai/rules/branches/main -q '.[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context'
```

If either lists `ci-cli`, remove it with the matching command in Appendix B **before**
merging the PR below.

There is no `cli-frozen-until-cutover` ruleset to delete (#128 dropped it by
decision); the deletion command is in Appendix B and is expected to 404.

Then merge the lane-deletion PR — **wego/wego-ai#1916**, "CUTOVER, merge only at 3b".
Rebase it on current `main` first and confirm CI is green.

```bash
gh pr view 1916 -R wego/wego-ai --json mergeStateStatus -q .mergeStateStatus   # CLEAN
gh pr checks 1916 -R wego/wego-ai --required
```

**Verify after the merge:**

```bash
gh api repos/wego/wego-ai/actions/workflows -q '.workflows[].path' | grep -E 'release-cli|edge-cli|ci-cli'   # no output
gh run list -R wego/wego-ai -b main -L 5                                        # green
gh pr list -R wego/wego-ai -L 5 --json number,mergeable                         # an unrelated PR still MERGEABLE
```

**Rollback:** revert the merge commit in wego-ai. The lanes come back and wego-ai can
promote `cli-v1.1.0` again. This is the last cheap rollback in the sitting.

---

## Step 6 — release `wego/cli` 1.2.0 (**Human** merges; **Agent** watches)

release-please opens the 1.2.0 release PR from the single `feat` commit. Check its
diff before merging: version to `1.2.0`, changelog with one entry, nothing else.

**Human: merge it.** That merge is the release.

The tag `v1.2.0` starts `release-cli.yml`, which must, in order: publish `cli/v1.2.0/`;
pass refuse-if-behind (1.1.0 is behind); advance production `cli/next`; then run
**SMOKE 3**, which downloads the 1.1.0 predecessor and updates it onto 1.2.0 through
`api.wego.com/install?dl=…&ring=next`. **This is the first live cross-repo update on
production bytes.**

The same merge runs `edge-cli.yml` into production `cli/edge`. Confirm both.

```bash
gh run list -R wego/cli -L 5 --json databaseId,name,conclusion,headBranch
gh run view <release run id> -R wego/cli --log | grep -iE 'smoke 3|predecessor|installUrl'
curl -fsSL 'https://api.wego.com/install?dl=VERSION&ring=next'     # 1.2.0
curl -fsSL 'https://api.wego.com/install?dl=VERSION&ring=edge'     # 1.2.x-edge.<sha>
curl -fsSL 'https://api.wego.com/install?dl=VERSION&ring=stable'   # still 1.1.0
```

On a machine following `next`, `wego update -y` must land 1.2.0. Record it.

**Rollback — if SMOKE 3 fails:** promote `cli-v1.1.0` over it from wego-ai's
`promote-cli.yml`. `allow_not_next` is **not** needed, because `next` is the target.
Read the smoke's record, fix in `wego/cli`, release again. This path stays open only
while wego-ai's `promote-cli.yml` and its repo-scope token exist — they are kept until
the 3c tail precisely for this.

---

## Step 7 — teardown (**Human** for the store)

Safe to stop before this; nothing below is load-bearing for production.

```bash
# The rehearsal blob store. Its token dies with it, along with every rehearsal
# artifact and the step 0 probe's blobs.
vercel blob list-stores --all           # find wego-cli-rehearsal
#   then delete it in the dashboard: Storage → wego-cli-rehearsal → Delete

# wego-ai's `Production – cli` environment: after the lane deletion nothing reads it.
gh api -X DELETE repos/wego/wego-ai/environments/Production%20%E2%80%93%20cli
```

**Nothing else to delete.** There is no `rehearsal/cli-install` branch and there are
no branch-scoped Vercel variables in the `apps/api` project — #128 amended that
preview out of existence and #129's manual install ran on loopback.

**Keep**, deliberately:

- `cli/cli-v1.1.0/` **and** `cli-sig/cli-v1.1.0/` in the production store — the
  legacy bridge. **Never deleted by any lane, issue or cleanup.** See the
  never-delete rule at the end of this file; it has no expiry date.
- `skill/next` and `skill/stable` — frozen, read by pre-relay binaries.
- wego-ai's `promote-cli.yml`, `publish-skill.yml`, repo-scope `BLOB_READ_WRITE_TOKEN`
  and skills App secrets — the way back, until the 3c tail.
- wego-ai's `apps/cli` — Phase 4.1.
- This runbook — Phase 4.7.

**Verify:**

```bash
curl -s -o /dev/null -w '%{http_code}\n' <rehearsal store>/cli/next/VERSION   # 404
```

Vercel's token list for the production blob store should show exactly two tokens:
wego-ai's and wego/cli's.

**Rollback:** none. Everything here is a rehearsal artifact. If the store is deleted
early by mistake, the rehearsal is simply unrepeatable — production is untouched.

---

## Appendix A — the two branch-protection payloads

`wego/cli` `main` as measured on 2026-09-12. Both are **full** objects: classic
protection has no single force-push toggle, so each `PUT` must restate every field or
the omitted ones are cleared.

**`protection-force-on.json`** — for the minute the squash takes:

```json
{
  "required_status_checks": {
    "strict": false,
    "contexts": ["ci-cli"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": true,
    "require_last_push_approval": false,
    "required_approving_review_count": 1
  },
  "restrictions": null,
  "required_linear_history": false,
  "allow_force_pushes": true,
  "allow_deletions": false,
  "block_creations": false,
  "required_conversation_resolution": false,
  "lock_branch": false,
  "allow_fork_syncing": false
}
```

**`protection.json`** — the Phase 1 state, restored immediately after. Identical but
for one field:

```json
{
  "required_status_checks": {
    "strict": false,
    "contexts": ["ci-cli"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": true,
    "require_last_push_approval": false,
    "required_approving_review_count": 1
  },
  "restrictions": null,
  "required_linear_history": false,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_conversation_resolution": false,
  "lock_branch": false,
  "allow_fork_syncing": false
}
```

Re-read the live object before the sitting and regenerate these two files from it, so
a setting changed between now and 3b is not silently reverted by a stale payload:

```bash
gh api repos/wego/cli/branches/main/protection > protection-live.json
```

---

## Appendix B — ruleset commands

**Which mechanism guards a branch:**

```bash
gh api repos/wego/wego-ai/rules/branches/main    # shows every rule and the ruleset it came from
gh api repos/wego/cli/rules/branches/main
gh api repos/wego/wego-ai/rulesets -q '.[] | "\(.id) \(.name) \(.target) \(.enforcement)"'
gh api repos/wego/cli/rulesets     -q '.[] | "\(.id) \(.name) \(.target) \(.enforcement)"'
```

**Edit — remove `ci-cli` from required checks (step 5).** Classic protection first;
this is the mechanism #133's table names:

```bash
gh api repos/wego/wego-ai/branches/main/protection/required_status_checks -q '.contexts[]' > checks-before.txt
# author checks.json as the same list MINUS ci-cli, e.g. {"strict": false, "contexts": ["ci-api", ...]}
gh api -X PATCH repos/wego/wego-ai/branches/main/protection/required_status_checks --input checks.json
```

If the checks are enforced by a **repository** ruleset instead, edit that ruleset —
the `PUT` replaces the whole object, so read it first:

```bash
gh api repos/wego/wego-ai/rulesets/<id> > ruleset.json
# drop the ci-cli entry from .rules[] | select(.type=="required_status_checks") | .parameters.required_status_checks
gh api -X PUT repos/wego/wego-ai/rulesets/<id> --input ruleset.json
```

If it is an **organization** ruleset — which is what guards `main` in both repositories
today (`14768298`, source `wego`) — the repo endpoint cannot touch it. It needs
`admin:org` and the org endpoint:

```bash
gh auth refresh -h github.com -s admin:org
gh api /orgs/wego/rulesets/14768298 > org-ruleset.json
gh api -X PUT /orgs/wego/rulesets/14768298 --input org-ruleset.json
```

This is also the lever for step 4 if the org ruleset's `non_fast_forward` has no
`OrganizationAdmin` bypass: set `enforcement` to `evaluate` (or remove the rule) for
the minute the squash takes, then restore the saved `org-ruleset.json` verbatim.
**Prefer the bypass over the edit** — an org ruleset guards every repository in the
org, and an edit that outlives the minute leaves all of them unprotected.

**Delete — `cli-frozen-until-cutover` (expected to 404).** It was never created; #128
dropped it by decision because `file_path_restriction` is a *push* ruleset rule while
that row asked for a *branch* ruleset. The accepted mitigation is the drift check,
which reports rather than prevents:

```bash
gh api repos/wego/wego-ai/rulesets -q '.[] | select(.name=="cli-frozen-until-cutover") | .id'
gh api -X DELETE repos/wego/wego-ai/rulesets/<id>    # nothing to run: no such ruleset

# the drift check that replaced it — must be 0
gh api repos/wego/wego-ai/compare/0e9f6bfe60864e6226decbebdd3e5b7535c7080e...main \
  --jq '[.files[].filename] | map(select(test("^(apps/cli/|packages/release-signing/)"))) | length'
```

---

## Exit state

- Production `cli/next` serves `wego/cli` 1.2.0, signed by `wego/cli`, whose release
  run shows SMOKE 3 executed against predecessor 1.1.0 with `installUrl`
  `https://api.wego.com/install`.
- Production `cli/edge` serves a `1.2.x-edge.<sha>` build from `wego/cli`.
- Production `cli/stable` still serves 1.1.0.
- `wego/cli` `main` is one commit, `feat: the wego CLI, extracted from
  wego/wego-ai@0e9f6bfe60864e6226decbebdd3e5b7535c7080e`, plus what came after.
- `gh api repos/wego/cli/tags --jq length` is 0 before the release; only `v1.2.0`
  exists after it.
- wego-ai has no `release-cli.yml`, `edge-cli.yml` or `ci-cli.yml`; its `main` is
  green and its open PRs are mergeable.
- The rehearsal blob store and the Phase 1 resolver are gone.

---

## 3c — prerequisites, and the two-hop test

3b moves `next` and `edge`. **`stable` moves in 3c**, and that is the move the
1.0.x install base cannot survive unaided. Everything in this section is the
preflight for that sitting (wego/foundations#134). Built in 3p
(wego/foundations#159); read here.

### Why `stable` is different

Every 1.0.0 and 1.0.1 install following `stable` must reach every later release
with nothing but `wego update` — at any time, with no deadline and no reinstall.
Those binaries trust only wego-ai's signing identity. The moment `stable` names a
release signed under wego/cli's, they cannot verify what `stable` points at: they
refuse, fail-closed, and keep refusing. **There is no later fix.** A binary that
cannot verify an update cannot be updated into one that can.

The mechanism is the **legacy bridge pin**: a frozen copy of 1.1.0 — the last
release those binaries can verify — at an immutable tag prefix, served to old
binaries only, while everyone else sees the live ring. Old binaries reach 1.1.0 by
`wego update`; the 1.1.0 they land on names itself `Wego-CLI/1.1.0`, is therefore
no longer pinned, and reaches 1.2.0 and everything after by `wego update` again.
Two hops, both automatic. That is what the test below proves.

### Prerequisite 1 — the pin is live (four curls)

All four must answer as shown before `stable` moves. The first is the pin; the
other three are its scope, and a pin that caught them would break the installer
script or freeze a ring that exists to move.

```bash
# 1. PINNED — an old binary asking stable is answered from the bridge
curl -sI -A 'Bun/1.3.14'     'https://api.wego.com/install?dl=SHA256SUMS.txt&ring=stable' | grep -i '^location:'
#    must name  /cli/cli-v1.1.0/

# 2. NOT PINNED — a binary that names itself
curl -sI -A 'Wego-CLI/1.1.0' 'https://api.wego.com/install?dl=SHA256SUMS.txt&ring=stable' | grep -i '^location:'
#    must name  /cli/stable/

# 3. NOT PINNED — another ring
curl -sI -A 'Bun/1.3.14'     'https://api.wego.com/install?dl=SHA256SUMS.txt&ring=next'   | grep -i '^location:'
#    must name  /cli/next/

# 4. NOT PINNED — the installer script's own read (no agent)
curl -sI                     'https://api.wego.com/install?dl=SHA256SUMS.txt&ring=stable' | grep -i '^location:'
#    must name  /cli/stable/
```

Curl 1 failing means the pin is not on, or the bridge prefix is empty. **Do not
continue**; setting the variables with no bridge behind them 404s every `stable`
1.0.x update check, which is the failure this whole apparatus exists to prevent.
The switch-on order and the two variables are in wego-ai's
`apps/api/docs/runtime-configuration.md`.

### Prerequisite 2 — the promote guard is on `main`

`promote-cli.yml` refuses to move `stable` unless curl 1 above passes. It asks
production the same question, with the same user agent, in the step immediately
before the pointer move, and it has no bypass input — `allow_not_next` does not
reach it either, because a rollback moves `stable` just as surely.

```bash
gh api repos/wego/cli/contents/.github/workflows/promote-cli.yml \
  -H 'Accept: application/vnd.github.raw' | grep -q 'cli/cli-v1.1.0/' && echo "guard present"
```

It refuses today, correctly. It passes from the end of 3a on.

### The two-hop machine test

The one test that exercises the guarantee end to end, on a real machine, rather
than asserting it. Run it on the **kept 1.0.1 install** — the un-upgraded machine
following `stable`, named on wego/foundations#134 and deliberately not updated
since 3p. There is exactly one of these; do not use it for anything else first.

```bash
wego version          # 1.0.1 — the starting point, and the reason this machine was kept

# HOP 1 — the pin hands an old binary the last release it can verify
wego update -y
wego version          # must print 1.1.0

# HOP 2 — the binary now names itself, is no longer pinned, and follows the live ring
wego update -y
wego version          # must print 1.2.0 (or whatever stable serves by then)
```

**Both hops must need no flag, no reinstall and no human step beyond `wego
update`.** That is the whole claim. If hop 1 prints "Already up to date", the pin
is catching a binary that names itself — check curl 2. If hop 2 prints "Already up
to date", the 1.1.0 it landed on does NOT carry the `Wego-CLI/` header
(wego-ai#1915) and is still being pinned to the bridge: that binary is stuck, and
`stable` must not move until a 1.1.0 that sends the header is what the bridge
serves.

### The never-delete rule

> **`cli/cli-v1.1.0/` and `cli-sig/cli-v1.1.0/` in the production store are never
> deleted — by any lane, any issue, any teardown, any cleanup, at any time.**

They are the bridge. Deleting either one strands every 1.0.0 and 1.0.1 install
that has not yet taken hop 1, permanently and unrecoverably — and those installs
are un-countable and un-contactable, so there is no point at which "everyone has
upgraded" becomes checkable. **The guarantee has no deadline, so the bridge has no
end date.**

This rule outranks every teardown list in this file and in wego/foundations#133,
#134 and their successors. A cleanup that proposes to reclaim the prefix is
wrong, not merely early.

`cli-sig/` is named explicitly because it is the easier one to miss: it is a
separate prefix from the downloads it vouches for, and a sweep written against
`cli/` alone would take the record while leaving the bytes — which fails the
update fail-closed, with no clue as to why.

### Rolling `stable` back to `cli-v1.1.0` — which binaries can take it

The recovery this file and wego/foundations#134, #166 name for the whole cutover
is: dispatch wego-ai's `promote-cli.yml` with `tag=cli-v1.1.0` and put `stable`
back on the last pre-cutover release. That path was **broken in v1.2.0 and
v1.2.1** and is fixed from **v1.2.2** (wego/cli#29).

`src/release-signing/identity.ts`'s `RELEASE_TAG_IDENTITY` was ported into this
repository with wego-ai's repo path but **this** repository's tag shape
(`@refs/tags/vX.Y.Z`). wego-ai's release-please sets
`include-component-in-tag: true`, so every release it cut is `cli-vX.Y.Z` and the
rule matched nothing that has ever been published. A binary carrying it, offered
1.1.0's record on `stable`, refuses fail-closed:

```
SHA256SUMS.txt on ring stable is not vouched for: the signed build record names
https://github.com/wego/wego-ai/.github/workflows/release-cli.yml@refs/tags/cli-v1.1.0,
not … - refusing it
```

Exit 6, `EXIT.PERMANENT`, and no reinstall hint on that path.

| Installed version | Rollback of `stable` to `cli-v1.1.0` |
|---|---|
| 1.0.0, 1.0.1 | **Works.** Pinned to the bridge, never reads the live ring. |
| 1.1.0 | **Works.** Signed under the identity it already trusts, and pinned besides. |
| 1.2.0 | **Refuses**, exit 6. Reinstall is the only route. |
| 1.2.1 | **Refuses**, exit 6. Reinstall is the only route. |
| 1.2.2 and later | **Works.** Downgrades to 1.1.0 and follows `stable` from there. |

So a rollback is still the right move, and it still reaches everyone who matters
today: the install base this cutover was built to protect is 1.0.x, which the pin
carries regardless. What it does not reach is anyone who installed 1.2.0 or
1.2.1 directly. There are few of them, they are reachable by hand, and a
reinstall fixes them, so this is a documented gap rather than a blocker.

**Why accepting `cli-v1.1.0` is safe, since the question comes up — and what it
genuinely costs.** The worry is a downgrade loop: a binary takes the bridge,
becomes 1.1.0, sends a proper user agent, is no longer pinned, updates forward,
and oscillates.

**That loop is real.** An earlier version of this section claimed it "settles"
because 1.1.0 is pinned too. It is not. Measured:

```
$ git show cli-v1.1.0:apps/cli/src/update.ts | grep -c user-agent
2
$ git show cli-v1.0.1:apps/cli/src/update.ts | grep -c user-agent
0
```

1.1.0 sends `Wego-CLI/1.1.0`, and it carries `CLI_RELEASE_TAG_IDENTITY` because
**1.1.0 is the relay release**. It is the one version that is neither pre-relay
nor post-cutover: pinned by nothing, trusting both repositories. So an
agent-less build that downgrades onto it does not stop there — 1.1.0 reads the
live `cli/stable`, finds the agent-less build, accepts it, installs it, is
pinned again, and the cycle repeats on every `wego update`.

So accepting `cli-v1.1.0` converts a loud dead end (exit 6, stuck) into a silent
oscillation, for one hypothetical class of build. That trade is only acceptable
because the precondition is unreachable: the loop requires an agent-less build
to be **serving on a ring**, and two independent gates now refuse to put one
there.

| Gate | Where | Refuses before |
|---|---|---|
| `Require this build to be distinguishable from a pre-relay install` | `release-cli.yml`, after the build smoke | the first store write of the run |
| `Require this tag's binary to be distinguishable from a pre-relay install` | `promote-cli.yml`, step 331 | `Advance cli/stable`, step 455 |

Both measure the real user agent of the real compiled binary against the pin's
own predicate. The identity fix is what makes a **rollback** work; these gates,
not the identity fix, are what keep the loop out of reach.
