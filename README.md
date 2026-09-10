# `wego` CLI

The `wego` command is a public + PKCE OAuth client: it logs you in with
`auth.wego.com` and drives [`apps/api`](../api/) as you. One binary serves every
backend – `--target prod|staging|local` picks it at run time.

```sh
curl -fsSL https://docs.wego.com/cli/install | bash
wego login
```

Contributor docs live in [`AGENTS.md`](AGENTS.md); the release machinery is in
[`docs/publish-pipeline.md`](docs/publish-pipeline.md).

## Release channels

Three moving pointers, each holding a different build:

| Channel | Holds | Advanced by | Who runs it |
|---|---|---|---|
| `stable` | plain `X.Y.Z` | `promote-cli.yml`, a human decision | everyone (the default) |
| `next` | plain `X.Y.Z` | `release-cli.yml`, every release | anyone who wants the candidate early |
| `edge` | `X.Y.Z-edge.<sha>` | `edge-cli.yml`, every merge to `main` | dogfooding unreleased `main` |

`next` and `stable` serve **byte-identical** builds for a given version – a
promote is a pointer move, never a rebuild – so `next` just means you see a
release before the `stable` population does. `edge` is a genuinely separate
line: a different build of unreleased `main`, a different version shape, and a
different signing identity: `identitiesForRing("edge")` returns the edge
signing identity alone, while `next` and `stable` return the release ones – so
a record produced by the edge lane cannot vouch for a release channel, or the
other way round.

### Which backend each channel talks to

**The channel decides which build you get, never which backend it talks to.**
All three rings serve the same production-baked binary, so whichever one you
install from, you log in and read inventory against production:

| Channel | Login (auth) | API | Notes |
|---|---|---|---|
| `stable` | `auth.wego.com` | `api.wego.com` | production, real bookings |
| `next` | `auth.wego.com` | `api.wego.com` | production, real bookings |
| `edge` | `auth.wego.com` | `api.wego.com` | production, real bookings |

The backend is a **run-time** choice instead, `--target` (or `WEGO_TARGET`),
available on every channel and defaulting to production:

| `--target` | Login (auth) | API | Credentials kept at |
|---|---|---|---|
| `prod` (default) | `auth.wego.com` | `api.wego.com` | `<config>/` |
| `staging` | `auth.wegostaging.com` | `api.wegostaging.com` | `<config>/auth.wegostaging.com/` |
| `local` | `auth.wegostaging.com` | `WEGO_API_URL`, and only a host on this machine | `<config>/auth.wegostaging.com/` |

`<config>` above is `$XDG_CONFIG_HOME` (or `~/.config`) then **the command name** –
`wego`, `wego-next`, `wego-edge` – the same directory the channel record lives in,
so a target adds a leaf inside this install's own directory rather than a second
one beside it. The full endpoints are
`https://<auth-host>/user-auth/v2/users/oauth/authorize` and `.../token`; the
public PKCE `client_id` is the same literal in both environments, so only the host
differs.

Three consequences worth knowing:

- **A staging login cannot touch your production session.** Credentials are keyed
  by the auth host that issued them, so you can hold both at once, and a `logout`
  on one leaves the other signed in. `staging` and `local` share one login, since
  they share one issuer – a local `apps/api` verifies staging tokens.
- **A typo is fatal, not a silent fall back to production.** An unknown value, or
  `--target` with nothing after it, exits 2. `local` additionally **refuses** a
  `WEGO_API_URL` that is not a host on this machine rather than adopting it, so it
  can never report `local` while talking to `api.wego.com`.
- **The host you install FROM is a third, independent thing.** `curl -fsSL
  https://api.wegostaging.com/install | bash` gives you the same binary as the
  production installer – the staging deploy is just another place the release is
  served from. It does not make the installed CLI a staging CLI; `--target` does.
  A non-production target also sends no usage event at all.

Install from a named channel with `?ring=`:

```sh
curl -fsSL "https://docs.wego.com/cli/install?ring=edge" | bash
```

The installer bakes `&ring=edge` into every download it makes and records the
channel at `<config>/install.json` – under the name it installed the command as,
which is where that command reads it back from. For a default install that is
`~/.config/wego/install.json`; a `WEGO_CLI_BIN=wego-next` install records its
channel at `~/.config/wego-next/install.json` instead. `wego update` reads that
record and fetches from that pointer, comparing **checksums, not versions** – so
an install stays on its channel and can never silently drift onto another. An unknown
channel name is a `400`, and an install with no record refuses to update rather
than guessing.

### Switching one install

Reinstalling is the switch – it rewrites the binary and the record together:

```sh
curl -fsSL "https://docs.wego.com/cli/install?ring=edge" | bash    # onto edge
curl -fsSL "https://docs.wego.com/cli/install" | bash              # back to stable
```

There is no `wego ring` command, by design: the record is written by the one
operation that also replaces the bytes.

## Running all three channels side by side

One command per channel, and the only thing you choose is what the command is
called:

```sh
# stable, as the plain `wego`
curl -fsSL https://docs.wego.com/cli/install | bash

# next and edge, alongside it, under their own names
for ring in next edge; do
  WEGO_CLI_BIN="wego-$ring" WEGO_CLI_INSTALL_SKILL=0 \
    sh -c "curl -fsSL 'https://docs.wego.com/cli/install?ring=$ring' | sh"
done
```

That is the whole setup. No wrapper scripts, no `XDG_CONFIG_HOME`, nothing new in
`$HOME`:

| Channel | Command | Binary | Its own config |
|---|---|---|---|
| `stable` | `wego` | `~/.local/bin/wego` | `~/.config/wego/` |
| `next` | `wego-next` | `~/.local/bin/wego-next` | `~/.config/wego-next/` |
| `edge` | `wego-edge` | `~/.local/bin/wego-edge` | `~/.config/wego-edge/` |

### Why naming the command is enough

**The command name is the install's identity.** Every per-install file – the
channel record, credentials, settings, telemetry – lives under
`~/.config/<the name you invoked>/`, so naming a second install is the entire act
of isolating it. `wego-next login` cannot touch your `wego` session, and
`wego-next update` follows `next` because that is what its own record says.

It used to key on the baked **flavor** instead, which made a rename cosmetic:
three differently-named binaries shared one `~/.config/wego/install.json`, the
last install written won that record, and every other install's `update` then
pulled from a channel nobody chose – checksum-clean and invisible, because
`update` compares checksums rather than versions. Getting real isolation took a
second, coupled knob (`XDG_CONFIG_HOME`) plus a wrapper script per channel to
re-supply it at run time, i.e. three mechanisms for something the user had already
said once by naming the command.

Two consequences worth knowing:

- **A symlink is not a second install.** The scope comes from the real file on
  disk (`process.execPath` resolves links), so `ln -s wego wego-next` gives you a
  second name onto one install, sharing one config. Install a second binary.
- **`WEGO_CLI_INSTALL_SKILL=0` above is about the agent skill, not isolation.**
  The skill lives under `$HOME`, one channel owns it, and the installer would
  otherwise hand ownership to whichever channel you installed last – see
  [what splits, and what does not](#what-splits-and-what-does-not).

> **Upgrading an older side-by-side setup.** If you built one out of
> `XDG_CONFIG_HOME` and wrappers, its files sit in the old flavor-keyed directory.
> An install that lands there refuses to self-update and names the directory to
> move (`update` prints it) – move it across to keep the login and preferences, or
> just reinstall with the command above and log in again. Installs named plainly
> `wego` are unaffected: their path is the same under both rules.


### The update notice follows your channel

`wego update` and the proactive "a new wego is available" notice read the same
channel: the one the installer recorded. Both resolve it from this install's own
`~/.config/<command>/install.json` through the same helper, so they cannot
disagree about which channel an install is on. An `edge` install is told about newer
`edge` builds, a `next` install about newer `next` builds.

Two details worth knowing, because they are not what a version comparison would
do on its own:

- **On a prerelease channel the test is "different", not "newer".** Semver orders
  prerelease identifiers lexically, and a git sha carries no chronological order
  at all – `0.7.2-edge.4aeec3a2f` really is the successor of
  `0.7.2-edge.e30454f2a` and sorts below it. Asking "is it greater" there would
  announce roughly half of new edge builds and occasionally call a rollback an
  upgrade, so `edge` compares against what you are running instead.
- **The command the notice names is the command you type.** It is built from the
  binary's own name on disk, which is also what scopes that install's config – so
  an `edge` install is told to run `wego-edge update -y`, and running exactly that
  updates exactly that install. One name, one config directory, one channel: there
  is nothing to translate.

**No record, no notice.** Nothing compiles a channel into a binary any more, so
the record is the only statement of which channel an install follows – and when
it cannot be read, the notice says nothing rather than guessing. That covers a
missing file, a corrupted or truncated one, and one written by a newer CLI whose
schema this binary predates. Guessing would mean measuring the install against a
channel it may not be on: an `edge` machine compared against `stable`, and nagged
to "update" to a version `update` then refuses to install.

`update` answers the same way, and says more about it: it refuses outright,
names the record file, and prints the reinstall command. So if the notice has
gone quiet, `wego update --check` is what tells you why.

`WEGO_CLI_NO_UPDATE_NOTICE=1` turns the notice off entirely, for CI images and
containers that must stay off the network.

### Logins are split by the same mechanism

`credentials.json` sits under the same per-command directory, so each channel
logs in separately and holds its own tokens:

```sh
wego login
wego-edge login
```

A `logout` on one leaves the others signed in, and a 401 on one cannot reach
another. `wego info target` prints the `credentialsPath` an install is actually
using, which is the quickest way to confirm the isolation took:

```
$ wego-edge info target --json | grep credentialsPath
"credentialsPath": "/Users/you/.config/wego-edge/credentials.json"
```

If you want the tokens split but nothing else, `WEGO_CREDENTIALS_PATH` names the
file directly – but note it names a **file**, so it moves credentials only and
leaves everything else where it was. For separate installs, the command name
already does the whole job.

### What splits, and what does not

Everything below sits under `~/.config/<command>/` – `wego`, `wego-next`,
`wego-edge` – except the last row.

| State | File | Split per channel? |
|---|---|---|
| Channel record | `install.json` | yes |
| Credentials | `credentials.json` | yes |
| Settings (currency, site, locale) | `settings.json` | yes |
| Update-notice throttle | `.update-check` | yes |
| Telemetry id and opt-out | `telemetry.json` | yes – so opt out in each |
| Agent skill | `~/.claude/skills/wego/SKILL.md` | **no** – one channel owns it |

The agent skill is the one exception: it is written under `$HOME` rather than
the per-command directory, so all three channels share one file. That is usually what you
want – one `wego` skill for your agent – so instead of splitting it, **one
channel owns it**. The ownership marker records which channel wrote the skill,
and a channel that does not own it leaves it alone: its background refresh
stands down rather than overwriting. Without that, the last install to run would
silently win, and an `edge` install could hand your agent a skill describing
commands the `stable` binary it actually drives does not have.

Ownership moves only when you say so: `skill install` re-stamps the marker with
the running install's channel. So to point your agent at the edge skill, run
`wego-edge skill install`; to hand it back, run `wego skill install`. An install
whose marker names no channel at all (one made before this existed) keeps the
old behaviour.

## Environment

Install-time, read by the `curl | sh` installer:

| Variable | Effect |
|---|---|
| `WEGO_CLI_BIN` | Command name to install as (default: the flavor, `wego`). Bare name, no `/` or `..`. **This is also the install's config directory**, so a second install needs nothing else to be independent. |
| `WEGO_CLI_INSTALL_DIR` | Where to write it (default `~/.local/bin`). Created if missing. |
| `WEGO_CLI_INSTALL_SKILL` | `0` skips the post-install `skill install`, so this install does not take agent-skill ownership. |
| `WEGO_CLI_FLAVOR` | `wego` or `wegostaging`. Picks which published asset is downloaded; it does not change which backend the binary talks to, and no longer names the config directory (`WEGO_CLI_BIN` does). |
| `XDG_CONFIG_HOME` | The root the per-command config directory is created under (default `~/.config`). Rarely needed now: separate installs are separated by name. |

Run-time, read by the binary – see `wego --help` for the full list:

| Variable | Effect |
|---|---|
| `XDG_CONFIG_HOME` | The root under which this install's `<command>/` directory holds its channel record, credentials, settings and telemetry (default `~/.config`). |
| `WEGO_TARGET` | `prod` (default), `staging` or `local`; `--target` wins over it. |
| `WEGO_CREDENTIALS_PATH` | Token file path, overriding the config root for credentials only. |
| `WEGO_CLI_TELEMETRY` | `off`, `on`, or `log` to print the payload and send nothing. |
