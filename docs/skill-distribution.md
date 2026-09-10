# Skill distribution (issue #1171)

> **Not present in this repository.** The Blob skill channel described below –
> `skill/next`, `skill/stable`, `publish-skill.yml`, the remote resolver and the
> once-a-day background refresh – lived in wego-ai and did not move here. In
> `wego/cli` the `SKILL.md` ships **embedded in the binary**, and `update`
> re-runs `skill install --owned-only` after it swaps the binary so the copy on
> disk matches the build serving it. This document is kept for the reasoning it
> records (why the verify is fail-closed, why a ring must not be baked, how
> ownership markers work), which the embedded path and the plugin publish still
> rely on. Treat every channel mechanism it names as history until a later phase
> of wego/foundations#127 decides whether to reintroduce it.

How the agent `SKILL.md` is authored, published, installed, and refreshed.
Summary lives in [`AGENTS.md`](../AGENTS.md).

The agent skill ships **out-of-band from the binary** so it can update without a
CLI release. `apps/cli/.claude/skills/<id>/SKILL.md` is the **single source of
truth**; the Blob channel and the binary embed are both derived, write-only CI
outputs of that same canonical body.

## Channels

They mirror the binary's, in the **existing** CLI Blob store (reusing
`BLOB_READ_WRITE_TOKEN` — no new store):

| Channel | Advanced by |
|---|---|
| `skill/next/<id>/` | staging-first, every skill-edit merge via `.github/workflows/publish-skill.yml` |
| `skill/stable/<id>/` | prod, stable release or promote only |

Each holds `SKILL.md` plus a computed `SHA256SUMS`.

That table is not just documentation: `CHANNELS` in `scripts/skill-publish.ts` is
the same list, and every publish runs `orphanSkillChannels` over the store and
warns on a `skill/<x>` prefix outside it. An orphan is the failure mode worth
watching for here, not a missing channel — a prefix nothing writes to any more
keeps serving 200 with its own matching sums, so it looks healthy from outside and
a fail-closed client accepts a body frozen at whatever it held the day it was
orphaned. `skill/latest` and `skill/staging` sat that way after the rename, and a
release that baked one shipped it to every prod install (#1751). Adding a channel
means adding it there too.

- `scripts/publish-skill-blob.ts <next|stable>` publishes.
- `scripts/verify-skill-published.ts <base>` is the release-time fail-closed gate:
  it recomputes the digest and asserts the published body matches source.
  The read is **polled** (24 attempts 5s apart, the count `blob-consistency.ts`
  uses for the binary channels), because these are CDN-fronted objects with a 60s
  `cacheControlMaxAge`: for up to that long after a publish, an edge can still
  serve the previous body. The 115s of sleep alone clears that window; wall clock
  reaches ~235s only if every read also burns `fetchRemoteSkill`'s 5s timeout,
  i.e. the channel is unreachable, where waiting is what you want. Bounded either
  way, so it fails rather than hangs. A single read reported that lag as "channel drift" and
  failed `cli-v0.4.1` 81ms after a correct `skill/stable` publish. `skill/next`
  hid it, because it is republished every release and so usually already holds the
  body under test. The gate is not weakened — after the budget it still throws,
  and it deliberately uses no cache-busting query param so it sees exactly what an
  installer would.
- `scripts/skill-publish.ts` holds the pure, importable helpers behind all of
  these (Blob path scheme, `SHA256SUMS`, the token gate, and the release-time
  verify `assertSkillChannel`). Split from the entry scripts the way
  `release-config.ts` is split from `build-release.ts`, so the logic is
  unit-tested in `skill-publish.test.ts`.

## Remote install

`wego skill install` fetches `<origin>/skill/<ring>/<id>/` directly — no api
route, one pinned origin. It verifies fail-closed, then rewrites to the flavor
locally. Any failure falls back to the embedded copy.

The base is **half baked, half recorded** (#1751), and the split is the point:

| Half | Where from | Why there |
|---|---|---|
| store origin | compiled in, pinned to the store's host family (removed with the channel; see the note at the top) | a wrong origin serves the `SHA256SUMS` too, so the client's own verify agrees with itself and cannot catch it. It must not be settable at run time. |
| `skill/<ring>` | the install record, via `skillBaseForRing` | a promote moves a pointer over the **same bytes**, so one binary is both `next`'s and `stable`'s. A ring compiled in is wrong on one side of every promote. |

Baking the whole URL made one value answer both questions, and it could only
answer the first. That is how a release built after the `latest`/`staging` →
`next`/`stable` rename shipped with `skill/latest` compiled in: the Environment
variable lived outside the repo, so the rename never reached it, nothing validated
the path, and the retired prefix still served 200 with matching sums. Every 0.8.0
install fetched a frozen rc-era body while its own record said `stable`.

A ring with no published channel 404s into the embedded copy, which is why **edge
needs no `skill/edge`**: an edge build embeds its own commit's `SKILL.md` and is
in sync with itself by construction.

`src/skill-remote.ts` does the fetch: `fetchRemoteSkill(base, id, {fetch})` is
HTTPS-only (`assertSecureUrl`), uses `AbortSignal.timeout`, composes
`<base>/<id>/{SKILL.md,SHA256SUMS}`, and returns the canonical body **only** when
its SHA256 matches the published sums. It returns `null` on any failure —
non-200, timeout, empty, mismatch, missing sums, bad URL — and the caller uses
the embedded copy. No api, no redirect.

`src/skill-embed.ts` holds the embedded **registry** (`SKILLS`:
`{id, description, read}[]`, one row today). It bakes
`.claude/skills/wego/SKILL.md` into the compiled binary via a
`with { type: "file" }` asset import — embedded by `bun build --compile`, resolved
to the on-disk file from source — so `wego skill list` and `install` need no repo
and no network. `id == frontmatter name == dir` is drift-guarded in
`skill-embed.test.ts`. `src/asset.d.ts` gives the `*.md` import its ambient string
type.

## `src/skill.ts` — the command

`wego skill <list|install|path|uninstall>`.

Each of install / path / uninstall takes an **optional `<skill-id>`** positional,
resolved against the injected `SKILLS` registry via `resolveSkill`: no id + one
entry → that entry; no id + many → usage error; unknown id → an error naming
`skill list`. `list [--json]` prints the installable skills, offline and
auth-free.

### Multi-agent targets

A vendored `AGENTS` path table maps each agent to its skills dir:

| Agent | Project dir |
|---|---|
| `claude` | `.claude/skills` |
| `codex`, `cursor`, `opencode`, `cline` | the shared `.agents/skills` |

Global installs use the per-agent home config dir (`.codex`, `.cursor`, …).
`resolveTargets` dedupes by root, so a project install collapses to
`.claude/skills` + `.agents/skills`.

`selectedAgents`: `--agent '*'` → all; explicit `--agent`/`-a` (repeatable) → as
asked; else **auto** — project default `[claude, codex]`, user (global)
auto-detects agents whose home config dir exists (Claude fallback), and a bare
`uninstall` stays conservative (Claude only).

Multi-target installs are **best-effort**: `installOne` / `uninstallOne` never
throw, each target reports its own outcome, and `reportOutcomes` exits 0 when
**any** target succeeded, non-zero only when every one failed.

### `path` reports where the skill actually is

`path` is deliberately **not** in the auto-detect group above. It reports where
the skill ACTUALLY is: the auto-detect filtered to targets that hold a `SKILL.md`
**and** carry an ownership marker, falling back to the single conservative target
only when nothing is installed.

Ownership is part of the filter, not just presence. `installOne` refuses a
marker-less `SKILL.md` as foreign, so a multi-agent machine can hold someone
else's file beside ours — and reporting that one is worse than reporting nothing,
because onboarding tells the agent to READ what this prints, so it would load
unrelated instructions and look like it worked.

Claude-only here was wrong on a Codex/Cursor/OpenCode/Cline machine, where
`install` writes elsewhere and the agent-onboarding doc's no-restart step ("read
the file `<flavor> skill path` reports") then named a file that does not exist.

### Flavor scoping

The dir **leaf is the flavor** for the shipped `wego` skill (`skillLeaf`, #1188:
leaf = `deps.flavor`); any other skill's leaf is its id. So
`~/.claude/skills/wego` for prod and source, `~/.claude/skills/wegostaging` for
staging — the two flavors never share a dir, and a staging skill drives
`wegostaging`. `--scope project` swaps the scope root; `--dir` overrides the root
with the leaf preserved.

`applyFlavor` rewrites the **verified** canonical body locally for a non-`wego`
flavor:

1. Rewrites `wego <sub>` command lines → `<flavor> <sub>`.
2. Rewrites the API host `api.wego.com` → `api.<flavor>.com`, so a staging body
   never hands the user a **production** `curl … /install | bash`.
3. Rewrites frontmatter `name: wego` → `name: <flavor>`.
4. **Replaces the frontmatter `description:`** with the overlay's, and **throws**
   if the canonical body carried no `description:` line to replace. Silence there
   would leave the production description on a staging skill, which is the exact
   trigger collision this rewrite exists to prevent.
5. **Prepends the overlay's body** to `## Operating contract`, last, so the
   overlay's own text is never reprocessed by the passes above.

Two things it deliberately does **not** rewrite: backticked `` `wego` ``, which
is overloaded with the `--booking-types` enum value, and bare `wego.com` where
the body describes how the product behaves (true of both environments). All five
edits are a no-op for `wego`, so its body is byte-identical.

### The staging overlay

Edits 4 and 5 read `.claude/skills/wego/staging-overlay.md`, embedded in the
binary beside `SKILL.md` and exposed as `SkillEntry.readOverlay`. It is a
frontmatter `description:` plus a markdown preamble, and `{{flavor}}` in either
is substituted with the running flavor - so the file never hardcodes
`wegostaging` and survives a renamed flavor.

Three reasons it is a file rather than string literals in `applyFlavor`:

- **The prod body is production-only.** `SKILL.md` mentions staging nowhere, so
  the staging guidance needs somewhere else to live.
- **`description:` is the only text an agent reads when choosing a skill.** Both
  flavors install side by side into the same agent, and the body - including the
  flavor-lock directive - loads only *after* that choice. Inheriting the prod
  description made prod-vs-staging a coin flip on every travel request.
- **Staging answers are not production answers.** The overlay is where that gets
  said, and it cannot be said in a production-only body.

`readOverlay` is **required** on `SkillEntry`, not optional. An entry without one
would install a prod-shaped body under a staging name, so the type system forbids
it rather than leaving a silent branch. Only the **shipped** skill takes the
overlay (`isFlavorScoped` gates on the id, matching `skillLeaf`): another
registered entry keeps its own id and its own description under any flavor.

The description carries no colon and no quote character, since either breaks the
unquoted YAML scalar it is emitted as. `skill-embed.test.ts` asserts that against
the real overlay file, not a fixture.

The overlay is **baked, while the body floats**: only `SKILL.md` is published to
the channel, so a staging install can fetch a newer canonical body and compose it
with the overlay compiled into its own binary. A body fix therefore reaches
staging users over the channel, while an overlay fix needs a CLI release.

### `list` and `install` agree on the id

`skill list` reports `skillLeaf` (the flavor for the shipped skill) and the
description that *this flavor would install*, so the staging binary lists
`wegostaging` rather than `wego`. `resolveSkill` accepts the flavor name as an
alias for the shipped skill, so the id a user reads off `list` is one `install`
takes: `wegostaging skill install wegostaging` works, as does the bare form and
the underlying `wego` id. The alias never shadows another entry's own id.

Two exported helpers keep printed and written paths from drifting:

- `defaultUserSkillDir(home, flavor)` builds `~/.claude/skills/<flavor>` and is
  reused by `index.ts` for `uninstall`'s summary path. It stays Claude-only for
  `uninstall`, which is deliberately conservative.
- `autoDetectedUserSkillDirs(home, flavor)` returns **every** dir a default
  user-scope install writes on this machine (the same auto-detect, deduped by
  root). This is what the background refresh watches — `defaultUserSkillDir`
  alone is only right on a Claude machine, and gating on it would leave a
  Codex/Cursor/OpenCode/Cline-only install permanently frozen.

## The ownership marker

A sibling `.wego-skill-owner` marks a wego-owned dir, so a body change
**upgrades** in place while a marker-less `SKILL.md` needs `--force`. The legacy
`.wego-skill-version` name is still honored on read.

**Ownership is presence-only.** `hasOwnerMarker` never reads the file, so a
marker from any older binary still reads as ours.

Every write goes through `stampOwnerMarker`, which also **deletes any legacy
`.wego-skill-version`** in that dir. The refresh watches both names and takes the
OLDEST mtime, so a legacy file that install never restamps would hold the
throttle window open permanently — the visible symptom was
`skill install --embedded` being reversed by the very next ordinary command.
Removing beats restamping, because two files recording one fact is what caused
it; `uninstall` already deleted both names.

Writes go through `writeFileAtomic` (sibling temp + `rename`), so a crash
mid-write cannot leave a truncated `SKILL.md` that the already-stamped throttle
would hide for 24h.

### The marker's contents answer a different question

It records the **SHA256 of the body wego last wrote**, and `localEditState`
compares it to what is on disk to tell "wego wrote this" from "a human edited
it".

Ownership says we MAY write. The baseline says whether writing would destroy
something typed by hand.

- The **background refresh refuses to overwrite a modified body** — silent plus
  unattended means no diff, no backup, no log line to notice.
- A **foreground `install` overwrites** and reports it: `Replaced a locally
  modified copy.`
- `--force` overrides both.

### The undecidable case: an absent or empty baseline

"Unknown" is genuinely undecidable, so the two unattended callers split on it:

- **`refreshOnly` (the silent refresh) preserves the file.** That path has no
  diff, backup, or log line, and `wego update` can deliver a new binary over a
  hand-edited body without any install running — so a silent overwrite would
  destroy it unrecoverably.
- **`--keep-local-edits` alone (the `curl | bash` installer) still adopts and
  rebaselines it.** One deliberate, reported install adopts the dir so every later
  refresh can decide properly. Without that half, nothing would ever write a
  baseline for a pre-marker install and the refresh would freeze every existing
  machine forever — which is the staleness this feature exists to remove.

### `--keep-local-edits` also means: never downgrade to the embedded copy

`requireRemote` gives the refresh an all-or-nothing rule — no verified body means
touch nothing. The installer cannot take that rule: on a clean machine it must
still create the file.

So the decision is made per target from the body's provenance
(`resolveInstallBody` returns `{body, verified}`): an unverified body plus a file
already there plus unattended ⇒ leave it; creating from nothing still falls back.

This is **not** covered by the edit guard — the installed body matches its
baseline, so it is not an edit, yet an earlier refresh may have installed a
published body postdating this binary's embed.

### Uninstall

`uninstall` likewise refuses a marker-less dir without `--force`, then deletes
only `SKILL.md` and both marker names, and `rmdir`s the dir only when empty. A
`--force`-adopted dir's other files are left intact.

`src/skill.ts` is written against injected deps (`skills`, `version`, `flavor`,
`homedir`, `cwd`, `confirm`, `skillUrl?`, `fetchRemoteSkill?`, fs via
`node:fs/promises`) so the flows unit-test without the real home dir or network.

## The two scoping flags, restated

**`refreshOnly` scopes the background refresh's WRITES to dirs it already owns.**
Ownership gates *whether* the refresh runs, but `resolveTargets` re-runs
auto-detect to decide *where*. Without this, a `~/.codex` created at any point
after a Claude-only install would silently acquire a skill and a marker on the
next background refresh — a brand-new directory in someone's `$HOME`, for an
agent they never ran `skill install` for. `installOne` skips (ok, not a failure)
any target without an owner marker when it is set. The foreground install must
keep creating targets; that is its job.

**`requireRemote` splits the two callers' failure behavior.** The foreground
`skill install` keeps the embedded fallback — it may be creating the file from
nothing, and "never fails on a down remote" is its contract. The **background
refresh** sets `requireRemote`, so an unverifiable channel means *leave the
existing file alone*: the installed body may be **newer** than this binary's embed
(an earlier refresh pulled a published body postdating the build), and falling
back would silently downgrade it — for 24h, since the throttle stamp is already
written. Nothing beats older.

## `src/skill-refresh.ts` — the automatic refresh

`maybeRefreshSkill(deps)` is the **consume** side of the out-of-band channel: a
once-per-24h, silent, best-effort re-run of `skill install -y` so an installed
skill stops freezing at install-time content.

The publish side was always automated, but nothing on an installed machine ever
pulled from these channels, so a skill froze at install-time content forever —
`wego update` self-replaces the **binary** only.

It adds no install logic of its own (`skill install` already fetches → verifies
fail-closed → flavor-rewrites → byte-compares → no-ops when equal). This module
only decides **when**.

### Guards, in order

1. **Explicit skill command** — `isExplicitSkillCommand`: any `wego skill …`
   subcommand, or the top-level `wego uninstall`. The refresh must never
   contradict the very command that just ran, and it otherwise does in two ways:
   it *undoes* a removal (removal is Claude-only by default, so a surviving marker
   in another detected agent's dir still reads as owned), and it breaks
   `skill list` / `path`'s documented **offline + auth-free** contract.
2. From-source run.
3. No baked `skillUrl`.
4. `WEGO_CLI_NO_AUTO_SKILL` set.
5. No ownership marker anywhere — it is **refresh-only** and never creates one.
6. Oldest marker mtime inside the 24h window.

### Which dirs it watches

**Every** user-scope dir a default install writes (`autoDetectedUserSkillDirs`),
not just Claude's — a Codex/Cursor-only machine has no `~/.claude/skills/<flavor>`
at all. The **oldest** marker decides staleness, and every owned marker is
stamped.

### The throttle stamp

The marker's **mtime** is the stamp: no new file, no config, no version field to
keep in sync. It is written **before** the install, so a hanging remote costs one
attempt per window rather than one per command.

The claim must actually **land**: **every** owned marker must stamp successfully
or the refresh is abandoned (`skipped-unclaimable`). Not merely "all of them
failed" — `oldest` spans the whole owned set, so one unstampable dir (read-only or
immutable home) would stay the oldest and re-arm the fetch on every subsequent
command. Going stale silently is the cheaper failure, and it costs little, since a
dir it cannot stamp is one `install` could not write to either.

The window is **not atomic across processes**, by design. Two concurrent commands
can both refresh, costing one duplicate fetch of an identical checksum-verified
body written to the same path. A lockfile plus stale-lock recovery is
disproportionate to that, so "once per window" is a strong default, not a hard
guarantee under concurrency.

It returns a `RefreshOutcome` instead of logging, so a silent path stays
unit-testable. Wired in `index.ts` via `buildSkillRefreshDeps()` — silenced io, 2s
fetch deadline, **`requireRemote`** and **`refreshOnly`** set together — and
awaited after `run()` resolves: after the command's output, never affecting its
exit code.

Guards are unit-tested in `skill-refresh.test.ts`. The end-to-end proof is the
`wego-cli-sim` staleness fixture, since a 24h throttle is invisible to any
short-lived test.

## The plugin repo (foundations#101)

`wego/skills` exists for third-party discovery, which cannot see the private
monorepo. The release pipeline writes it and **no human edits it**: the repo is
an output, and `plugin/README.md` says so on its front page.

`scripts/publish-plugin.ts` runs from `promote-cli.yml`, in the same job that
advances `skill/stable`, and publishes exactly four paths:

| Source (under `apps/cli/`) | Published as |
|---|---|
| `plugin/plugin.json` | `plugin.json` |
| `plugin/README.md` | `README.md` |
| `plugin/LICENSE` | `LICENSE` |
| `.claude/skills/<id>/SKILL.md` | `skills/<id>/SKILL.md` |

Those pairs are `pluginPublishPlan()` in `scripts/skill-publish.ts`, and they are
data rather than a sequence of copy calls, so the three things that need the set
share one answer: the publisher copies it, `--print-plan` prints it, and the
after-clone predicate uses its destinations as the expected set. Adding
`mcp.json` later is one entry; relocating the sources is the one
`PLUGIN_SOURCE_DIR` constant.

### The licence

`plugin/LICENSE` is the **verbatim** Apache 2.0 text from `apache.org`, and
`plugin.json` carries the matching SPDX id `"Apache-2.0"`. Two files rather than
one because they answer different readers: a human scrolling the repo, and a
consumer matching a string.

It is load-bearing, not decorative. The repo exists to be read by people who
cannot see the monorepo, and **a repo with no licence grants those people no
rights** - it is "all rights reserved" with a friendly README on top. That was
the one blocker recorded against making `wego/skills` public
(foundations#98), which is why the public flip and this file are the same change
rather than two.

Nothing about the appendix is filled in, on purpose. The Apache appendix is a
template for applying the licence to your own source files, and leaving it as
shipped keeps `LICENSE` byte-identical to the canonical text - so "is this really
Apache 2.0" is answerable by comparison rather than by reading. The copyright
assertion lives in the README's own License section instead, where a diff against
`apache.org` is not the thing being checked.

`plugin-conformance.test.ts` pins it by **digest** against the canonical text,
over LF endings so a CRLF checkout does not false-fail. Landmarks alone were the
first version of this check and they do not hold: every structural landmark of
the licence (the title, the version line, the appendix, `END OF TERMS AND
CONDITIONS`) sits outside the clauses that grant anything, so a file with an
edited patent or trademark clause carries all of them, clears any length floor,
and publishes as "Apache 2.0". The landmarks are kept beside the digest for
**diagnosis**, since a bare hash mismatch never says which part drifted, and a
companion test tampers with one word inside the patent grant to prove the digest
rejects what the landmarks would have passed.

`LICENSE` is also the one published file deliberately **exempt** from the repo's
en-dash rule, since a house style cannot govern text we do not get to edit.

### The after-clone subset predicate

After the shallow clone and before anything is written, every path tracked in the
repo must be one the plan writes. That single check covers three states at once:
an **empty repo** (nothing tracked, nothing unexpected), the **steady state**
(exactly our paths), and a **stray file** somebody hand-committed, which is named
and refuses the publish. A **modified tracked file** is not an offender - putting
it back is the whole job.

It is fail-closed and it never deletes. A file the plan does not write is either
a mistake or something that turned out to belong, and a publisher cannot tell
which.

**The unwedge path**, when a publish refuses:

1. The file does not belong - remove it, by hand, once:
   `git clone git@github.com:wego/skills.git skills && cd skills && git rm -- '<path>' && git commit -m 'chore: drop stray file' && git push`
   (quote the reported path: `--` stops a leading `-` being read as an option,
   and the quotes survive a space.)
2. The file does belong - add it to `pluginPublishPlan()`, with a source file
   to publish it from. Every published path has a verbatim source file; that is
   the rule with no exceptions. The source **root** is per mapping, not one
   directory: `plugin.json` and `README.md` come from `plugin/`, and each skill
   body comes from `.claude/skills/<id>/SKILL.md` - the skill is the CLI's own
   published skill, so it has one source, not a copy under `plugin/`.

### `--print-plan`

`bun run scripts/publish-plugin.ts --print-plan` prints one
`<source> -> <destination>` line per pair and exits, so the published set is
assertable with no remote and no key. It `stat`s every source first and exits
non-zero on a missing one - otherwise it would print three lines straight from a
constant on a tree with no `plugin/` directory at all. It prints **both** sides
because the three destination names are fixed strings: against destination-only
output, a check that no source is drawn from the eval corpus or the staging
overlay could never fire.

### The credential, and the switch that arms the lane

The lane authenticates with a **GitHub App installation token**, not an SSH deploy
key. `promote-cli.yml` mints one per run with `actions/create-github-app-token`,
scoped by the inputs `owner: wego`, `repositories: skills` and
`permission-contents: write` - all three pinned by `.github/workflows-gate.test.ts`
- and it reaches git through `http.extraheader` rather than the remote URL.

The App's own **name and installation scope live outside this repository** and no
test here can see them, so they are not asserted as fact anywhere in the tree. The
workflow pins what it can: the permission it asks for and the single repository it
asks for it on. Whether the App is installed on `wego/skills` at all is answered
only by a run that mints a token and pushes - which is what the rung 5 credential
smoke test is for.

Two reasons the token stays out of the URL. `publish-plugin.ts` prints the remote
three times, and one of those is a `git clone` line an operator is told to paste
when a publish refuses; a URL-embedded token would ride into all three. Actions
masks a registered secret, but a pasteable command containing `***` is a broken
command, not a safe one. `redactRemote()` in `skill-publish.ts` is the second
belt: it strips any `user:password@` before the remote is logged, whatever the
transport.

**The credential never touches disk.** The header is injected through
`GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_0` / `GIT_CONFIG_VALUE_0`, which live in the
step's process environment, so there is no file to leak, nothing to clean up, and
nothing left behind when a run is killed before a cleanup step could run. That
last case is not hypothetical: `github-runner-small` is self-hosted, `$HOME`
outlives the job, and this repo already records that a run killed by a timeout or
an OOM never reaches its own cleanup. An `if: always()` step is a tidy path, never
a guarantee.

Writing the header into a git config FILE was the first attempt, and both shapes
of it were wrong. `git config --global` puts a live token in the runner's real
`~/.gitconfig`, on a machine the next job inherits. Redirecting `GIT_CONFIG_GLOBAL`
at a `$RUNNER_TEMP` file fixes that but introduces a subtler fault: it REPLACES the
global config rather than adding to it, so the runner's own `init.defaultBranch`
becomes invisible - and which branch `git push origin HEAD` resolves to on an empty
remote is the single failure the read-back below exists to catch. A lane must not
quietly change the input whose behaviour it is trying to measure. The environment
variables add to the real config instead of hiding it.

**The lane does not publish until `SKILLS_PUBLISH_ENABLED` is set to `true`**, and
that is deliberate rather than incidental. The retired deploy key held a safety
property by accident: nothing could publish until a human provisioned the
credential, and rung 5(b) was that moment. An App token is minted from credentials
that already exist, so wiring the App without a switch would arm the lane on the
very next promote - before rung 5(a) has driven the publisher against any real
remote, before `main` on `wego/skills` is branch-protected, and before anyone has
watched `git push origin HEAD` resolve a branch on an empty GitHub repo. The
variable restores the human gesture on purpose. `.github/workflows-gate.test.ts`
asserts the condition, because deleting it is a one-character change that would
arm production silently.

Why an App at all: GitHub documents that deploy keys never expire and stay active
after their creator leaves the repo, and recommends an App instead. For a channel
agents execute from, what the credential protects is integrity, not
confidentiality - the repo holds no secret - so expiry, central revocation and
org ownership are the properties that matter.

**Not yet done, and recorded so it is not rediscovered:** a published commit
carries `wego-ai <noreply@wego.com>` and no Verified badge. The App token
authorises the push, but the commit metadata is whatever `publish-plugin.ts` sets.
Real `wego-plugin-publisher[bot]` attribution with a signature needs commits built
through the GraphQL blob/tree/commit API instead of `git push`. Deferred to the
public flip, because that is when third parties start reading the history as
provenance, and it is the one thing that cannot be retrofitted afterwards.

### The read-back (rung 4b)

The subset predicate proves **paths**, not bytes: it asserts the repo holds nothing
the plan does not name, and then never looks at what the published files contain.
`scripts/verify-plugin-published.ts` closes that. It runs as its own step after the
publish, re-clones the repo, and compares every `{from, to}` pair byte for byte
against source, failing the promote when any is missing or differs.

**It re-clones on purpose.** Inspecting the working copy the publish pushed from
would only confirm we did what we thought we did - it reads our own copy of the
truth. The failure it exists to catch is invisible from there: `publish-plugin.ts`
ends with `git push origin HEAD`, and on an **empty** remote the clone has an unborn
HEAD, so which branch name that resolves to depends on what the remote advertises
against the runner's own `init.defaultBranch` - which the publish step deliberately
leaves inherited rather than overriding, so that what runs in CI is what rung 5(a)
measures. Resolve it wrong and the push succeeds,
the step exits 0, and the channel everyone installs from is still empty. Only an
independent fetch can tell. The refusal message names that possibility, because the
symptom - three missing files in a repo that looks healthy - otherwise sends an
operator hunting for a content bug that is not there.

It is gated on `SKILLS_PUBLISH_TOKEN` exactly like the publish - one exported
constant, not two literals that agree by luck - so it skips precisely when the
publish skips. A verify that ran while nothing was published would fail every
promote until the lane is armed.

**Once `wego/skills` is public, this read should drop the credential** and clone
anonymously. That reads the channel the way a user does, and it is the only version
that catches the repo being flipped back to private - an authenticated read sails
through that while every `skills add` in the world breaks. The licence blocker is
now cleared (see The licence above), so what remains is the flip itself and this
one-line change to the clone, in that order: an anonymous clone against a repo
still private fails every promote.

### Why it is simpler than the lane it replaced

The previous publisher shipped a bounded push retry, a non-fast-forward
classifier and a post-push read-back, and never executed once. A push that races
another writer now simply fails the step, and a re-run reconciles: the publish
commits nothing when the repo already matches source.

The step is **not** `REQUIRE_PUBLISH`-gated. The lane is unarmed - see the
credential section above - so every promote takes the graceful-skip branch, and a
promote whose binary ring has already moved must not fail on a lane that has
never run. Turning the gate on is its own change, after the lane is proved
against the real remote.

Note the reason for the skip changed with the credential and this paragraph used
to state the old one. It is no longer "no key exists": the App credentials do
exist, and `SKILLS_PUBLISH_ENABLED` is what is missing. An operator debugging a
promote that published nothing should check the variable, not hunt for a
credential that was retired.

### When this moves to `packages/wego-plugin/`

Move this to `packages/wego-plugin/` when the plugin needs to **derive** content from a second app - deriving is what turns a copy into a build, and a build wants its own workspace member. Another static file appearing here is not the trigger, and `LICENSE` arriving proved it: files copied verbatim are the same job however many there are.

## Agent-name reconciliation with `npx skills`

Vercel's `skills` flag values differ from this repo's vendored table keys:
`npx skills -a claude-code` ⟺ `wego skill install --agent claude`. `codex` /
`cursor` / `opencode` / `cline` map 1:1 by name. Keep the two spellings in sync
so `-a` doesn't silently diverge between the two tools.
