# Travel settings: currency, site, locale

`~/.config/<scope>/settings.json`, written and read by `wego config`. Issue #1386.

## Why the file exists

Currency and market both change the numbers a traveller is shown, and before this
file both were decided invisibly:

- `--currency` was a per-request repricing flag with a server-side USD default,
  and **it does not stick**: a search created in SAR read back in USD. Measured on
  prod: `flights results … --currency SAR` → cheapest 216 SAR; the same read with
  the flag omitted → 58 USD, same 39 candidates. The ratio is exactly the riyal
  peg, so nothing about either number looks wrong in isolation.
- The market was already a preference, but it lived inside `credentials.json`
  (`market`, decoded from the `id_token`), with no file a user could read and no
  command that printed it.

The failure that produces is not an error. Every call succeeds, every exit code is
0, and an agent that quotes 216 and then 58 tells a traveller the price dropped by
three quarters. The file does not add a preference layer, it makes the one that
already existed visible and user-owned.

## Precedence

```
--currency / --site / --locale on this command   (source: explicit)
  >  settings.json                               (source: setting)
  >  the account market from the id_token        (source: account – site only)
  >  the API default: USD, en, and the US floor  (source: default)
```

`wego config list` prints all three values with the source that decided each, plus
the file path. That command is not optional garnish: without it the change would
trade a silent server default for a silent local file, and support becomes "works
on my machine".

**There is no env rung.** `--currency` / `--site` / `--locale` already give a
per-run override, and it is visible in the command line, which is where a
repricing decision belongs. A `WEGO_CLI_CURRENCY` doing the same job invisibly
would be the very failure mode this file removes.

`site` from the file **beats** the account market. A user whose Wego account says
`SG` but who buys from `SA` must be able to say so; the output reports
`siteCodeSource: "setting"`, so the market is never claimed silently.

The currency half is reported the same way, and for the same reason (issue #1400).
Every **priced** read prints a `currencyCodeSource` beside the `currencyCode` it
echoes, valued `explicit` | `setting` | `default`. Three rungs, not four: the
id_token carries a market but no currency, so there is no `account` rung to
report.

The eight priced reads are both `search`es, both `results` reads, `flights trip`,
`flights fares`, and both `hotels rooms` forms. A `searchId` carries no currency,
so **each read decides its own unit** – which is exactly why the label cannot stop
at the two `search`es. `trip` and `fares` are where a number is actually quoted,
and a label legible only at the step nobody quotes from is not legible at all.

The three link builders (`flights booking-link`, `flights share`,
`hotels booking-link`) are deliberately excluded: they publish no currency echo,
because there an absent currency means "leave it out of the built URL" rather than
"the API defaulted it".

Unlike the site pair, the source is emitted **unconditionally**. The site pair is
atomic because `siteCode` is the API's echo and a source without it would be an
orphan; `currencyCodeSource` labels what the CLI itself resolved and asked for, so
it stands on its own.

That label is **not** the API's `metadata.currencyCodeSource`, which those same
payloads carry on the wire since #1522, and the two must not be read as one field:

| Field | Answers | Vocabulary |
|---|---|---|
| `currencyCodeSource` (top level, the CLI's) | which layer of the chain above decided the currency | `explicit` \| `setting` \| `default` |
| `metadata.currencyCodeSource` (the API's) | did the API have to default this to USD | `explicit` \| `default` |

The API cannot tell the two top rungs apart: `applyPreferences` used to merge a
stored currency into the request body before it was sent, so from the API's side a
`settings.json` currency arrives as `explicit` and looks exactly like a flag. The
CLI therefore resolves the currency itself, inside the vertical, exactly as it
resolves `site` – which is why the two `search`es now inherit only `locale`
through `applyPreferences`. Its vocabulary is a **superset** of the API's:
`explicit` and `default` mean the same thing in both, and `setting` refines the
API's `explicit`. The create and its settle read still go out in the one resolved
currency, which is the invariant the merge-before-create was protecting.

Only the CLI's field reaches stdout. With a stored currency the two disagree by
construction (`setting` in the CLI's, `explicit` in the API's), so forwarding the
API's copy printed two answers to "who decided" on one payload – #1534 (decision
Q2: "strip") settled it: **CLI output publishes exactly one `*Source` per knob,
at top level, in the CLI's own vocabulary**, and `stripMetadataSources` in
`src/commands.ts` drops every request-scoped `*Source` copy from `metadata` at
print time. The `metadata.currencyCode` / `locale` / `siteCode` echoes themselves
are kept.

One subtlety the label does **not** claim. It names the rung the CLI **asked**
in – the value the API echoes back as `metadata.currencyCode`. A results read also
carries a **top-level** `currencyCode`, which is what the prices actually came back
in, and the two agree unless upstream declined to reprice. So `currencyCodeSource:
"setting"` beside a top-level `USD` reads "the stored currency was asked for and
upstream did not honour it", never "USD came from your setting" – compare it against
`metadata.currencyCode` when the digits look wrong for the unit.

There is deliberately **no `localeSource`** anywhere in CLI output. Locale
changes the language of the text, not the number, so nobody has to audit which
rung decided it – the CLI adds no locale rung of its own, and the API's
`metadata.localeSource` goes out with the rest of the stripped copies (#1400
established that; #1534 made it the rule for every `*Source`). The `locale` echo
itself is kept; only the source is withheld.

`live/transcript.ts` closes both CLI enums – `siteCodeSource` at four values,
`currencyCodeSource` at three – on every priced page, and its `noSourceKeys`
refinement fails any page whose `metadata` still carries a `*Source` key. Both
enums are TypeScript-only unions in `src/commands.ts`, so without that schema a
CLI that started forwarding the API's narrower answer would reach stdout with no
compile error and no red test.

That report is owed by **every** command a market can steer, not only the two
`search`es: the dates form of `hotels rooms` mints a search of its own, and
`info schedules` sends a resolved market too. The CLI stamps the source itself in
all four cases, always at top level: the API only sees whether a `siteCode`
arrived, so its own vocabulary is just `explicit | default` and it labels a
market the CLI read from `settings.json` as `explicit`. Only the CLI knows which
of the four layers decided, so only the CLI can keep the promise made above. On
`info schedules` the market itself stays where the API put it
(`metadata.siteCode`), while the API's `metadata.siteCodeSource` is stripped and
the CLI's four-rung answer is stamped at top level like every other knob.

## Which command inherits which key

The API is the constraint here, not preference: a command inherits a key only if
the endpoint behind it accepts one. Verified against the route schemas in
`apps/api/src/{flights,hotels,places,countries}/schema.ts` and against roxana, the
production web client on the same upstreams.

| Command | Inherits |
|---|---|
| `flights search`, `flights booking-link`, `flights share` | currency, locale, site |
| `flights results`, `flights trip`, `flights fares` | currency, locale |
| `hotels search` | currency, locale, site |
| `hotels rooms` | currency, locale always; **site only on the dates form** (positional, or `--check-in`/`--check-out`) |
| `hotels results` | currency, locale |
| `hotels booking-link` | locale, site |
| `hotels details`, `hotels reviews` | locale |
| `info schedules` | locale, site |
| `info holidays`, `info visa-free`, `info airports-near`, `places` | locale |
| `flights experience` | nothing – it takes only `<tripId>` and an optional `--search`, prices nothing, and returns no localized prose |
| everything else (`whoami`, `feedback`, `login`, `config`, `telemetry`, …) | nothing |

### The three carve-outs, and why breaking them is a regression

1. **`places` must never inherit `site`.** `apps/api` pins the upstream
   `site_code` to the wildcard `*` on purpose (`apps/api/src/places/client.ts`),
   so place resolution is market-neutral. roxana sends the user's market there
   because its UI is market-scoped; the agent surface resolves globally. Threading
   a market would narrow every lookup.
2. **`info holidays` must never inherit `site`.** Its site code is the country in
   the **path**. A stored market would answer for the wrong country.
3. **`hotels rooms --search <searchId>` must never inherit `site`.** That search
   already fixed a market, and the rates belong to it. Only the dates form mints
   a search a market can apply to.

There is also one asymmetry that looks like an oversight and is not:
**`hotels booking-link` takes no currency.** The hotel checkout URL carries
`search_id`, `reference_id` and `locale` and no currency param, unlike the flights
link's `wego_currency`. That is upstream's shape, in roxana's own captured URLs
too.

Guest nationality is deliberately **not** a setting: it can change which rates are
eligible, so it is a traveller attribute, not a display preference. The checkout
page collects it on its own form. `hotels booking-link --country` is **not** that
value: on wego.com `country_code` names the searched place's country
([`apps/api/docs/wire-conventions.md`](../../api/docs/wire-conventions.md)).

## What a stored currency does NOT do: stick to a search

A `searchId` carries no currency. The upstream read endpoints reprice to whatever
`currencyCode` the caller sends, so every read decides its own currency, and
`apps/api/src/flights/schema.ts` says so at `resultsQuery`: "Threaded" means only
that a caller *can* ask for the same currency it created with, and it must pass it
on every read.

That leaves one case the settings file improves but does not close:

| Create | Bare read (no flag) | Result |
|---|---|---|
| no flag, `currency: SAR` stored | sends `SAR` | matches. This is the case issue #1386 fixed: it used to send nothing and come back USD |
| `--currency USD`, `currency: SAR` stored | sends `SAR` | **mismatch.** The read is repriced into the stored preference, not the currency the search was created in |
| `--currency SAR`, nothing stored | sends nothing | mismatch, and unchanged by this file: the API's USD applies |

The CLI cannot close row 2 or row 3 on its own. A fresh process is handed only the
opaque `searchId`, which encodes no currency, so reproducing the create would need
the CLI to keep a per-`searchId` record – a new precedence rung above the file
(flag > the search's own creation currency > `settings.json` > API default), with its
own expiry to match the five-to-seven minute id lifetime. That is a design call for
the issue, not a detail of this file, so it is **not** in this change.

Two things make row 2 loud rather than silent, which is why it is acceptable to
ship: every read echoes the `currencyCode` it priced in, so a mismatch is visible in
the JSON rather than inferred from the digits; and the agent contract in
`.claude/skills/wego/SKILL.md` tells the agent to repeat `--currency` on each read of
a search it created with an explicit flag, and to compare the echoed `currencyCode`
before it quotes a number.

## Why an unparseable file is fatal

`loadUserSettings` throws `SettingsFileError` for a file that exists but does not
parse or carries a value the API would reject. Every command that reads
preferences then exits **2** (usage class) with the path named.

Three cases are fatal for the same reason, and each one would otherwise reprice an
answer in silence:

| Case | Why not "no preferences" |
|---|---|
| an **unknown key** (`{"curreny":"SAR"}`) | the schema is `z.strictObject`, so a typo is named. A stripping `z.object` would read the file as `{}` and price in USD, which is the same silent failure by a different route |
| **`ENOTDIR`** on the path | a component of the path is a file, so the preferences the user stored are unreachable. Only `ENOENT` (a genuinely absent file) falls through to `{}` |
| a **bad value** (`{"currency":"nope"}`) | the API would reject it; failing here costs a local 2 instead of a round-tripped 400 |

The cost of `strictObject` is forward compatibility: a file carrying a key added by
a newer CLI is rejected by an older one. Accepted, because `config set` is the
recommended writer and can never produce an unknown key, and the message names both
the offending key and the real ones.

This is the opposite of `telemetry-state.ts`, which fails **closed** on an
unreadable file – that one may hold an opt-out, and a privacy setting must not be
resurrected by a parse error. Here, ignoring the file would silently reprice the
answer, which is precisely the confident-wrong-answer bug the file exists to
prevent. So it is the one place in the CLI where this change makes a command stop
working, and the stderr line names the file and the offending value.

## Lifecycle

| Event | Effect |
|---|---|
| `wego config set` / `unset` | read-modify-write of the whole file, 0600 in the 0700 dir via `writeOwnerJson` |
| `wego logout` | **kept.** A preference is not a credential; wiping it would re-ask the preflight question after every logout. The `account` rung disappears with the token, so a site sourced `account` falls back to `default` while a site sourced `setting` is untouched |
| `wego login` as another user | file untouched, so an explicit `site` still wins over the new account's market |
| `wego uninstall` | removed with the credentials group; `--keep-credentials` keeps it |
| `wegostaging` | its own `~/.config/wegostaging/settings.json`, like every other file in that directory |

## Discovery

A `flights search` / `hotels search` that succeeds while no currency is stored
prints one stderr line naming `wego config set currency <CODE>`. Without it a
human never learns the file exists, which is the same invisibility the issue is
about. It follows the existing hint rules (stderr, success only, exit code
untouched) and stops once a **currency** is stored – including
`config set currency USD`, which turns the USD default into a choice somebody made.
The condition is the stored currency, not "the user has run `config` once", so
`config unset currency` brings the hint back: the unit is decided invisibly again,
which is precisely when the line has something to say.

The agent path is the other half: the `wego` skill's operating contract runs
`wego config list` in preflight and asks the user once when `currency` or `site`
reads `default`. It writes only what the user actually said, because a `config set`
changes their machine and every later session.
