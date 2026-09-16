# Installing and updating the `wego` CLI

There is one binary and three **release rings** — `stable`, `next` and `edge`. The
installer records which ring it installed from, and `wego update` follows that
record for the life of the install. Nothing about the ring is compiled into the
binary, so a promote is a pointer move rather than a rebuild.

| Ring | Who it is for | Moves | Backward compatibility |
| --- | --- | --- | --- |
| `stable` | everyone; the default | on each release promote | kept, or made easy to migrate |
| `next` | anyone who wants the release candidate early | ahead of `stable` | **not guaranteed** |
| `edge` | engineers working on the CLI itself | every merge to `main` | **not guaranteed** |

## What each ring promises

**`next` and `edge` are development builds, and we ask you to treat them as such.**
Backward compatibility is **not guaranteed** on either, and can change **without
notice**: a command, a flag, a JSON field name, an output shape or an exit code may
differ between two builds with no deprecation window and no note. `edge` moves
fastest, rebuilding on every merge to `main`, and `next` is the release candidate —
but the promise is the same for both, which is that there isn't one.

**On `stable` we do our best not to break you.** Keeping backward compatibility is
the goal for everything you would reasonably depend on. Where we cannot keep it, we
make the change either **easy to migrate** — a documented path, and the command
itself telling you what to do — or **hard to miss**, failing loudly rather than
quietly changing what it does.

The practical consequence: **anything automated should run `stable`.** That means CI,
and it means an agent, because the agent skill drives the CLI by parsing its JSON —
a field that moves under `edge` breaks the agent silently. Run `next` or `edge` where
a person is reading the output.

Every recipe below is the same idea applied differently, so one rule is worth
reading first.

**Everything about an install lives in one directory: `$XDG_CONFIG_HOME/wego/`,
which is `~/.config/wego/` unless you say otherwise.** The ring record
(`install.json`), your login (`credentials.json`), your preferences
(`settings.json`) and your telemetry choice (`telemetry.json`) are all there. Two
installs that share that directory share all of it; two installs that don't, don't.
The command's name on disk has nothing to do with it.

---

## 0 · Stable, the normal install

```bash
curl -fsSL https://docs.wego.com/cli/install | bash
wego login
```

That puts `wego` in `~/.local/bin`, records `stable` in `~/.config/wego/install.json`,
and offers to install the agent skill.

To update:

```bash
wego update --check   # read-only: says whether a newer build exists, and on which ring
wego update           # confirms, then replaces the binary in place
wego update -y        # no confirm, for scripts
```

`update` compares **checksums, not version strings**, downloads from the ring your
record names, verifies against that ring's published checksums before swapping
anything, and replaces the running binary atomically. If the record is missing or
unreadable it **refuses and prints the reinstall command** rather than guessing a
ring.

---

## 1 · Always on `next`, as the plain `wego`

For someone who wants the release candidate as their everyday CLI. Same command
name, same directory, same login — only the ring differs:

```bash
curl -fsSL 'https://docs.wego.com/cli/install?ring=next' | bash
```

Because the config directory does not depend on the ring, **you stay logged in and
keep your settings**. From then on `wego update` follows `next`.

Re-read [what each ring promises](#what-each-ring-promises) before you do this.
`next` carries no backward-compatibility guarantee, so it is a choice for a machine
where you are the one reading the output — not for one running CI or an agent.

`edge` works the same way (`?ring=edge`), but understand what you are asking for:
it rebuilds on every merge to `main`, its versions look like `1.2.8-edge.<sha>`,
and for a prerelease ring the update test is "different from what you are running",
not "newer" — a git sha carries no chronological order, so comparing for "greater"
would announce about half of all edge builds and occasionally call a rollback an
upgrade.

---

## 2 · Switching an install from one ring to another

Reinstalling **is** the switch. It rewrites the binary and the ring record
together, so they can never disagree:

```bash
curl -fsSL 'https://docs.wego.com/cli/install?ring=edge' | bash   # onto edge
curl -fsSL 'https://docs.wego.com/cli/install?ring=next' | bash   # onto next
curl -fsSL  https://docs.wego.com/cli/install          | bash     # back to stable
```

There is deliberately no `wego ring` command: the record is written by the one
operation that also replaces the bytes. Your login, settings and telemetry choice
survive every switch, because none of them are the ring's to own.

---

## 3 · Two or three rings side by side

You want this if you develop the CLI and also use it. **One install per machine
needs none of it.**

Each install needs its own config directory, and `XDG_CONFIG_HOME` is the whole
mechanism. Keep one install as the normal one (section 0 or 1), and add the others:

```bash
for ring in next edge; do
  root="$HOME/.wego/$ring"

  # The binary and its whole config directory, kept to themselves.
  XDG_CONFIG_HOME="$root/config" \
  WEGO_CLI_INSTALL_DIR="$root/bin" \
  WEGO_CLI_INSTALL_SKILL=0 \
    sh -c "curl -fsSL 'https://docs.wego.com/cli/install?ring=$ring' | sh"

  # A launcher on your PATH, so you never have to remember the variables.
  mkdir -p "$HOME/.local/bin"
  printf '#!/bin/sh\nexec env XDG_CONFIG_HOME=%s WEGO_CLI_NO_UPDATE_NOTICE=1 "%s" "$@"\n' \
    "$root/config" "$root/bin/wego" > "$HOME/.local/bin/wego-$ring"
  chmod +x "$HOME/.local/bin/wego-$ring"
done
```

Use them by name, and update each one independently:

```bash
wego update          # your normal install, from its ring
wego-next update     # only the next install, from next
wego-edge update     # only the edge install, from edge
```

`wego-edge update` reads `~/.wego/edge/config/wego/install.json`, fetches from the
`edge` pointer, verifies the checksum, and replaces `~/.wego/edge/bin/wego` — the
exact file the launcher points at. Your other installs are untouched.

On disk:

```
~/.config/wego/            ← your normal install: ring record, login, settings
~/.wego/next/bin/wego      ← the next binary
~/.wego/next/config/wego/  ← and its own ring record, login, settings, telemetry
~/.wego/edge/bin/wego
~/.wego/edge/config/wego/
~/.local/bin/wego-next     ← the launchers you actually type
~/.local/bin/wego-edge
```

Five things to know:

- **Leave `WEGO_CLI_BIN` alone.** Each binary keeps its default name, `wego`,
  inside its own directory; the launcher supplies the name you type. Renaming the
  binary instead files the installer's record under `<root>/<that name>/` while the
  binary reads `<root>/wego/` — so the install comes up with no ring record and
  `update` refuses.
- **Always go through the launcher.** Running `~/.wego/edge/bin/wego` directly,
  with no `XDG_CONFIG_HOME`, makes it read your *normal* install's record — so
  `update` would pull that ring's build into your edge binary, checksum-clean and
  silent.
- **Each install logs in separately.** Each owns its own `credentials.json`. That
  is what a genuinely separate install costs.
- **The launcher silences the update notice**, because the notice is built from the
  binary's name on disk — which is `wego` here. Left on, it would correctly notice a
  newer `edge` build and then tell you to run `wego update -y`, which updates your
  *normal* install and leaves the edge one stale while looking like it worked. Ask
  on demand with `wego-edge update --check` instead.
- **The agent skill is shared** — see section 5.

---

## 4 · Knowing what you actually have

With more than one install this is the command you will want most:

```bash
$ wego-next update --check
Already up to date (1.2.7, ring next).
```

It is read-only and names both the version and the ring, resolved from *that*
install's own record. Run it through each launcher to get the full picture.

Without `--check`, the confirm names the exact file it is about to replace, which is
the quickest way to prove a launcher points where you think:

```
Update wego from ring next now? This replaces /Users/you/.wego/next/bin/wego.
```

The record itself is plain JSON if you would rather read it directly:

```bash
cat ~/.config/wego/install.json                 # your normal install
cat ~/.wego/edge/config/wego/install.json       # the edge one
```

`wego info target` answers a *different* question — which **backend** this run talks
to (`prod` or `staging`) — not which ring the binary came from. The two axes are
independent.

---

## 5 · The agent skill, when you have more than one install

The skill is written under `$HOME` — `~/.claude/skills/wego`, plus any other agent
directory the CLI detects — so **the config root does not isolate it**. All your
installs share one skill file, and the last writer wins.

Two things write it: `wego skill install`, and `update`, which re-installs the skill
from the binary it just swapped in. `WEGO_CLI_INSTALL_SKILL=0` in the section 3
recipe covers the install step, not the update step.

The body names `wego` throughout, so by default your agent drives your *normal*
install whichever install wrote the file. What differs is which build's commands the
file describes — an `edge` body can document a subcommand your `stable` binary does
not have.

If the install you actually work in is `wego-edge`, say so in the skill:

```bash
perl -pi -e 's/\bwego (?=[a-z<])/wego-edge /g' ~/.claude/skills/wego/SKILL.md
```

Then fix the two places a rename cannot repair — the installer URL in rule 1 and the
`curl … | bash` block in rule 2. Both describe a fresh single install, and on this
machine running that installer would replace your `wego` with a different ring. The
honest instruction there is to ask you to reinstall rather than to install anything.

Your edit then sticks: a modified body reads as a local modification, and every
unattended writer stands down rather than destroy it. The cost is that it also stops
picking up new command documentation — to take a newer body, run `wego-edge skill
install --force` and redo the two steps. A foreground `wego skill install` that you
type still overwrites, and tells you it replaced something it had not written.

---

## 6 · Uninstalling

`wego uninstall` removes the binary it is run from, that install's login and
settings, its own bookkeeping (ring record, update throttle, session, diagnostics),
and the user-scope agent skill.

```bash
wego uninstall                       # confirms first
wego uninstall -y                    # no confirm
wego uninstall --keep-credentials    # keep the login
wego uninstall --keep-skill          # keep ~/.claude/skills/wego
```

**One extra ring, leaving the rest alone:**

```bash
wego-edge uninstall --keep-skill     # keep the shared skill for your other installs
rm -rf ~/.wego/edge                  # the binary's directory and its config
rm -f  ~/.local/bin/wego-edge        # the launcher — uninstall cannot remove this
```

`--keep-skill` matters here. Without it, uninstalling *one* install removes the skill
that every install shares. And `uninstall` only knows the binary it is running from,
so the launcher on your PATH is yours to delete.

**The normal install:**

```bash
wego uninstall
```

**Everything:**

```bash
wego-next uninstall -y --keep-skill
wego-edge uninstall -y --keep-skill
rm -rf ~/.wego ~/.local/bin/wego-next ~/.local/bin/wego-edge
wego uninstall -y                    # last, so it takes the shared skill with it
```

What survives on purpose: **`telemetry.json`, but only when it records an explicit
opt-out** — so that reinstalling never silently turns telemetry back on. Everything
else in that install's directory goes.

Not touched: a project-scope or `--dir` skill install. Remove those with
`wego skill uninstall --scope project` or `--dir PATH`.

---

## 7 · Migrating a side-by-side setup built the old way

CLI releases up to 1.2.7 keyed the config directory to the **command name**, so a
setup built with `WEGO_CLI_BIN=wego-next` kept its state in `~/.config/wego-next/`.
From the next release the directory is always `<root>/wego/`.

An install like that upgrades once normally and then reads the wrong place:

- if you also have a plain `wego` install, the renamed one starts following **that**
  install's ring — checksum-clean, no error;
- if you don't, there is no record where it now looks, so `update` refuses, names the
  file and prints the reinstall command.

Either way it comes up logged out, and a telemetry opt-out recorded under the old
directory is not carried across.

Rebuild those installs with section 3, then clear the old ones:

```bash
rm -rf ~/.config/wego-next ~/.config/wego-edge
rm -f  ~/.local/bin/wego-next ~/.local/bin/wego-edge
```

An install named plainly `wego` is unaffected — its path is the same under both
rules.

---

## 8 · CI, containers and non-interactive shells

```bash
WEGO_CLI_INSTALL_SKILL=0 \
  sh -c "curl -fsSL https://docs.wego.com/cli/install | sh"
```

- `WEGO_CLI_INSTALL_SKILL=0` skips the agent-skill step, which has nothing to offer
  a build agent.
- `WEGO_CLI_NO_UPDATE_NOTICE=1` silences the "a newer version exists" notice, so an
  image that must stay off the network makes no update check at all.
- `wego update -y` skips the confirm; there is no TTY to answer it.
- `wego login` needs a browser on the machine running the CLI. In CI, carry
  credentials rather than logging in — `WEGO_CREDENTIALS_PATH` names the token file
  directly.

---

## When `update` will not do it

| It says | Why, and what to do |
| --- | --- |
| no release ring recorded at `<path>` | The install has no record — a pre-ring install, or a renamed one reading the wrong directory. It prints the reinstall command; run that. |
| cannot write `<path>` (permission denied) | The binary is somewhere you don't own. Reinstall into a directory you do, or re-run with write access to that path. |
| cannot replace `<path>` across filesystems | The atomic swap needs the temp file on the same filesystem as the binary. Reinstall instead. |
| Self-update isn't supported on Windows | A running `.exe` can't overwrite itself. It prints the asset URL; download and replace the file by hand. The `curl \| sh` installer is POSIX-only for the same reason. |

**Pinning a specific version is not supported.** The ring is the only selector the
installer takes — by design, since the point of a ring is that it moves. If you need
a fixed version, keep the binary you have and don't run `update`.
