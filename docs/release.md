# Releasing the `wego` CLI

How a release, an edge build, a promote and a rollback actually happen in this
repository, what every value in the four lane environments is for, and how to
check a signed build record by hand.

Two rules shape everything below:

- **A promote moves a pointer over the same bytes.** `cli/next` and `cli/stable`
  are byte-identical by construction. Nothing is ever rebuilt to promote it.
- **`wego update` follows bytes, not version numbers.** It compares the hash it
  has against the hash the ring serves. There is no version ordering anywhere, so
  a rollback reaches every install exactly the way an upgrade does.

---

## The three rings

| Ring | Version shape | Who reads it | Written by |
|---|---|---|---|
| `cli/edge` | `X.Y.Z-edge.<sha>` | Dogfooders | `edge-cli.yml`, every push to `main` |
| `cli/next` | plain `X.Y.Z` | Release candidates. The staging API serves this ring | `release-cli.yml`, on a `v*` tag |
| `cli/stable` | plain `X.Y.Z`, same bytes as `next` | Everyone. The default for `/install` | `promote-cli.yml`, human-dispatched |

Each ring is a pointer. Every published version also lives forever at an
immutable `cli/<tag>/` prefix, with its signed record at `cli-sig/<tag>/` –
a separate prefix on purpose, so the write that serves a download cannot also
replace the record that vouches for it.

No ring name is compiled into the binary. The binary bakes only the store
**origin**, and composes the ring at run time from the ring recorded in its own
install. A baked pointer is wrong on one side of every promote.

---

## A release

Releasing is **two human actions**, and neither of them types a version.

### 1. Merge the release pull request

`release-please.yml` keeps exactly one release PR open against `main`. Merging it
is the release: it computes the version from the conventional-commit history,
writes `CHANGELOG.md`, and cuts the tag `vX.Y.Z`.

No workflow in this repository accepts a typed version, and `release-cli.yml` has
no manual-dispatch entry. The only way to a release is the tag, and the only way
to the tag is that merge.

### 2. `release-cli.yml`, on the tag

Fires on `push: tags: ['v*']`. Ten jobs:

| Job | Runner | What it is for |
|---|---|---|
| `prepare` | ubuntu | Refuses a tag that is not on `main`, then lint, format, typecheck and unit tests |
| `build` | ubuntu | One job, not a matrix: `bun build --compile` cross-compiles all five targets in it. **No `environment:`**, deliberately, so it cannot reach the store token |
| `integration (<target>)` | one per target | The integration tier (`integration/`) against the binary `build` produced for that target, on that target's own runner: linux x64 and arm64, macOS arm64 and Intel, Windows. `release` **needs** all five, so a binary that fails its scenarios is never published |
| `sign` | ubuntu | Signs `SHA256SUMS.txt` with keyless cosign. **No `environment:`** either. The job that can sign cannot write the store, and the job that writes the store cannot sign |
| `leave-macos` | macOS | Runs the pre-publication checks against `wego-darwin-arm64`. `release` **needs** it, so darwin gates publication rather than reporting after it |
| `release` | ubuntu | `environment: release`, `concurrency: group: ring-next` with `cancel-in-progress: false`, because a cancel mid-copy is a half-moved ring. The only job that advances a ring. **`contents: read`** – it holds the store token, so it must not also hold repository write |
| `announce` | ubuntu | Creates the GitHub Release and attaches `SHA256SUMS.txt`. **`contents: write` and no `environment:`** – the mirror image of `release`, and the reason the two are separate jobs |
| `replace-macos` | macOS | The darwin half of the post-pointer replace proof. `needs: release`, because the checks in it read the ring |
| `notify-verify` | ubuntu | Asks wego-ai to smoke and evaluate this release against staging. `id-token: write` and nothing else: no `environment:`, no secret, no variable. See [The next report](#the-next-report) |
| `next-report` | ubuntu | Waits for wego-ai's answer and writes it at the top of this run's summary. `checks: read` and `contents: read`; `continue-on-error`, so it never turns the run red |

`id-token: write` is granted to exactly three jobs in two files: `sign` in
`edge-cli.yml`, and `sign` and `notify-verify` here.
`scripts/workflow-shape.test.ts` names that set and fails on any other job
holding it, at any level, in any workflow file.

The commit-point order inside `release` matters and is fixed: **binaries and the
`COMMIT` sidecar first, then the record, then `SHA256SUMS.txt`, then a
consistency barrier, and `VERSION` last.** A reader that sees the new `VERSION`
is guaranteed to find everything it names.

#### Two composite actions, one definition each

Every per-platform check lives in a composite action rather than inline. Two jobs
cannot share steps, so reaching a second runner used to mean copying the checks,
and the copies differed:

- **`.github/actions/verify-build`** – the four checks that run **before**
  anything is published. `release` runs it for `wego-linux-x64`, `leave-macos`
  for `wego-darwin-arm64`.
- **`.github/actions/verify-replace`** – the arrive-and-leave proof, run **after**
  `cli/next` moves. `release` runs it for `wego-linux-x64`, `replace-macos` for
  `wego-darwin-arm64`.

#### Gates, in the order a run meets them

`prepare` refuses a tag whose commit is not on `main` before anything is built.

Then, per platform, **before a single byte is published** (`verify-build`):

| Gate | What it refuses |
|---|---|
| Verify against the signed manifest | Bytes that changed on the way through an artifact hop. Verify-then-execute is the lane's rule: a binary is checked against the manifest before it is run |
| Build smoke | A binary that does not run |
| **Distinguishable from a pre-relay install** | A build whose update path sends no user agent. Runs the freshly compiled binary against a loopback listener and fails **before the run's first store write** |
| **Able to update itself for real** | A build that cannot replace itself. Installs whatever `cli/stable` currently serves over the new binary, using the new binary's own code. Also refuses a build that did not bake its version, which would make `update` exit OK having done nothing, and refuses the case where `stable` already serves this version, because then no byte swap happens and the gate would prove nothing |

Then, in `release`, around the publish itself:

| Gate | What it refuses |
|---|---|
| Publish immutable `cli/<tag>/` | `allowOverwrite: false`. On "already exists", hashes local against served and fails loud on a mismatch |
| Commit binding | A resume of this tag from a different commit. `bun build --compile` is not reproducible, so mixing two builds under one version is refused outright |
| Verify the prefix, identity gate | A record not signed by an identity `identitiesForRing()` accepts |
| Refuse to move `cli/next` backwards | A tag older than what the ring already serves |

Then, per platform, **after `cli/next` points at the new bytes**
(`verify-replace`):

| Gate | What it refuses |
|---|---|
| Verify the predecessor's checksum | A predecessor that arrived corrupt, which would fail the next gate for the wrong reason. Skipped when there is no usable predecessor |
| SMOKE 3 | The predecessor on `cli/next` failing to self-update onto these bytes. Skipped on a channel's first release, or when the predecessor published no objects |
| SMOKE 4 | The binary this run built failing to update itself against its own ring. Expects "already up to date", asserted, because `cli/next` now serves exactly these bytes |
| SMOKE 5 | A forced in-place replace failing when driven by **this build's own** replace code. This is the leg no Linux runner substitutes for: macOS has a quarantine-clear branch nothing else executes |
| 1.1.0 upgrade path | A 1.1.0 install failing to reach this release. 1.1.0 is the hinge, and it is pinned rather than derived: the legacy bridge lands every 1.0.x machine on the frozen `cli/cli-v1.1.0/` prefix first, so if a 1.1.0 binary cannot take this release, every install at or below it is stranded. SMOKE 3's coverage erodes as versions accumulate, since the predecessor moves forward with every release and nobody is one version behind. This one does not |
| SMOKE 6 | An install script that writes where this build does not read. The only gate that installs for real; SMOKES 3 to 5 hand-place a binary and arrange its record |

SMOKE 3 and the 1.1.0 path prove machines can *arrive* at this version. SMOKE 4
and 5 prove one can *leave* it. That half exists because a release once shipped a
binary that could never update again while every other check passed (wego/cli#25):
a rollback does not reach a machine whose binary cannot take one.

---

## The next report

Every gate above is about the artifact, and the integration tier is about the
binary against the API's contract. None of them runs the binary against a real
backend, because hosted runners cannot reach one and there is no production login
for CI. That run happens in wego-ai, against staging, and its answer comes back
into the release run before anyone promotes.

It **reports; it never blocks.** Promoting is a person's decision, made after
reading it.

### How it works

1. Once `cli/next` serves the new tag, `notify-verify` posts `{"tag", "sha"}` to
   `https://api.wego.com/.well-known/internal/cli-verify` with this run's GitHub OIDC token
   (audience `wego-cli-verify`).
2. The receiver accepts exactly one identity: a `push` of `refs/tags/<tag>` from
   `wego/cli/.github/workflows/release-cli.yml@refs/tags/<tag>`, with the body's
   `sha`. Anything else is a `400`, `401` or `403`. It then starts wego-ai's
   `cli-next-smoke.yml` for that tag.
3. That workflow writes two check runs on the tag's commit, as the gate App (id
   `4987365`, `checks: write` on this repository only):
   - **`cli-next-smoke`**: it installs the published binary after verifying its
     signed record, smokes it against staging, and completes the check with a
     verdict. Minutes.
   - **`cli-next-evals`**: then, if the smoke passed, the skill evals on the tag's
     skill and binary, against the previous version's scores. Up to hours. Which
     sets run depends on what changed since the last evaluated release (below).
4. `next-report` waits for the smoke check, up to 45 minutes, logging every look,
   and writes its verdict at the top of this run's summary, with one line on
   where the evals are. The promote banner shows both.

**This repository holds no credential for any of it, and no setting.** The OIDC
token is signed by GitHub; nothing here can write a check or widen what the
receiver allows. The eval material (cases, scores, transcripts) never leaves
wego-ai; the check carries only the verdict and a part table.

`notify-verify` reads the receiver's answer by status:

| Status | Means | The job |
|---|---|---|
| `202` | Started | passes |
| `409` | A retry replayed a token the receiver had already spent, so the first attempt started it | passes, with a notice |
| `404` | The receiver is switched off | passes, with a notice: **this release was not verified** |
| anything else | Refused | **fails**. Nothing depends on it, the release is already published, but a refused request is a broken pipeline and should be loud |

### Reading it

The verdict comes first, then only what changed against the previous release.
The smoke (`cli-next-smoke`):

| Verdict | Check conclusion | Means |
|---|---|---|
| **✓ Ready** | `success` | Every part matched or improved on the previous version |
| **⚠ Look first** | `neutral` | Something changed past its threshold: a search round trip was not reached twice in a row, or startup is noticeably slower |
| **✗ Staging problem** | `failure` | A must-pass step failed and staging's own health check was failing too: probably not this release |
| **✗ Binary problem** | `failure` | A must-pass step failed while staging was healthy, or the binary is not the tag |
| **● No report** | none | The receiver is switched off, the request was refused, or wego-ai did not start within 10 minutes |
| **● No report yet** | `in_progress` | Still running after 45 minutes; the promote banner shows it once it arrives |

The skill evals (`cli-next-evals`), one line under the smoke's verdict:

| Line | Check conclusion | Means |
|---|---|---|
| **Skill evals: ✓ Ready** | `success` | Every set that ran held against its baseline |
| **Skill evals: ⚠ Look first** | `neutral` | A set scored lower than its baseline: read the private report before promoting |
| **Skill evals: ● Skipped** | `skipped` | Nothing the evals measure changed, or they were turned off for this run; the reason is in the line |
| **● Skill evals: running** / **not started yet** | `in_progress` / none | Still going; the promote banner shows the result once it lands |

Only a check written by the gate App is read. `cli-next-smoke` is a name, and
anything that can write checks on this repository could use it. The check's link
points at the private wego-ai run, which org members can open.

What the smoke runs: the install with its signed record; that the binary is the
tag (its version, the commit its signed build record names, and the embedded skill equal to the tag's
`skills/wego/SKILL.md`); `whoami`, `places` and the four `info` commands; three
real error responses; flights and hotels round trips to a booking link, judged
tolerantly because staging's inventory varies; and timings, report-only.

Which evals run is wego-ai's decision, from what changed since the last release
that was evaluated:

| The release changed | Frozen regression set | Persona subset |
|---|---|---|
| `skills/` | runs | runs |
| any command's `--help` text | runs | runs |
| other `src/` | runs | skipped |
| neither (docs, CI, tests) | skipped | skipped |

A skipped set says so in the report, with the reason and the version its baseline
comes from. wego-ai's workflow can force a full run or none.

### Asking again

Re-run the **`notify-verify`** job alone, then **`next-report`**. Nothing else
depends on either, so nothing is re-published, and the receiver accepts the re-run:
same workflow, same tag, a fresh token. GitHub allows re-runs for 30 days.

---

## An edge build

`edge-cli.yml` runs on every push to `main` — and on nothing else. It has no
`workflow_dispatch`: its `publish` job holds `BLOB_READ_WRITE_TOKEN`, and a
dispatch trigger let any collaborator start a job holding the store token on
demand. An allow-list would be the wrong shape for a lane that must publish
unattended on every qualifying merge, so the trigger is gone instead; a failed
publish is re-run with GitHub's re-run button on the push run.

Version is `package.json` plus
`-edge.<sha>`, shallow checkout, `concurrency: group: ring-edge`,
`environment: edge`. It uses the same publisher as the release lane:
`--freeze` to write the immutable prefix, then a separate `--promote --to edge`.

Edge carries its own signing identity, distinct from the release one.

---

## A promote

`promote-cli.yml`, `workflow_dispatch` only. One input: `tag`.

It has no rollback mode. A promote only ever advances `cli/stable` onto what
`cli/next` serves, so every gate below may assume `next == tag` unconditionally.
Putting `stable` back on an earlier release is `rollback-cli.yml`.

Three jobs. The first, **`next-report`**, only reads: it prints the tag's next
report as a banner at the top of the run (`checks: read`, `continue-on-error`,
needed by nothing), so the verdict is in front of whoever approves. It gates
nothing.

**`approve`** holds no secrets and no variables, and `promote` cannot begin until
it passes. It refuses unless *both* the dispatcher and whoever started this
particular run are named promoters. The list lives in
`.github/workflows/promote-cli.yml` and that file is the authority; at the time
of writing it is `sunny-wego`, `yeouchien-wego`, `chuyeowego`.

**Why two actors and not one.** Re-running an existing workflow run needs only
write access, and on a re-run GitHub still reports the *original* dispatcher in
`github.actor` — only `github.triggering_actor` names the person who pressed the
button. A gate reading `github.actor` alone therefore passes a replay on the
original promoter's name, which means anyone with write access could re-run a
past promote and re-publish that run's `inputs.tag`. Idempotent on the day it was
dispatched; a downgrade once `cli/stable` has advanced past it. So the check
covers both, and names which of the two failed. Checking only the re-runner would
be no better — it would drop the guarantee about who chose the tag in the first
place.

**Who may change it:** anyone opening a pull request, but `main` requires a
code-owner review, so widening the list is always a reviewed change. That is the
whole reason an allow-list in a file is meaningful here.

**What this gives up:** four eyes. With environment reviewers the dispatcher and
the approver had to be different people. Here one person is both. Restoring that
needs GitHub Enterprise (wego/foundations#128).

**Why not just add environment reviewers, then.** It was tried, and reverted. The
threat model here is scoped to *external* attackers – a malicious insider, or an
org member acting inside their access, is explicitly out of scope. Under that
scope reviewers on the promote lane block one of two credential-theft paths
(advancing `stable`) and leave the other wide open: rolling `stable` back onto a
known-vulnerable release through the rollback lane, which has to stay fast for
incident response. Paying a human round-trip for half a door is not worth it.

They also could not be confined to the lane they were meant for. Protection rules
attach to the *environment*, not the job, so while all four lanes shared
`production` the reviewers silently gated the edge publish – which runs on every
qualifying merge – and the break-glass rollback along with it. **No environment in
this repository has required reviewers**, and the `approve` allow-list above is
the gate. It is also the only one of the two that can express *who may initiate a
dispatch*, which is the actual question; an environment rule can only ask who
approves after the fact.

**`promote`** runs with `environment: stable-promote` and
`concurrency: group: ring-stable`. It copies from the immutable `cli/<tag>/`
prefix, never from `cli/next`, and it never re-signs: the record is copied as it
stands.

Almost everything it checks runs **before** the pointer moves, which is the
design: a failure there costs a re-run, while the same failure after the move
costs a rollback that may not reach the machines it needs to.

Before the move:

| Gate | What it refuses |
|---|---|
| Validate the tag | A tag that is not a plain release version |
| Record the rollback target | Nothing, but it reads what `cli/stable` serves **now**, because the move is what destroys that answer. Every failure message after this point names the tag to put back, and the lane it belongs to: `1.0.x` and `1.1.0` are `cli-vX.Y.Z` in wego-ai's lane, `1.2.0` and later are `vX.Y.Z` through `rollback-cli.yml` here |
| Require a completed, successful release run | A tag whose release lane never finished, so `cli/<tag>/` may be half-written |
| Refuse a tag whose tree cannot publish the plugin | A promote that succeeds having silently published nothing. Checked before the ring moves, for that reason |
| Require the legacy bridge pin to be live | Moving `cli/stable` while the pin is down, which strands every 1.0.x install permanently |
| Walk the pre-relay route | The pin *pointing* somewhere without anything being there. The check above reads one header; this one walks the whole 1.0.x route, pin then frozen prefix then live pointer, against the ring as it stands. A collected object or an expired certificate passes the header probe and strands the same installs |
| Distinguishable from a pre-relay install | A tag whose binary sends no user agent, which the pin cannot then tell apart from a 1.0.x install |
| Require the bytes that will land to be the bytes under test | Two things: `cli/next` and `cli/<tag>/` disagreeing, which would make the walks above a test of bytes nobody is about to serve; and a manifest missing a platform. The platform set is pinned here, because `verify-published.sh all` only checksums what the manifest lists, so a build that silently stopped emitting one would produce a shorter manifest and pass every other check |
| Able to update itself for real | A tag whose binary cannot replace itself **against today's live route**. It passed in the release lane, so a failure here means the route or the store changed, not the build |
| Require the install base to be able to reach this tag | A promote that strands the installed population |

After the move: `cli/next` and `cli/stable` must serve byte-identical manifests,
a promoted binary must report itself current, and the install base's route to the
promote is walked again.

Then the plugin publishes to `wego/skills` from the tag's own tree.

---

## A rollback

`rollback-cli.yml`, `workflow_dispatch` only. Inputs: `tag` (required, no
default), `reason` (required), `plan_only`.

```
rollback-cli.yml  with  tag=vX.Y.Z  reason="..."
```

**A separate lane, not a mode on the promote.** It used to be
`promote-cli.yml` with `allow_not_next=true`, an input that promoted a tag
`cli/next` does not serve by *subtracting* the gates which assume it does. That
boolean was the defect: it silently changed the meaning of twenty downstream
steps, so correctness depended on every future gate's author remembering to opt
rollback out. In wego/cli#48 two `cli/next`-coupled gates arrived without the
guard and hard-failed every rollback — silently, because nothing exercises a
rollback until an incident. Splitting the files removes the mode rather than
guarding it, and `scripts/workflow-lanes.test.ts` keeps them apart.

**The same `approve` gate as the promote lane**, for the same reason and with the
same two-actor check: no secrets, no variables, and `rollback` cannot begin until
it passes. The re-runner half matters more here than anywhere. A replayed
rollback is not a no-op — it moves `cli/stable` back onto that run's `inputs.tag`
a second time, and since `SECURITY.md` supports only what `cli/stable` serves and
`wego update` compares checksums rather than versions, the whole install base
follows it down to an older release on its next update.

**The posture is inverted from a promote, deliberately.** A promote is
fail-closed because a blocked run costs a re-run. A blocked rollback costs
continued exposure to a build already known to be bad. So there are two blocking
checks and everything else runs after the pointer moves:

| Step | Blocks | Why |
|---|---|---|
| Validate the tag | yes | The only thing a human can get wrong now that there is no default |
| Record what `cli/stable` serves today | no | The build being rolled back *from*. Only the rescue check needs it, so a store that will not answer must not block the fix |
| Require the rollback target to be intact | yes | The one thing the target's own history cannot vouch for: that its frozen prefix survived, complete, with every platform. A missing asset strands that platform on a download that 404s |
| **Move `cli/stable`** | — | `upload-release-blob.ts --promote <tag> --to stable`, no `--require-serving`. Every install is on the old bytes from here |
| Can machines on the bad build reach this rollback | no | The question nothing else in the repo asks — see below |
| Verify `cli/stable` | no | Every asset hash-checked against the manifest just committed |

**About half a minute from dispatch to every install being served the old bytes**,
against 5–15 minutes for a promote. Measured on a real `plan_only` rehearsal: 21s
to run every check and stop before the move, of which the checks themselves are a
few seconds — the rest is runner provisioning, checkout and `bun install`. The move
adds ~5s. Only the move genuinely needs bun, so that tail is trimmable if it ever
matters.

**The promote battery is not repeated.** A rollback target is bytes that already
served `cli/stable` — stronger evidence than any gate can manufacture, since it
shipped to the whole install base and survived. Re-running those gates can only
produce false negatives, and it buys exposure minutes with its own runtime.

**The rescue check is the point.** The promote lane's install-base walks drive
1.1.0 and 1.0.1 — the *old* population. The population a rollback exists to
rescue is the one already on the build being rolled back from, and nothing else
asks whether it can get off. If it passes, every affected machine self-heals on
its next `wego update`. If it fails, the rollback protected everyone who had not
yet updated and nobody who had, and those machines need a manual reinstall — a
binary that cannot take an update cannot take the fix either. Two very different
incidents, and you want to know which within minutes.

**No legacy bridge pin gate**, unlike a promote. A 1.0.x machine never reads this
pointer — the pin serves it the frozen prefix whatever `stable` names — so a
rollback can neither strand those installs nor rescue them. Blocking one on a
pre-existing condition it cannot affect would only extend the outage.

**No plugin publish.** The SKILL.md ships embedded in the binary and `update`
re-runs the freshly swapped binary's own `skill install --owned-only`, so a
machine taking the rollback gets that release's skills automatically.
`wego/skills` serves third-party discovery, which never follows `cli/stable`; it
sits one version ahead until the next forward promote resynchronises it.

**It checks out `main`, not the tag** — the opposite of a promote, which needs
the tag's tree for the plugin publisher. With nothing to read from the tag, a
rollback runs *today's* scripts rather than whatever they looked like at a tag
cut months ago.

**`plan_only` runs every check and stops before the move.** Nothing is written.
This is how you rehearse the lane outside an incident, and the absence of any way
to do that is why #48's breakage went unnoticed.

**The target is whatever `cli/stable` served before the promote you are undoing**,
and the lane that owns it follows from the version, because the tag grammar
changed at the relay: wego-ai published `cli-vX.Y.Z` up to 1.1.0, this repository
publishes `vX.Y.Z` from 1.2.0 on. A promote run records both in its own failure
messages, so read them rather than guessing. There is no universal floor to roll
back to: a pre-relay 1.0.x machine never reads this pointer at all.

There is also a manual path for moving `cli/next` itself, run against the
publisher rather than through a lane:

```
bun scripts/upload-release-blob.ts --promote <tag> --to next
```

`--freeze` and `--promote` take the tag from argv only, never from an
environment fallback, and `--to` is promote-only. A misplaced flag errors rather
than quietly advancing the wrong ring.

Because `wego update` compares hashes and not versions, every install on the
rolled-back ring takes the older bytes on its next check, with no reinstall and
no deadline.

---

## The GitHub "Latest" badge

**`Latest` means what `cli/stable` serves. Everything published above it is
marked pre-release.** `release-badge.yml` maintains that, and nothing else does.

Nothing in the product reads GitHub Releases – install and `wego update` both
follow the rings – so this is a human-facing record only. It is still worth
being correct: it is the first thing a person checks to answer "what is everyone
running?"

| Release | Flag | Why |
|---|---|---|
| Whatever `cli/stable` serves | `prerelease: false`, `make_latest: true` | The build every `wego update` receives |
| Anything published after it | `prerelease: true` | Released and on `cli/next`, not yet promoted |
| Anything published before it | untouched | Historical record; cannot take the badge |

So between a release and its promote, the new version reads **Pre-release** and
the badge stays on the previous one. A promote moves it up; a rollback moves it
back down and re-marks what it passed.

### Why it is a reconciler

GitHub awards `Latest` to a release **at birth** – `make_latest` "defaults to
`true` for newly published releases" – so every tag release-please cuts takes the
badge before anything is published. On 2026-09-16 that misled for an hour and a
half: v1.3.0 was released at 14:11, its promote failed at 14:28, `cli/stable` was
rolled back to v1.2.7 at 14:30, and GitHub went on advertising v1.3.0 as `Latest`
until v1.3.1 was promoted at 15:49.

The badge is **derived** state – a function of one fact, what `cli/stable`
serves. Writing it from the release, promote and rollback lanes would make it an
obligation every future author of a ring-writing lane has to remember, which is
the shape `allow_not_next` had and how wego/cli#48 broke rollback silently.
Evaluating the function in one place means a new lane that moves `cli/stable` has
nothing to remember.

`release-badge.yml` therefore runs on `release: published`, on `workflow_run`
completion of the three lanes, and on dispatch. It re-reads the ring every time
rather than trusting the event, and it listens for `completed` rather than
`success` – what the badge needs is the ring's value, not the run's verdict.

So a run that left `cli/stable` **unchanged** – a gate that refused before the
move, a `plan_only` rollback rehearsal – is a harmless no-op, with nothing to
special-case. And a run that moved the ring and **then** failed or was cancelled
is reconciled onto the value it actually left behind. That second case is not
hypothetical: it is precisely the v1.3.0 promote above, which advanced the
pointer and went red afterwards.

### What it cannot do

It writes no ring: no `environment:`, no `BLOB_READ_WRITE_TOKEN`, no `id-token`.
A `workflow_run` run's conclusion does not propagate to the run that triggered
it, so it cannot fail, block or delay a release, a promote or a rollback. **Its
concurrency group is its own – never move it onto `ring-stable`**, which would
let a badge update queue behind or block a promote. A total failure of it leaves
the badge stale, which is the state it exists to fix.

It also waits once, past the 60s `cacheControlMaxAge` on the ring's objects, and
re-reads. That closes the only race here that does not repair itself: the promote
lane's settle barrier and this workflow resolve `api.wego.com` independently, so
a read taken the instant a promote completes can still be served the previous
`VERSION` – and the promote has already finished, so it will not trigger a repair.

---

## The four lane environments

There used to be one shared `production` environment, entered by four jobs across
four workflows. No workflow enters it any more. It is **not deleted yet**: it still
exists and still holds a copy of the store token, and it is removed only once the
lanes have been observed running on their own environments. Deleting it also
destroys its deployment history, so that is a one-way step worth taking
deliberately rather than in the same change that stops using it.

Each publishing lane has its **own** environment:

| Environment | Entered by | Deployment branch policy |
|---|---|---|
| `edge` | `edge-cli.yml` → `publish` | `main` branch only |
| `release` | `release-cli.yml` → `release` | `v*` **tags** only |
| `stable-promote` | `promote-cli.yml` → `promote` | `main` branch only |
| `stable-rollback` | `rollback-cli.yml` → `rollback` | `main` branch only |

`release-please` is a fifth environment, unrelated to the rings and already
correctly scoped; it is not part of this layout.

Secrets and variables live at **environment** scope. A job that declares no
`environment:` can read none of it – which is why `build` and `sign` do not
declare one, and must not be given one.

**Why four and not one.** Protection rules attach to the environment, not to the
job that enters it, so one shared environment forced three couplings that should
never have existed:

- Its branch policy had to be the **union** of every lane's needs – `main` *and*
  `v*` – so each lane was reachable from refs it never uses. Each lane now admits
  exactly the one ref it actually runs on.
- Any rule added for one lane applied to all four. This is not hypothetical:
  reviewers added to gate the promote lane silently gated the edge publish, which
  runs on every qualifying merge, and the rollback lane, which is the break-glass
  tool. Both are described above.
- It hid a real failure mode. Every artifact in the edge and release lanes carries
  `retention-days: 1`, so an approval delay past ~24h does not *delay* a publish,
  it **fails** it – the binaries and the signature are already gone.

**Why `stable-promote` and `stable-rollback` are still two**, given both run from
`main` and hold the same token value: the whole point of the split is that a
shared environment couples lanes with different requirements. Promote and rollback
have opposite latency requirements – one is fail-closed and can afford to wait,
the other is what you reach for during an incident. Merging them would rebuild
exactly the coupling this removed.

**A branch policy evaluates the workflow run's ref, not the checkout.** This is the
easiest thing here to get wrong. `promote-cli.yml` checks out `inputs.tag`, but the
*run* is dispatched on `main` – so `stable-promote` is `main`-only, and a `v*`
policy on it would reject every promote. Only `release` is tag-scoped, because only
it is triggered by a tag push.

**What this does not change: the token's capability.** The same
`BLOB_READ_WRITE_TOKEN` value sits in all four environments and still has write
access to the whole store. This is a change to **who can reach the credential and
from which ref** – not to what the credential can do, and not cryptographic
separation of any kind. Do not read it as one.

**It also does not touch signing.** The `sign` jobs hold `id-token: write` and
deliberately carry no environment; the split touched publish-side jobs only. The
identity clients pin is a SAN URI of the form
`https://github.com/<owner>/<repo>/.github/workflows/<file>@<ref>` – repo,
workflow file and ref, with no environment component, so renaming an environment
cannot move it. What *would* move it is renaming a workflow file or converting one
to a reusable workflow. Both files warn about this already.

### Rotating `BLOB_READ_WRITE_TOKEN` is now a four-step operation

The one thing the split costs. The token lives in four places, and a rotation that
updates three of them leaves one lane writing with a revoked credential – which
surfaces as a red run in whichever lane was missed, possibly not for weeks if it is
the rollback one.

```
gh secret set BLOB_READ_WRITE_TOKEN --env edge            --repo wego/cli
gh secret set BLOB_READ_WRITE_TOKEN --env release         --repo wego/cli
gh secret set BLOB_READ_WRITE_TOKEN --env stable-promote  --repo wego/cli
gh secret set BLOB_READ_WRITE_TOKEN --env stable-rollback --repo wego/cli
```

Then confirm all four carry it, before revoking the old value:

```
for e in edge release stable-promote stable-rollback; do
  echo "-- $e"
  gh api "repos/wego/cli/environments/$e/secrets" --jq '[.secrets[].name]'
done
```

### Secrets

| Secret | Lives on | What it is for |
|---|---|---|
| `BLOB_READ_WRITE_TOKEN` | `edge`, `release`, `stable-promote`, `stable-rollback` | Writes the release store. The four publishing jobs only – never `build`, never `sign` |
| `SKILLS_PUBLISH_APP_PRIVATE_KEY` | `stable-promote` | The GitHub App key used to mint a token for publishing the plugin to `wego/skills`. The promote lane is the only one that publishes a plugin, so this is the only environment that carries it |
| `RELEASE_PLEASE_APP_PRIVATE_KEY` | `release-please` | The App key release-please signs its commits and tags with. Using an App, not the default token, is what lets the tag it creates trigger `release-cli.yml` |

### Variables

| Variable | Lives on | What it is for |
|---|---|---|
| `WEGO_API_URL` | repository | The API the built binary talks to. Asserted HTTPS and a production host at build time |
| `WEGO_AUTH_AUTHORIZE_URL` | repository | OAuth authorize endpoint baked into the binary. Same assertions |
| `WEGO_AUTH_TOKEN_URL` | repository | OAuth token endpoint baked into the binary. Same assertions |
| `WEGO_CLI_CLIENT_ID` | repository | The public OAuth client id. The CLI is a public + PKCE client and holds no secret |
| `WEGO_CLI_POSTHOG_PROJECT_KEY` | repository | Write-only analytics key. **Optional**. It belongs at repository scope for the same reason the four above do: the `build` job has no `environment:`, so setting it on an environment bakes an empty value and fails nothing |
| `SKILLS_PUBLISH_ENABLED` | `stable-promote` | Turns the plugin publish on. When on, the promote refuses a tag whose tree cannot publish |
| `SKILLS_PUBLISH_APP_CLIENT_ID` | `stable-promote` | Client id paired with the App key above |
| `RELEASE_PLEASE_APP_ID` | `release-please` | App id paired with the release-please key above |

**Everything the binary bakes in lives at repository scope, not on a lane
environment.** `build` declares no `environment:` – that is the whole point of it –
so it can only see repository-scoped variables, and a value set on an environment
would bake in as empty. The old `production` environment carried duplicate copies
of the four `WEGO_*` values; they were exact duplicates of the repository-scoped
ones and were not carried over, because nothing could read them there anyway.

The two `SKILLS_PUBLISH_*` variables are the only ones that are genuinely
lane-scoped, and they sit on `stable-promote` alone: the promote lane is the only
one that publishes a plugin.

`WEGO_CLI_SKILL_ORIGIN` is still referenced by `release-cli.yml` and **does
nothing**. The skill channel did not move to this repository: the body ships
embedded in the binary, and `readReleaseEnvSpec` bakes no skill address under any
name. `release-config.test.ts` asserts a lingering value is ignored rather than
honoured. Removing the dead reference is tracked as wego/foundations#139.

---

## The signed build record

Every published version carries `SHA256SUMS.txt.sigstore.json` at
`cli-sig/<tag>/`, signed with keyless cosign using the workflow's own OIDC token.

Three things check it, all through the one `src/release-signing` module:

- **The publisher**, before it advances any pointer. It refuses a record that is
  not signed by an accepted identity, and refuses a manifest that does not list
  every object being served.
- **`wego update`**, before it reads a manifest.
- **`api.wego.com`**, before `GET /install?sums=` serves one. The installer is a
  POSIX `sh` script and cannot check a signature itself, so the check happens on
  the host the user named.

### Which identities are accepted

`identitiesForRing(ring)` returns the workflow identities valid for that ring.
`edge` accepts the two edge identities; `next` and `stable` accept the release
ones. `stable` deliberately returns exactly what `next` returns, because a
promote copies the record rather than re-signing it.

Both repositories are trusted during the migration, and that is intentional: a
binary installed before the move must be able to verify a record signed after it.

The identity strings are **never typed**. `scripts/extract-identities.ts`
downloads real published records, reads the SAN out of each leaf certificate with
the same parser the binary uses, and emits the rules. A hand-edit of
`identity.ts` that widens a rule is caught by a pinned test.

### Verifying one by hand

```bash
TAG=v1.2.5
BASE=https://api.wego.com/install

curl -fsSL "$BASE?dl=SHA256SUMS.txt&ring=stable"          -o SHA256SUMS.txt
curl -fsSL "$BASE?dl=SHA256SUMS.txt.sigstore.json&sig=1&ring=stable" -o SHA256SUMS.txt.sigstore.json

cosign verify-blob \
  --bundle SHA256SUMS.txt.sigstore.json \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github\.com/wego/(cli|wego-ai)/\.github/workflows/' \
  SHA256SUMS.txt

sha256sum -c SHA256SUMS.txt --ignore-missing
```

`?sums=1` is the verified branch: the API checks the record before it serves the
manifest. A plain `?dl=` read is not verified, which is why the client verifies
too.

### The Sigstore root caveat

`src/release-signing/sigstore-roots.ts` pins **both** Fulcio public-good
certificates: the self-signed root and the `sigstore-intermediate` that actually
issues leaves. Pinning the intermediate as well is the tighter choice – a leaf is
accepted only under the intermediate we have seen, not under any future one the
root might sign.

They are pinned in the binary rather than fetched, and rather than deferred to a
system trust store, because the whole point of the check is not to depend on
anything an attacker who can write the release store could also reach.

**So rotation is a code change.** When Fulcio rotates, this file is edited from
`https://fulcio.sigstore.dev/api/v1/rootCert` and reviewed like any other change,
and every binary built before that edit keeps the old anchors. The verifier takes
the roots as an argument rather than importing them itself, precisely so this
stays a reviewed data change.

**A weekly lane now watches for that rotation.**
`.github/workflows/fulcio-pin-check.yml` compares the pinned material against
`https://fulcio.sigstore.dev/api/v1/rootCert` every Monday at 07:00 UTC and opens
an issue when they diverge – one issue, not one per firing, because the cron keeps
firing while the pin is stale. It also runs on any pull request touching
`sigstore-roots.ts` or its checker, which is when you most want to know whether the
material being pinned is what Fulcio is actually serving.

It is a schedule rather than a gate in the release lanes on purpose. Proving a
candidate can still verify something signed today would mean driving a real binary
through a real update before the pointer moves: seconds of exposure on the one path
where exposure is what is being minimised, asked one tag at a time, and only ever
during a release. This risk is rare, sudden, and hits the whole install base at
once, which a cheap scheduled check handles well and an expensive per-operation
gate handles badly.

---

## When the API changes

The Wego API ships from another repository on its own cadence, and nothing in a
release lane reads it. What this repository holds is a **vendored copy** of the
published contract at `contract/openapi.json`, fetched from
`https://api.wego.com/openapi`. `src/api-types.d.ts` is generated from that file
by `postinstall`, so it is never committed and never stale relative to the tree.

Refreshing is a person's job, done when the API ships something the CLI needs:

```bash
bun run api-contract:refresh   # fetch production, write the file, regenerate the types, print old and new version
bun run typecheck              # Checks A and C, the compile-time halves
bun test ./src/api-contract.test.ts   # Check B, the runtime walk
```

The refresh chains `api-types:generate`, and only on a successful fetch: the
types on disk were built by `postinstall` from the previous contract, so a
refresh that stopped at the JSON would leave the typecheck comparing against
shapes the API no longer publishes.

Commit the JSON diff on its own. Then fix what the checks report, in a separate
commit. A failing check is a finding about the API: report it, do not widen a
schema to silence it.

**`ci-cli` warns, it does not gate.** Its "Contract drift (warning only)" step
fetches the live document, drops `servers` from both sides and compares. On a
difference it annotates the run with the two versions and the command to run; on
a fetch that does not answer it leaves a notice and passes. It never fails the
job, and `scripts/ci-contract-drift.test.ts` is what keeps that true. A gate
there would block every CLI pull request opened after an unrelated API release.

The warning is a reminder that the vendored copy has fallen behind, nothing
more. It says nothing about whether the released CLI still works: that is settled
at release time, by a separate check that exercises the released CLI against the
live API, whatever this repository has vendored.

---

## Quarterly dependency check

The Fulcio comparison that used to lead this list is automated: see
`fulcio-pin-check.yml` above. What replaces it here is confirming the lane is still
running, because **a scheduled workflow that has stopped firing looks exactly like
one that keeps passing.** GitHub disables scheduled workflows after a long stretch
without repository activity, which is unlikely on an active repository but is the
specific way this particular watchdog dies.

Once a quarter, and always before a release that changes the verifier:

1. Confirm `fulcio-pin-check.yml` has run recently and is green, and that no
   drift issue it opened is sitting unread. When one is open, the rotation is a
   code change: edit the pin, review, release and promote it like any other.
2. Check the pinned `cosign-installer` version in `.github/actions/sign-manifest`
   against upstream releases.
3. Confirm every action in a signing lane is still SHA-pinned.
4. `bun update --dry-run` and read the diff. Nothing in a signing path updates
   without a reason.

---

## Not yet documented here

The `notify` job on `release-cli.yml` does not exist yet; it is built in
wego/foundations#139. This document covers the lanes as they are, and gains that
section when the job lands.

The contract-drift half of that issue is done and documented above. It landed as
a warning-only step inside `ci-cli.yml` rather than a `contract-drift.yml` lane:
a vendored contract with a manual refresh needs a reminder on the check people
already read, not a workflow of its own.
