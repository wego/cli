# Periodic security sweep

A monthly, read-only re-verification of the security state that the
[`wego/cli` security audit](https://github.com/wego/foundations/issues/221) established.
Every command here is a `GET`. Nothing in this document changes anything.

`.github/workflows/security-sweep.yml` opens an issue holding this checklist on the 1st
of each month. It runs none of the checks and cannot: every one of them reads an
org-admin or repo-admin scoped endpoint, and a workflow's `GITHUB_TOKEN` has no
`administration` permission key to grant. A human runs the checklist; the closed issue,
with the output pasted in, is the record.

**That record is the deliverable.** The organisation has no audit log (`ORG-7`), so
nothing otherwise captures who changed a secret, a ruleset, an environment or a team, or
when. This is not hypothetical: the `cli-release-signers` team read four members minutes
after creation and three again afterwards, and neither change can be attributed to
anyone. A closed issue thread is timestamped, attributable, searchable and durable,
which is more than a green check leaves behind.

## Before you start

You need `gh` authenticated as a human. Check what you can reach:

```bash
gh auth status
```

Two roles are needed, and most people hold only one.

| § | Check | Role needed |
| --- | --- | --- |
| 1 | Org secret and variable visibility | **org admin** (`admin:org`) |
| 2 | `cli-release-signers` membership | org member (`read:org`) |
| 3 | Org ruleset `14768298` bypass actors | **org admin** (`admin:org`) |
| 4 | Repo rulesets `22870024`, `23749783` | **repo admin** |
| 5 | Org App installations | **org admin** (`admin:org`) |
| 6 | Repo security state | **repo admin** |
| 7 | Unverified commits on `main` | repo read |
| 8 | SBOM package count | repo read |

If you hold only one role, **run your half and say so in a comment on the sweep issue.**
A half-run sweep that is recorded as half-run is useful. A half-run sweep that reads as
complete is worse than none, because it retires the question.

An `admin:org`-scoped section fails in two distinguishable ways, and the difference
matters:

- **HTTP 403** — you are authenticated but not an org admin. Expected if you hold only
  repo admin.
- **HTTP 404** — GitHub's standard response for org-admin endpoints when the *token* has
  no `admin:org` scope, even for an org admin. If you are an org admin and see 404, run
  `gh auth refresh -h github.com -s admin:org` and try again. **Do not read a 404 here as
  "the thing does not exist."** Correction 9 on the board is exactly this mistake.

Baselines below were measured on **2026-09-21** against `main` @ `b5aac93`. When a value
legitimately changes, update it here in the same PR that explains why.

---

## 1. `ORG-3` regression — no org secret or variable is visible to all repos

**Role: org admin.** `ORG-3` is closed: org secrets no longer reach public repos. It was
fixed at the org level rather than by excluding this repo, which is the better fix and
also the more fragile one — a single new secret created with the default visibility
reopens it for **every public repo in the org**, silently and immediately.

```bash
gh api orgs/wego/actions/secrets  --jq '.secrets[]   | select(.visibility == "all") | .name'
gh api orgs/wego/actions/variables --jq '.variables[] | select(.visibility == "all") | .name'
```

**Expected:** both commands print nothing.

**If either prints a name:** `ORG-3` has regressed and that named secret or variable is
readable by any workflow in any public org repo, including this one, including from a
pull request. Treat it as exposed rather than as at-risk — you cannot tell from here
whether it has already been read, because there is no audit log. Get its visibility
changed to `selected` or `private`, then rotate it.

Also record the full list, not only the violations, so the next sweep has something to
diff against:

```bash
gh api orgs/wego/actions/secrets   --jq '.secrets[]   | "\(.name)\t\(.visibility)"'
gh api orgs/wego/actions/variables --jq '.variables[] | "\(.name)\t\(.visibility)"'
```

---

## 2. `cli-release-signers` membership

**Role: org member.** This team is a bypass actor on the `v-tags` ruleset (§4), so its
membership is exactly the set of people who can create or move a `v*` tag — which is to
say, who can ship a release.

```bash
gh api orgs/wego/teams/cli-release-signers/members --jq '.[].login' | sort
```

**Expected — exactly these three, no more and no fewer:**

```
chuyeowego
sunny-wego
yeouchien-wego
```

**If a name is added:** someone gained release-signing authority. There is no audit log,
so the API cannot tell you who added them or when — ask the team directly, and record the
answer in the sweep issue, because that comment becomes the only record of it. This has
already happened once: the team read four members minutes after creation, then three
again, and neither change is attributable.

**If a name is missing:** a signer lost the ability to sign, and the release lane has
fewer people than `PROMOTERS` and `CODEOWNERS` assume. `workflow-lanes.test.ts` asserts
`PROMOTERS` equals the CODEOWNERS owner set, but nothing asserts either against this
team's live membership — that comparison only happens here.

---

## 3. Org ruleset `14768298` — bypass actors

**Role: org admin.** This is the org-wide default-branch ruleset that applies to
`wego/cli`. Read it from the **org** endpoint:

```bash
gh api orgs/wego/rulesets/14768298 \
  --jq '{name, target, enforcement,
         bypass: [.bypass_actors[] | {actor_id, actor_type, bypass_mode}]}'
```

**Do not use `gh api repos/wego/cli/rulesets/14768298`.** It returns the ruleset — with
`"source_type": "Organization"` — and reports `"bypass_actors": []` regardless of what
the org ruleset actually grants. It is a successful `200` that answers a different
question, and reading it as "no bypass actors" is correction 1 on the board.

**Expected:** the bypass set recorded at the previous sweep. At the 2026-09-21 audit it
included `wego-plugin-publisher` (**app id `4800587`**) with `bypass_mode: always` — an
org-wide bypass granted for a job that pushes to the skills store, i.e. a one-repo need
scoped org-wide. `ORG-4` tracks narrowing it; until that lands it is the expected value,
not a finding.

**If an actor is added:** that identity can push directly to `main` on every repo the org
ruleset covers, this one included. An `Integration` actor added here is the highest-value
change on this entire checklist — it is a bypass of the default-branch protection for
every repo at once.

**If `enforcement` is no longer `active`:** the ruleset is present and doing nothing. This
is failure mode 2 from the board — correct but inert — and it looks identical to healthy
from every view except this field.

**Note on `actor_id`:** for `actor_type: "Integration"` this is the **app id**, not the
installation id. Resolving it as an installation id produces a confident, wrong answer
about which App holds the bypass; that is correction 2 on the board, and it parked a
fixable repo change behind an org conversation for three days.

---

## 4. Repo rulesets `22870024` and `23749783`

**Role: repo admin.**

```bash
gh api repos/wego/cli/rulesets/22870024 \
  --jq '{id, name, target, enforcement, bypass_actors, conditions, rules: [.rules[].type]}'
gh api repos/wego/cli/rulesets/23749783 \
  --jq '{id, name, target, enforcement, bypass_actors, conditions, rules: [.rules[].type]}'
```

**Expected — `22870024`, `v-tags`:**

- `target: "tag"`, `enforcement: "active"`
- `conditions.ref_name.include: ["refs/tags/v*"]`, `exclude: []`
- `rules: ["creation", "update", "deletion"]`
- `bypass_actors`: exactly two —
  - `{actor_id: 4905398, actor_type: "Integration", bypass_mode: "always"}` (release-please)
  - `{actor_id: 19618049, actor_type: "Team", bypass_mode: "always"}` (`cli-release-signers`)

This is `REPO-13` as fixed: `OrganizationAdmin` was replaced by the signers team, taking
the set who can ship a release from 8 org owners + 1 automation account + release-please
down to release-please + 3 signers.

**If `OrganizationAdmin` reappears in `bypass_actors`:** `REPO-13` has regressed and every
org owner can create or move a `v*` tag again — which is to say, publish a release.

**If the `Team` actor's `actor_id` changes:** a *different* team now gates releases. Check
it against `cli-release-signers` rather than assuming, and re-run §2 against whichever
team it now names.

**Expected — `23749783`, `cli-main-history-integrity`:**

- `target: "branch"`, `enforcement: "active"`
- `conditions.ref_name.include: ["~DEFAULT_BRANCH"]`, `exclude: []`
- `rules: ["non_fast_forward", "deletion", "required_signatures"]`
- `bypass_actors: []` — empty, and it must stay empty

**If `bypass_actors` is non-empty:** `main` can be force-pushed or deleted by whoever was
added, and the signed-commit requirement no longer binds them. `bypass_actors: []` is the
whole of `REPO-1`'s closed half; anything in that array reopens it.

**If `required_signatures` leaves `rules`:** `REPO-5` has regressed. Note that this is the
*only* place the signed-commit requirement is visible — see §6.

---

## 5. Org App installations

**Role: org admin.**

```bash
gh api orgs/wego/installations --paginate \
  --jq '.installations[]
        | select(.permissions.administration == "write"
              or .permissions.workflows == "write")
        | "\(.app_id)\t\(.app_slug)\t\(.repository_selection)\tadmin=\(.permissions.administration // "-")\tworkflows=\(.permissions.workflows // "-")"'
```

**Compare `.app_id`, not `.id`.** `.id` is the installation id and changes when an App is
uninstalled and reinstalled — the same App reads as new, and a genuinely new App reads as
familiar if you happen to be matching on the wrong field. This is correction 2 again.

**Expected:** the set recorded at the previous sweep. At the 2026-09-21 audit,
`datadog-official` held `administration: write` at `repository_selection: all`, and 13
apps held `workflows: write`, two of them org-wide. `ORG-4` tracks these; they are the
expected value until it lands.

**If a new `app_id` appears with `administration: write` and `repository_selection: all`:**
that App can change repository settings — including rulesets and branch protection — on
every repo in the org. Find out who installed it and why, and record the answer in the
sweep issue; the API will not tell you, and nothing else will either.

**If a new `app_id` appears with `workflows: write` at `repository_selection: all`:** that
App can modify workflow files org-wide, which is code execution on every runner in the
org, including the job here that holds `id-token: write`.

Monthly rather than quarterly is mostly about this section. An App is installed in
seconds and a quarter is a long time for one to hold `administration: write` unnoticed.

---

## 6. Repo security state

**Role: repo admin.**

### Private vulnerability reporting

```bash
gh api repos/wego/cli/private-vulnerability-reporting
```

**Expected as of 2026-09-21:** `{"enabled": false}` — `REPO-6` is open. When `REPO-6`
lands this becomes `{"enabled": true}` and **`true` is the expected value from then on**;
update this line in that PR.

**If it flips from `true` back to `false`:** the private intake channel is gone, and with
it the temporary private fork — the only mechanism here that lets a vulnerability be
fixed out of public view. `main` is public and `edge-cli` publishes on every merge, so a
fix made in the open is disclosed by its own diff before the fixed binary reaches anyone.

### Required signatures

```bash
gh api repos/wego/cli/branches/main/protection/required_signatures
```

**Expected:** `{"enabled": false}` — and this is **not** a finding.

Signed commits on `main` are required, but by the *ruleset* `cli-main-history-integrity`
(§4), not by classic branch protection. This endpoint only reports the classic setting,
so it answers `false` while the requirement is fully in force. §4's `rules` array is the
authoritative read; this endpoint is listed here only so that seeing `false` elsewhere
does not get mistaken for a regression. Reading it as the answer is the same shape of
error as correction 1 — a successful response to a different question.

### Environments

```bash
gh api repos/wego/cli/environments --jq '.environments[].name' | sort
```

**Expected as of 2026-09-21 — six:**

```
edge
production
release
release-please
stable-promote
stable-rollback
```

Four of these are the lane environments (`edge`, `release`, `stable-promote`,
`stable-rollback`), `release-please` belongs to the release bot, and `production` is
**pending deletion** under `REPO-7` once `release`→`announce` has been exercised on a real
tag. When it goes, this list becomes five — expected, not a finding.

**If a lane environment disappears:** the job that named it no longer runs under an
environment, so whatever protection rules it carried are not applied. The workflow still
passes. This is the sign/publish privilege separation `REPO-7` exists to hold, and losing
it is invisible from the run log.

**If an environment is added:** find out which workflow references it and whether it
carries protection rules, or it is an environment in name only.

---

## 7. Unverified commits on `main`

**Role: repo read.**

```bash
gh api repos/wego/cli/commits --paginate \
  --jq '.[] | select(.commit.verification.verified == false) | "\(.sha[0:8]) \(.commit.author.date) \(.commit.author.name) \(.commit.message | split("\n")[0])"'
```

**`--paginate` is required.** Without it you get the first page — 30 commits — and a clean
first page says nothing about the history behind it. A first signature check read 20
commits and called the history clean; `--paginate` found 19 unverified behind them. That
is correction 4 on the board, and it was then *reproduced* in `CONTRIBUTING.md`, in the
document about checking signatures, which is correction 7. Do not drop the flag.

**Expected as of 2026-09-21:** **19** unverified commits out of **119** total, all of them
predating `REPO-5` (signed commits required on `main`). The count of unverified commits
should stay at 19 and never rise.

```bash
# the two numbers, for pasting into the issue
gh api repos/wego/cli/commits --paginate --jq '.[] | select(.commit.verification.verified == false) | .sha' | wc -l
gh api repos/wego/cli/commits --paginate --jq '.[].sha' | wc -l
```

**If the unverified count has risen:** an unsigned commit reached `main` despite the
ruleset. Either something bypassed it — check §4's `bypass_actors` is still `[]` — or the
commit was created through the Contents API, which produces a commit carrying no
signature (correction 6). Identify the commit from the listing above and establish which.

---

## 8. SBOM package count

**Role: repo read.** This tracks `REPO-3` rather than guarding anything.

```bash
gh api repos/wego/cli/dependency-graph/sbom --jq '.sbom.packages | length'
grep -c '^"' bun.lock   # rough count of resolved packages in the lockfile
```

**Expected as of 2026-09-21:** **17** packages from the dependency graph, against roughly
**100** resolved in `bun.lock`. The board recorded 16 at the start of the audit; it is
already 17.

The gap is the finding. Dependabot alerts cover only what the graph sees, so the
difference between these two numbers is the portion of the tree that is watched by
nothing. `REPO-3`'s remaining half is the Actions dependencies — `actions/cache`,
`oven-sh/setup-bun` and `sigstore/cosign-installer`, the last of which runs in the only
job holding `id-token: write`.

**This number should move when `REPO-3`'s Actions gap closes.** That is the point of
tracking it: if the `github-actions` block lands in `.github/dependabot.yml` and this
count does not move, the fix did not take — a config that parses and does nothing, which
is failure mode 2 on the board. A number that does not move when it was supposed to is
the cheapest available evidence of that.

**If it falls sharply:** the graph has lost visibility it previously had. Check that
`bun.lock` still parses and that dependency graph is still enabled on the repo.

---

## Closing the issue

Paste the output of each section you ran into the issue, say which sections you did
**not** run and why, and close it. If everything matched, say so explicitly — "no
differences in §§1–8" is the record, and an issue closed with no comment is not.

If anything differed, open a separate issue for it and link it from the thread before
closing. The sweep issue records that the sweep happened; it is not the place to track
the fix.
