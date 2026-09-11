# CLI telemetry

The published `wego` binary records **one event per invocation** and posts it to
PostHog. This page is the complete list of what it sends, why, and how to turn it
off. It is the disclosure: there is no first-run notice.

## Turning it off

| How | Effect |
|---|---|
| `wego telemetry disable` | persists the choice; survives a new shell and a reboot |
| `WEGO_CLI_TELEMETRY=0` | off for that run; also `false`, `off`, `no` |
| `WEGO_CLI_TELEMETRY=log` | builds the payload, prints it to **stderr**, sends nothing |

The environment variable always wins over the stored setting, so a one-off
`WEGO_CLI_TELEMETRY=0 wego …` is reliable. An unrecognized value is treated as
**off**: an operator who writes `=disabled` clearly meant to disable it.

`log` works even while telemetry is disabled, and even from source, because it
exists so you can check these claims instead of trusting them.

**`DO_NOT_TRACK` is not consulted.** Real adoption of that convention is patchy
(gh and the Supabase CLI honor it; Homebrew explicitly declined it in favor of its
own variable, and Next.js never adopted it), so a single documented control is
more honest than a second one that only sometimes appears. Saying so here is the
point: silence would let you assume otherwise.

## Every field

| Field | Example | Why |
|---|---|---|
| `command` | `flights` | which commands to invest in, and which to remove |
| `subcommand` | `search` | same, one level down. Allowlisted per command, never a bare positional |
| `flags` | `["--wait","--sort"]` | stop maintaining flags nobody passes |
| `arg_*` | `arg_sort: "price_asc"` | values for a small whitelist of enum and count flags only |
| `exit_code` | `4` | which commands fail, and how |
| `duration_ms` | `1830` | which commands feel slow |
| `version` | `0.4.1` | how long a release takes to reach the installed base |
| `os` / `arch` | `darwin` / `arm64` | which build targets to keep |
| `device_id` | a random uuid | per-machine questions, without being the person key. `ephemeral` when the id cannot be stored (read-only `$HOME`), so such runs share one bucket instead of looking like a new machine each time |
| `$session_id` | a random uuid | groups the commands of one working stretch, and is the same id the API's own events carry — see [The session id](#the-session-id) |

Six fields were considered and deliberately left out. `logged_in` is redundant:
`distinct_id` equal to `device_id` means the run was logged out, and those events
also carry `$process_person_profile: false`. `sample_rate` is pointless while
nothing is sampled, since every event predating any future sampling is
unambiguously unsampled. `flavor` would be a constant, because only a prod binary
ever emits. `emitter` is redundant with the event name, which no other Wego
application uses. `invocation_id` did nothing: PostHog de-duplicates on
`$insert_id`, not on an arbitrary property, and two identical runs are stored as
two events regardless. And `is_tty` / `ci` are not collected at all, so **nothing
records whether you ran the command yourself or a script did**.

Run `WEGO_CLI_TELEMETRY=log wego <your command>` to see the exact payload for any
invocation.

## What it never sends

No free text, ever. That is enforced by allowlists rather than by review:

- **Command names** are matched against the known set. An unrecognized command
  records as `unknown`, so a typo or a pasted secret in the command slot never
  becomes a property.
- **Subcommands** are matched against a per-command allowlist. `places` has none,
  because its first positional is your search query.
- **Flag names** are recorded only if they are flags the CLI actually accepts, so
  an unknown or injected `--<anything>` is dropped.
- **Flag values** are recorded for a much smaller whitelist of enumerations and
  counts, and each value is itself validated. Anything out of shape records as
  `invalid` rather than passing through.
- **`--message` is never captured**, which matters most: people put booking
  references and email addresses in feedback.
- **Trip content is never captured**: origin, destination, dates, currency, site,
  locale, hotel and rate ids. The API already records what it executed.

Your **email is never sent**. Identity comes from the access token's numeric `uid`
claim, never from `sub`, which is where the email lives. A `uid` that is not
all digits is discarded rather than used.

## Identity

| State | `distinct_id` | Person profile |
|---|---|---|
| logged in | your account's numeric `uid` | yes, a real person |
| logged out | the random `device_id` | no, anonymous tier |

Because a logged-out run creates no person, nothing needs to be aliased when you
later log in, which is the usual source of double-counted users.

For a logged-in user this telemetry is therefore **not anonymous**, by design: the
whole point of sharing a project with the API's events is to follow one person from
the command they typed to the request the API served. `device_id` is present as a
property on every event either way.

## The session id

A single task spans several commands — a search, then a trip, then a booking
link — and each one is a separate process. The session id is what ties them back
together, so a funnel can ask whether a search ever reached a booking link.

It lives in `~/.config/<scope>/session.json` (or under `$XDG_CONFIG_HOME`),
owner-only, beside the other local state. A new id is minted after **30 minutes**
of inactivity, or once the current one is **24 hours** old — the same bounds
PostHog's own web sessions use. A clock that jumps backwards also starts a new
session, rather than holding one open indefinitely.

**Up to seven headers go to `apps/api` on an authenticated resource request**,
and they follow different rules, which is worth stating plainly:

| Header | Value | Follows the telemetry opt-out? | Always sent? |
|---|---|---|---|
| `X-Wego-Session-Id` | the session id above | **No** | only a well-formed uuid |
| `X-Wego-Client-Id` | the `device_id` | **Yes** | only when consented, and a uuid |
| `X-Wego-App-Version` | the baked build version | **No** | yes |
| `X-Wego-Os-Type` | `OSX`, `LINUX` or `WINDOWS` | **No** | only a platform we publish for |
| `X-Wego-Os-Version` | `os.release()`, the kernel release | **No** | yes |
| `X-Wego-Timezone` | this machine's UTC offset, `±HH:MM` | **No** | yes |
| `X-Wego-Id-Token` | the stored id_token, as an identity assertion | **Yes** | only when consented, stored, and inside the API's expiry tolerance |

"Follows the opt-out" means both forms of it: the stored `wego telemetry disable`
setting **and** `WEGO_CLI_TELEMETRY=0` (or `=log`), which always wins over the
stored one.

"Every request" means every call through `src/api.ts`, which is every authenticated
`/v1` read and write the commands make. It is not every byte this binary fetches:
`update` reads its checksums and downloads its asset from the release store, and
the installer fetches `GET /install`, each through its own `fetch`. Those carry
none of these headers.

The session header is not gated, deliberately. The API records its own events for
every authenticated request whether or not this binary sends anything, so
withholding the header would not remove a single event — it would only make the
ones already being stored harder to group. There is no privacy to be gained by
suppressing it, so it is sent, and documented here instead of being quiet about
it. The `device_id` is different: it is telemetry state this binary minted and
stores, so an opt-out does withhold it.

The two ids are sent only when they are well-formed uuids; anything else is
dropped rather than sent for the API to reject.

The id_token follows the opt-out, on both of the tests the session id fails. It
removes data rather than making stored data harder to read: the identity hashes it
carries reach `apps/api` from nowhere else, so withholding it withholds them. And
it is state this binary stores, like the `device_id` and unlike the build triple.

It is an assertion, never a credential. `apps/api` verifies its signature against
the same JWKS as the bearer and rejects it unless its `sub` equals the access
token's, so it can only ever name the caller's own identity. The bearer remains
the only thing that authorizes anything. The token carries the user's email, which
`apps/api` already receives as the bearer's own `sub`, plus their name and country
code; none of it goes to a telemetry sink, so "your email address is never sent"
stays true as written. Only the hashes are read off it.

The build triple is not gated either, for the same reason the session id is not:
the API records its own events for every authenticated request regardless, so
withholding these would not remove an event, only leave the one already stored
unable to say which build produced it. They are also not state this binary minted
and stores, the way the `device_id` is. They describe the running binary, and the
same three values are already legible from the `User-Agent` and the platform
build a user downloaded. The API validates each one on arrival and drops it
alone if it fails, so a rejected os type never costs the version beside it. The
os type is a closed set, and it carries Genzo's vocabulary rather than Node's:
`darwin` is sent as `OSX`, `linux` as `LINUX`, `win32` as `WINDOWS`. A platform
we publish no binary for sends no header rather than a raw platform token.

`X-Wego-Timezone` rides on the same terms. It is this machine's UTC offset as
`±HH:MM`, computed per request from the system clock, and it is the one thing in
the request only the caller can state: the API sees Cloudflare's country, the
Vercel region and its own clock, and none of those is where the user is. Nothing
about it is stored – it is not written to `settings.json` or `telemetry.json`,
and it is not gated by the opt-out, for the same reason the build triple is not.
Reading it per request rather than once at import is deliberate, so a session
alive across a daylight-saving change reports the offset it is actually in.

**The session header, the build triple and the offset are sent from source and
from a staging binary too**, unlike everything else on this page, because they are not telemetry
and do not depend on the baked PostHog key. A source run reports the version it
has, `0.0.0-dev`, rather than suppressing the header. The `device_id` header is
nearly the opposite: neither a source nor a staging run ever mints one. A source run does share `~/.config/wego/` with an
installed prod binary, though, so when that binary has already stored a `device_id`
and telemetry is on, the source run sends it.

To stop the CLI touching `$HOME` for this at all, set **`WEGO_CLI_NO_SESSION`**
(read liberally, like the other `WEGO_CLI_NO_*` switches). No session file is
written and no session header is sent.

`logout` deletes the session file, so the next user does not inherit it, and
`wego uninstall` removes it outright — unlike `telemetry.json`, it carries no
opt-out worth preserving.

Concurrent commands are handled: a new session is published with an atomic
create, so several agents starting at once adopt one id rather than each minting
their own. Replacing an expired session takes a lock built on the same primitive,
so one starter replaces it and the rest adopt what it wrote. A filesystem without
hard links, or a run killed while holding the lock, can still produce two
sessions for one stretch; nothing else breaks, and the next command settles it.

## When it does not send at all

- **From source.** A dev checkout and the test suite never emit, guarded twice:
  no key is baked, and an explicit from-source check.
- **From a staging binary.** No key is baked into it.
- **On a non-prod target.** `--target staging` / `--target local` (or
  `WEGO_TARGET`) suppresses the event outright, on any binary including a prod
  one — a test run is not usage, and counting it would make the numbers stop
  describing users. The **target** is what suppresses it, not the endpoint:
  pointing `WEGO_API_URL` at staging without naming a target still emits, because
  the CLI cannot tell that apart from a user with an unusual base URL. The guard
  sits above every other silent check but deliberately below `log`, so
  `WEGO_CLI_TELEMETRY=log` still prints the payload it is not sending.
  `wego info target` reports the suppression as `telemetrySuppressed`.
- **Before the key is configured.** A release cut without it builds and runs
  normally, and is simply silent.
- **On Ctrl-C.** The interrupt stays immediate.
- **When disabled.** No request is attempted, and no file is written.

## Local state

`~/.config/<scope>/telemetry.json` (or under `$XDG_CONFIG_HOME`), owner-only,
holding the machine id and the stored setting. `session.json` sits beside it and
is described above; it is a separate file precisely because this one fails closed
when unreadable, and a session write must never be able to flip that setting.

It is deliberately **not** part of `credentials.json`: `logout` deletes that file,
and a machine id living there would be reborn on every logout, inflating device
counts forever. So `logout` leaves this file alone.

`wego uninstall` removes it, **except** when it records an explicit opt-out, which
is kept so that reinstalling does not silently turn telemetry back on.

Nothing is written until the first run that actually emits. A disabled run, and
`log` mode, leave no trace on disk.

Reads **fail closed**. A missing file means on by default, but a file that exists
and cannot be read or parsed is treated as opted out, because it may hold your
opt-out. Writes go to a temporary file and are renamed into place, so an
interrupted run cannot leave a half-written setting.

One race is known and accepted. The machine id is written at most once per
machine, on the first run that emits, and that write preserves the current
setting. If you ran `wego telemetry disable` from another shell in the
sub-millisecond window before that write completed, it could be overwritten and
telemetry would stay on. `wego telemetry status` shows the real state, and
running `disable` again fixes it permanently, because the id is already stored
and that write never happens again.

## Delivery, and why it costs you nothing

A round trip to PostHog measures around 750ms from Singapore (TLS alone around
500ms). A complete run of the compiled binary measures around 20ms. So the parent
process hands the payload to a **detached child** of itself, ignores all three of
its streams, unrefs it and exits. Verified: the child outlives the parent and
completes its POST about 400ms later.

Two shortcuts do not work, and were measured rather than assumed. `fetch` with
`keepalive` followed by `process.exit()` loses the payload entirely in this
runtime. Setting the exit code and letting the event loop drain does deliver, but
takes exactly as long as waiting.

Neither the key nor the payload is passed on the command line, so **nothing about
the event is visible in `ps`** to other users on a shared machine: the child
re-derives the key from its own baked copy, and the payload arrives on its stdin.
The child also re-derives the identity from your credentials and state file,
ignoring whatever the payload claims, so running `wego send-telemetry` by hand
cannot attribute events to another account. One attempt, no retry. A blocked
endpoint changes nothing about your command.

`wego uninstall` is the one command that cannot use a detached child, because it
deletes the binary that would do the sending. It waits inline for that one event
instead, and its identity is read before the teardown so the event still says which
machine and account it came from without recreating the file uninstall just
removed.

Windows waits inline on a short deadline instead, because the detach behavior was
verified on macOS only.

## The ingestion key

The binary carries a PostHog **project** key (`phc_…`). It can create events and
can read nothing: not events, not persons, not anything else in the project. That
is what makes shipping it inside a public binary a non-disclosure rather than a
leak. `scripts/release-config.ts` refuses to bake anything that is not shaped like
one, so a read-capable personal key (`phx_…`) fails the build.

The consequence we accept: anyone who extracts the key can post events into the
project. The event name `cli_command_ran` is used by no other Wego application, so
unwanted events stay identifiable, excludable from any insight, and filterable at
ingestion by name.

## Where the events go

PostHog project `521561`, the same project that receives the `apps/api` funnel
events. PostHog cannot join across projects, so a separate one would split a single
person in two and permanently prevent following them from command to request.

Design record and the decisions behind all of the above: issue #1302.
