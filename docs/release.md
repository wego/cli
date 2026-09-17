# Releasing the `wego` CLI

How a release, an edge build, a promote and a rollback actually happen in this
repository, what every value in the `production` environment is for, and how to
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

Fires on `push: tags: ['v*']`. Six jobs:

| Job | Runner | What it is for |
|---|---|---|
| `prepare` | ubuntu | Refuses a tag that is not on `main`, then lint, format, typecheck and unit tests |
| `build` | ubuntu | One job, not a matrix: `bun build --compile` cross-compiles all five targets in it. **No `environment:`**, deliberately, so it cannot reach the store token |
| `sign` | ubuntu | Signs `SHA256SUMS.txt` with keyless cosign. **No `environment:`** either, and `id-token: write` is granted here and nowhere else. The job that can sign cannot write the store, and the job that writes the store cannot sign |
| `leave-macos` | macOS | Runs the pre-publication checks against `wego-darwin-arm64`. `release` **needs** it, so darwin gates publication rather than reporting after it |
| `release` | ubuntu | `environment: production`, `concurrency: group: ring-next` with `cancel-in-progress: false`, because a cancel mid-copy is a half-moved ring. The only job that advances a ring |
| `replace-macos` | macOS | The darwin half of the post-pointer replace proof. `needs: release`, because the checks in it read the ring |

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

## An edge build

`edge-cli.yml` runs on every push to `main`. Version is `package.json` plus
`-edge.<sha>`, shallow checkout, `concurrency: group: ring-edge`,
`environment: production`. It uses the same publisher as the release lane:
`--freeze` to write the immutable prefix, then a separate `--promote --to edge`.

Edge carries its own signing identity, distinct from the release one.

---

## A promote

`promote-cli.yml`, `workflow_dispatch` only. One input: `tag`.

It has no rollback mode. A promote only ever advances `cli/stable` onto what
`cli/next` serves, so every gate below may assume `next == tag` unconditionally.
Putting `stable` back on an earlier release is `rollback-cli.yml`.

Two jobs:

**`approve`** holds no secrets and no variables, and `promote` cannot begin until
it passes. It refuses unless the dispatcher is a named promoter. The list lives
in `.github/workflows/promote-cli.yml` and that file is the authority; at the
time of writing it is `sunny-wego`, `yeouchien-wego`, `chuyeowego`.

**Who may change it:** anyone opening a pull request, but `main` requires a
code-owner review, so widening the list is always a reviewed change. That is the
whole reason an allow-list in a file is meaningful here.

**What this gives up:** four eyes. With environment reviewers the dispatcher and
the approver had to be different people. Here one person is both. Restoring that
needs GitHub Enterprise (wego/foundations#128).

**`promote`** runs with `environment: production` and
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
rather than trusting the event, so a failed promote, a cancelled run or a
`plan_only` rehearsal is a harmless no-op.

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

## The `production` environment

Both secrets and all variables live at **environment** scope on `production`,
`main` and `v*` tags only. Jobs that do not declare `environment: production`
cannot read any of it – which is why the `build` job does not declare it.

### Secrets

| Secret | What it is for |
|---|---|
| `BLOB_READ_WRITE_TOKEN` | Writes the release store. Held by the `release`, `promote` and edge jobs only |
| `SKILLS_PUBLISH_APP_PRIVATE_KEY` | The GitHub App key used to mint a token for publishing the plugin to `wego/skills` |
| `RELEASE_PLEASE_APP_PRIVATE_KEY` | The App key release-please signs its commits and tags with. Using an App, not the default token, is what lets the tag it creates trigger `release-cli.yml` |

### Variables

| Variable | What it is for |
|---|---|
| `WEGO_API_URL` | The API the built binary talks to. Asserted HTTPS and a production host at build time |
| `WEGO_AUTH_AUTHORIZE_URL` | OAuth authorize endpoint baked into the binary. Same assertions |
| `WEGO_AUTH_TOKEN_URL` | OAuth token endpoint baked into the binary. Same assertions |
| `WEGO_CLI_CLIENT_ID` | The public OAuth client id. The CLI is a public + PKCE client and holds no secret |
| `WEGO_CLI_POSTHOG_PROJECT_KEY` | Write-only analytics key. **Optional**, and it belongs at **repository** scope, not here: the `build` job has no `environment:`, so setting it on the environment bakes an empty value and fails nothing |
| `SKILLS_PUBLISH_ENABLED` | Turns the plugin publish on. When on, the promote refuses a tag whose tree cannot publish |
| `SKILLS_PUBLISH_APP_CLIENT_ID` | Client id paired with the App key above |
| `RELEASE_PLEASE_APP_ID` | App id paired with the release-please key above |

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

The `notify` job on `release-cli.yml` and the `contract-drift.yml` lane do not
exist yet; they are built in wego/foundations#139. This document covers the lanes
as they are, and gains those two sections when that issue lands.
