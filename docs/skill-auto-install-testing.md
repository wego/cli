# Testing the skill auto-install + auto-refresh change

Local verification steps for the change that makes the agent skill **install without a prompt**
and **refresh itself without user action**. Everything here is human-runnable; nothing needs a
release.

Background on why the change exists is in [`../AGENTS.md`](../AGENTS.md) → *Skill distribution*.
Short version: the publish side of the skill channel was fully automated, but nothing on an
installed machine ever pulled from it, and `curl | bash` has no TTY so the old prompt-gated
installer skipped the skill for every agent-driven install.

---

## 0. Setup

```bash
bun install                      # repo root, respects the packageManager pin
```

## 1. Fast checks (no network, no release — start here)

```bash
cd apps/api && bun run test                    # installer script: unconditional, no TTY gate, =0 opt-out
cd apps/cli && bun run test                    # includes skill-refresh.test.ts (every throttle guard)
cd apps/cli && bun run typecheck
bun run lint                                   # repo root
```

The sim's own drift guards run in that same `cd apps/cli && bun run test` — no separate invocation.
They used to need one, with a mandatory leading `./`, because they sat under the dot-dir
`.claude/skills/`, which bun skips; without the `./` bun read the argument as a name filter, matched
nothing and exited 0. Moving the harness to `scripts/sim/` retired that footgun.

(`flavor-guard.test.ts` is gone too — the sandbox `PATH` stubs it guarded went with the sandbox.)

Six pre-existing failures in `apps/cli/src/flights-e2e.test.ts` are unrelated to this change —
they spawn the CLI against a live API. Confirm with `git stash && bun test src/flights-e2e.test.ts`.

## 2. Read the installer script as served

```bash
cd apps/api && bun run dev            # :3001
curl -s localhost:3001/install | tail -30
```

Dormant (404) until `CLI_DOWNLOAD_BASE_URL` is set — that is expected
locally. What matters in the tail:

- `"$dest" skill install -y --keep-local-edits` runs with **no** `[ -t 0 ]` guard around it.
- The only gate is `[ "${WEGO_CLI_INSTALL_SKILL:-1}" = 0 ]`.
- There is **no** flagless retry. A binary released before the flag existed rejects it, so a
  `curl | bash` between the api deploy and the next CLI release installs the CLI with no
  skill. Accepted deliberately: a retry would fire in exactly the state the sim runs in (a
  fresh HOME), so the harness would pass on a broken flag. See `apps/api/docs/cli-release.md`.
- A failure prints a warning and does **not** fail the install.

## 3. Prove the refresh converges a stale skill (the important one)

The guards are unit-tested, but the throttle is 24h and the code path is silent, so this is the
only way to watch it actually work. Needs a **released** binary — a from-source run correctly
skips the refresh, and an unbaked build has no channel.

```bash
BIN=~/.local/bin/wegostaging          # or wego
FLAVOR=wegostaging
SKILL=~/.claude/skills/$FLAVOR

"$BIN" skill install -y               # ensure the dir exists and is wego-owned
ls -a "$SKILL"                        # expect SKILL.md + .wego-skill-owner

# Diverge the body, RE-BASELINE the marker to it, then age the marker.
#
# All three steps matter, in this order. The marker records the SHA256 of the body
# wego last wrote; without step 2 the refresh reads this as a HAND-EDIT, correctly
# preserves it (row i below), and the grep never reaches 0 — you would be looking at
# the guard working, not the refresh broken. Step 3 comes last because writing the
# marker resets its mtime.
printf '%s\n' "STALE SENTINEL" | cat - "$SKILL/SKILL.md" > /tmp/s && mv /tmp/s "$SKILL/SKILL.md"
shasum -a 256 "$SKILL/SKILL.md" | cut -d' ' -f1 > "$SKILL/.wego-skill-owner"
touch -d '2 days ago' "$SKILL/.wego-skill-owner"      # macOS: touch -t $(date -v-2d +%Y%m%d%H%M)

"$BIN" version                        # any command; the refresh runs AFTER its output
grep -c "STALE SENTINEL" "$SKILL/SKILL.md"            # expect 0 — it converged
```

`shasum -a 256` is on both macOS and Linux; `sha256sum` is Linux-only. The sim used to carry
this fixture too (`assertSkillAutoRefresh`), with the identical omission, and hard-failed
every run until it was corrected — that function is **gone** along with the sandbox `HOME`
it needed, so the procedure above is now the only place the refresh is checked.

Also confirm what it must **not** do. Each of these is a real defect found in review, so they
are regression checks, not hypotheticals. **`backdate` below means the last two lines of
the block above** — re-baseline the marker to the current body, *then*
`touch -d '2 days ago' "$SKILL/.wego-skill-owner"` (macOS: `touch -t $(date -v-2d +%Y%m%d%H%M) …`).
Rows i–k are the exception: they test the hand-edit guard, so they deliberately skip the
re-baseline — that mismatch IS the edit being detected.

| # | Do this | Expect | Guards against |
|---|---|---|---|
| a | `"$BIN" version` | only the version on stdout, nothing on stderr | the refresh must stay silent — stdout is a JSON contract for the funnels |
| b | run `"$BIN" version` twice, `stat` the marker between | second run does no network; mtime fresh after the first | the 24h throttle |
| c | backdate, then `WEGO_CLI_NO_AUTO_SKILL=1 "$BIN" version` | sentinel still present | the kill switch (CI images, containers) |
| d | delete `.wego-skill-owner`, then `"$BIN" version` | dir **not** recreated or touched | refresh-only — never creates a skill the installer didn't |
| e | backdate, then `"$BIN" skill uninstall -y`; `ls "$SKILL"` | stays gone | the refresh must not resurrect what you just deleted |
| f | backdate, then `"$BIN" skill install --embedded -y`; `grep` for a remote-only string | embedded body survives the command | the refresh must not reverse an explicit `--embedded` |
| g | backdate, then `"$BIN" skill list --json` with the network blocked | succeeds, no network | `list`/`path` are documented offline + auth-free |
| h | `mkdir -p ~/.codex` (with only `~/.claude` previously owned), backdate, `"$BIN" version` | **no** skill appears in `~/.codex/skills/` | the refresh writes only to dirs it already owns |
| i | append a line to `$SKILL/SKILL.md`, then `touch -d '2 days ago'` the marker **without re-baselining**, `"$BIN" version` | your line **survives** | the refresh must not silently discard a hand-edit — it is unattended and logs nothing |
| j | after (i), run `"$BIN" skill install -y` | your line is replaced, and stdout says `Replaced a locally modified copy.` | a foreground install may overwrite, but never mutely |
| k | after (i), run `"$BIN" skill install -y --keep-local-edits` | your line **survives**; stdout says `left alone` | the flag the `curl \| bash` installer passes — that caller is foreground code with **no TTY and nobody reading stdout**, so a reinstall to update the binary must not discard an edit |
| l | after (k), add `--force` | replaced | `--force` overrides the flag, for reclaiming a dir you know you scribbled in |
| m | on a machine with `~/.codex` but no `~/.claude`: install, then `"$BIN" skill path` | prints the `.codex` path that **exists** | onboarding's no-restart step 2 tells the agent to READ the file this reports; the old Claude-only default named a path that wasn't there |
| n | append a line, empty the marker (`: > "$SKILL/.wego-skill-owner"`) to fake a pre-baseline install, backdate, `"$BIN" version` | your line **survives**; stdout still only the version | an empty marker means the baseline is *unknown*, and the silent path must not resolve that by writing — `wego update` swaps the binary with no install, so a hand-edit really can sit under a baseline-less marker |
| o | after (n), run `"$BIN" skill install -y --keep-local-edits`; then `cat "$SKILL/.wego-skill-owner"` | your line is replaced **and** the marker now holds a digest | the other half of (n): the installer adopts and rebaselines, so preserving "unknown" cannot freeze a pre-marker machine forever |

**Multi-agent case (h) is worth doing deliberately** — four separate defects came from the
refresh's watch-set and write-set being conflated, and it is the least intuitive behaviour here.
If you have both `~/.claude` and `~/.codex` genuinely owned, also backdate only one marker and
confirm **both** get refreshed and re-stamped (the oldest marker decides for the whole set).

## 4. The full agent-acceptance harness

This is the end-to-end proof: it runs the real `curl | bash`, lets the **installer** place the
skill, and drives a real nested Claude session. It does **not** run the staleness fixture from §3 —
see below.

```bash
cd apps/cli
wegostaging login              # target flavor's token — the ONLY prerequisite
bun run test:sim --yes         # --yes carries YOUR consent to the reinstall
```

No Anthropic credential is needed any more: the nested session inherits your real login with your
real `HOME`. `--yes` is required in a non-TTY shell because the run moves your installed binary
aside — see the sim's `SKILL.md` → *Run*.

**Run this at least once before merging.** The sim is human-run, not CI, so an unverified change
here looks fine until someone runs it.

Expected provisioning line:

```
acquisition: moved /Users/you/.local/bin/wegostaging aside, installing from scratch
using your installed wegostaging vX.Y.Z at … (current on staging); skill …; credentials …; whoami OK
```

Each clause is a distinct gate:

| Clause | What failed if it's missing |
|---|---|
| `left no skill at …` | The installer's `skill install` step regressed — the core of this change |
| `did not (re)write the skill at …` | The step ran but changed nothing: it failed silently (the install script only *warns*), or `--keep-local-edits` preserved a hand-edited `SKILL.md`. Run `wegostaging skill uninstall` first for a clean assertion |
| `cannot execute` / `whoami failed` | The channel served a bad binary, or the credentials are not valid for this target. Your original binary is restored either way |

The **staleness refresh** is no longer covered here — that preflight gate needed the sandbox `HOME`
and went with it. Verify it by hand per §3.

### Watch for

- **This run DOES write to your real `~/.claude/skills/<flavor>`** — that is the point, and it is the
  *only* skill directory it touches. `skill install` can target every agent home it detects, but the
  installer deliberately does not let it: `apps/api/src/routes/install.ts` pins the unattended write
  with `--agent claude`, so `~/.codex/`, `~/.cursor/` and `~/.cline/` are left alone. That also makes
  the harness's placement assertion exact — it reads the one directory the installer writes. Your
  binary is *renamed*, never deleted, and restored if anything throws; a hard kill inside the download
  window can leave a `.wego-cli-sim.bak` next to it, which the next run refuses to overwrite and tells
  you how to recover.
- **There are no env overrides at all.** The nested session inherits your environment, filtered only
  by an allowlist. If you find yourself adding an override to make something work, that is the
  harness drifting away from a real machine — the reason `sim-env.test.ts` exists.

## Remote reachability is required for §3 and §4

The background refresh runs with `requireRemote`, unlike the foreground `skill install`: an
unverifiable channel means *leave the existing file alone* rather than fall back to the embedded
copy, so a transient outage can't downgrade a skill that has advanced past the binary's embed.

Two consequences when testing:

- **§3 needs the Blob channel reachable.** If it's down, the sentinel stays and the check fails —
  correctly. That is the feature, not a flake. Confirm reachability before concluding the refresh
  is broken. (§4 needs the channel too, for the binary and the skill its installer places — but it
  no longer runs the refresh fixture at all.)
- **It narrows the old known gap.** Convergence now does imply the published body was actually
  fetched and checksum-verified, since embedded fallback is off on this path.

What still isn't proven: that the published body **differs** from the embedded one. On a fresh
release they're identical, so these checks can't distinguish "read the channel" from "read a
channel serving exactly what we already had". Fully closing that needs a deliberately divergent
published body — release-time territory (`scripts/verify-skill-published.ts`), not something to
orchestrate mid-sim.
