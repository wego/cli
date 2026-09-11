# CLI ↔ wego.com result parity

**Does a CLI user see the same results as a wego.com user?**

Three testing layers ([`testing-layers.md`](testing-layers.md)) assert the
`wego` CLI against *its own* API. None of them answers that question. A CLI that
is perfectly self-consistent can still quote a price wego.com would not honour,
or hide the cheapest flight on the page.

This tool reads **one upstream search two ways** — once through a real browser
on wego.com, once through the CLI against the *same* `searchId` — and compares
the top 20 position for position. The rendered DOM is the oracle, so there is no
ranking reimplementation to drift out of date.

**It is measurement only.** It finds and reports; it changes no product code. A
finding names the divergence, the evidence, the suspected cause, and which repo
owns the fix. Never a patch. Issue
[#1301](https://github.com/wego/wego-ai/issues/1301) is the design.

---

## Run it

```sh
# 1. On wego.com, run the search you care about, then copy the URL.
# 2. Check the preconditions first — this takes seconds.
bun run parity:web --preflight --api https://api.wego.com

# 3. Compare. --srp is repeatable, one per vertical.
bun run parity:web \
  --srp 'https://www.wego.com/flights/searches/csin-bkk-2026-07-31/economy/1a:0c:0i?ulang=en&sort=score&order=desc' \
  --srp 'https://www.wego.com/hotels/searches/sin/2026-07-30/2026-07-31?ulang=en&guests=2&sort=popularity&order=desc&country_code=SG' \
  --api https://api.wego.com

# 4. Re-attribute a saved capture offline, with no network.
bun run parity:web --replay ./web-parity-out

# If Cloudflare refuses the SRP, drive real Chrome instead (see Known limits).
bun run parity:web --srp '<url>' --api https://api.wego.com --chrome-profile Default
```

| Flag | Default | Meaning |
|---|---|---|
| `--srp <url>` | — | **Required, repeatable** (one per vertical). Environment, vertical, locale, currency and sort are read off it. |
| `--api <url>` | — | **Required.** The `apps/api` base URL the CLI is pointed at. Must be the **same environment** as the SRP. |
| `--top <n>` | `20` | A **ceiling** on the positions compared. A page that settles shorter is graded at the window it offers and says so; it is not refused. **Not accepted with `--replay`.** |
| `--preflight` | off | Check the five preconditions and exit. |
| `--replay <dir>` | off | Re-attribute a saved capture. No network. |
| `--chrome-profile <name>` | Chrome for Testing | Drive **real Chrome** with this profile instead. A fallback for when Cloudflare blocks the default browser — see Known limits. List them with `agent-browser profiles` (usually `Default`). |

### Prod or staging, never one of each

The SRP host decides the environment; `--api` must agree, or the run refuses
before anything is measured.

| Environment | SRP hosts | `--api` |
|---|---|---|
| prod | `wego.com` and any subdomain | `https://api.wego.com` |
| staging | `wegostaging.com` and any subdomain — `ae-beta.wegostaging.com` included | `https://api.wegostaging.com` |

Subdomains are matched by suffix, not by an explicit list: market and beta hosts
are real, and a list would refuse a legitimate page for no reason a reader could
act on.

**There is a third side, and the preflight is what proves it.** The token the CLI
holds must come from the *same* environment's auth — `apps/cli/.env.local.example`
says it directly: *"Keep auth and API in the SAME environment when retargeting — a
staging token sent to the prod API (or vice versa) is rejected with 401."* A
source run's auth comes from `.env.local`, which the example points at **staging**,
so a from-source prod run needs that retargeted first. Preflight's live `whoami`
against `--api` is what catches the mismatch, and it refuses before any search.

A `localhost` `--api` belongs to no environment, so it can never pair with a real
page. It is fine for `--preflight`; a run refuses it.

**Two knobs are constants, not flags.** The CLI is always read `SPILL = 20` rows
deeper than `--top` (`argv.ts`), and artifacts always land in `./web-parity-out`.
Constraint 6 requires the spill margin to *exist*, not to be tunable, and neither
value was ever varied in a run — a flag nobody sets is a flag that only rots.

**`--top` is refused under `--replay`, not ignored.** The window is recorded in
the capture, and the capture is the evidence; re-choosing the window afterwards
would grade a comparison nobody measured. Every other flag this tool accepts does
something, and a flag that is silently ignored is the same class of lie the rest
of the design refuses.

**Exit codes are three, not eight**: `0` pass, `1` parity fail, `2` could not
measure — which now also covers a run whose dimensions did not all grade
something (see "Three dimensions"). The only distinction that matters is *parity broke* against *nothing
was measured* — conflating those is how a harness comes to lie. Which flavour of
not-measured (blocked upstream, auth, empty SRP, polling died, harness bug) is
on stderr, where a human reads it.

---

## The five preconditions

Each fails silently, and differently. `--preflight` checks all five; a live run
runs the same checks first and refuses before any search. The fifth **reports**
rather than refuses, for the reason given under it.

1. **`agent-browser` on `PATH`** — no browser, no oracle.
2. **A prod `wego login`** — an expired token surfaces as an empty CLI read,
   which looks exactly like a product bug.
3. **`which wego` resolves under `apps/cli/.bin`.** This is the dangerous one.
   Without a direnv-active shell you silently get the *installed prod binary*,
   so the run compares prod-web against prod-CLI while you believe you are
   testing your branch — a green result that means nothing, which is precisely
   the rigged comparison this tool exists to prevent. It **refuses**, it does
   not warn. Setup: [`dev-golden-path.md`](dev-golden-path.md).
4. **`WEGO_API_URL` unset in the environment.** Bun auto-loads
   `apps/cli/.env.local`, which points at local dev — that would compare a
   production web SRP against a local CLI. The `parity:web` package script
   prefixes `WEGO_API_URL=` so the var is already present-but-empty when Bun
   loads its dotenv files, which stops the auto-load filling it in. **Run
   through `bun run parity:web`, not `bun run scripts/web-parity.ts`** — the
   bare form leaks the value and the harness refuses.
5. **The driven binary's own stored travel settings**, asked of it via
   `config list` and **reported, not refused**. `wego config set currency SAR`
   (issue #1386) reprices every command that does not pass `--currency`, and that
   file has **no env rung** by design — so `childEnv` cannot neutralize it the way
   it overwrites `WEGO_API_URL`, and constraint 7's defence does not reach it. The
   run pins the currency from three sources before falling back (below), so a
   stored value is usually inert; "usually" is not a property this tool should rely
   on silently, hence the line at the top of every run. Only the `source:
   "setting"` rung counts — an account-derived market is not something the operator
   set here, and a results read takes no market anyway.

---

## What it does, in order

```
agent-browser --init-script tee.js   (the tee is installed before any page JS)
  → GET /en                          (warm __cf_bm on a cheap page)
  → GET <the SRP>
  → read the rendered rows until the WEB CLIENT stops polling and, where the
    upstream states it, until the search is done
      (three vetoes: `isLastPolling`, hotels' `done`, then the DOM fingerprint)
  → recover the searchId FROM THE ROWS
  → read the upstream fare scores out of the teed polls
  → wego <vertical> results <searchId> --wait --sort <mapped> --page-size top+spill
  → compare position for position → findings → report + capture
```

**The shared `searchId` is what rules out cross-search drift.** The CLI is
pointed at the search the DOM is actually showing, not at one the harness
rebuilt from the same inputs and hoped would match. That is what makes any
difference attributable to ranking rather than to two almost-identical searches.

"Until settled" is not a constant. A live search was observed to take 11 polls;
that is a measurement, so it is never hardcoded.

**A steady DOM is not a settled search.** The fingerprint (three identical reads
of key + price + offset) only says the page stopped repainting. Hotels state the
real fact outright — `done` on every poll — so `searchDone` reads it and the
settle loop waits for it. Where the payload states nothing, `null` means "not
observed", not "no", and the fingerprint remains the only rule; flights carry no
`done` field at all, so the web side of that vertical rests on the fingerprint
alone.

**Both sides need a settle proof, and flights only ever had one for the page.**
The page is settled, harvested, and only then is the CLI read once — so a flights
read can land while `apps/api` is still ranking, and the candidates it has not
placed yet grade as a ranking divergence against a page that already shows them.
Measured 2026-08-05 on DXB→BKK: the page's rank 1
(`RX56~5~1755~1850-RX9850~5~2200~0920`) was absent from a 40-row CLI read and
graded `unclassified`, order FAIL — and the same search, read again six minutes
later, put that row at **rank 1**, agreeing with the page exactly. So the run
reported a divergence that did not exist.

`captureVertical` now reads the CLI **twice** for flights and requires the graded
window to agree key-for-key (`windowKeysAgree`) before grading, retrying up to
`CLI_SETTLE_RETRIES` and refusing to grade at all if the ranking never stops
moving. Hotels are exempt: their `done:true` already proves the upstream finished.
The check is deliberately scoped to the graded window, since a candidate churning
inside the spill margin cannot change an order or price finding, and holding all
40 rows still would refuse searches whose window is perfectly stable.

The same-signature warning below applies to the CLI side too: a one-directional
price column with inconsistent amounts is the fingerprint of ONE SIDE being read
early, whichever side it is.

Why this is a gate and not a heuristic, measured 2026-07-31: a hotels run went
steady after **3 polls, every one of them `done:false`**, and graded 0/20 exact
order with **33 FAIL findings** — 17 `score_inversion`, 13 `price_mismatch`, 3
`unclassified`, each with cited evidence. The same search re-run once it settled
(8 polls, `done:true`) was **20/20 on set, order AND price**. In all 12 hotels the
two runs shared, the earlier run's *CLI* price was the price both sides then
agreed on: the web column had been read while rates were still arriving, which is
why every mismatch ran one direction (web high) by inconsistent amounts. Not one
of those 33 findings was real. So an unsettled search now emits `search_unsettled`
and grades **nothing** — NOT_MEASURED, exit 2. The evidence is not of a finished
search, so no order or price cause can be claimed from it at all.

### The fingerprint was also stopping EARLY, and the client says when it is done

`isLastPolling=true` on a results request is **the web client announcing its final
poll**, and the tee has always recorded it — it sits in the URL of every capture
already written, so `webPollingComplete` reads it and `--replay` can too.

Read what roxana means by it before trusting it. It is set by poll **index**, not
from any upstream fact: `flightObservables.ts:266` is `isLastPolling: index === 9`,
and hotels does the same against `MAX_POLLING_COUNT`. So it states **"the page will
not change again"** and *not* "the search is complete" — a client that exhausts a
fixed budget while suppliers are still streaming leaves a page that is final AND
incomplete. That second claim stays `searchDone`'s, and the two are read from two
places for exactly that reason.

Which makes it the fix for the opposite failure from the one above. Measured
2026-08-03 on the baseline SIN→BKK flights search: the DOM holds **5 rows** at the
top, the fingerprint went steady ×2 by 15s — and a poll at **18.9s then delivered
112 KB of further fares**. The top of a virtualised list sitting still says nothing
about what is still arriving below it. Both verticals flagged their last poll at
**24–31s** against a settle that had finished at **22–25s**, so the harvest was
starting mid-stream and the capture did not even contain the final poll.

So `lastPoll === false` is a veto on settling, symmetric with `done !== false`.
Measured cost and effect on the baseline pair, same two URLs:

| | before | after |
|---|---|---|
| flights settle reads | 5 (steady ×3) | **8** — held to steady ×6, where the flag landed |
| hotels settle reads | 5 | **7** |
| last poll in the capture | absent | **present**, both verticals |
| verdicts | PASS / PASS | **unchanged** |

That is ~9s more on flights and ~6s on hotels. A flag that never turns true spins
to `MAX_SETTLE_READS` and then settles on the fingerprint — the same bounded
failure `done !== false` already accepts.

**The flag still owes one steady read.** `isLastPolling=true` says the last
response *arrived*, never that its rows finished *rendering*, so settling on it
alone handed the harvest the very snapshot that poll was still painting into. The
fast path therefore requires `stable >= 1`: one repeat fingerprint as a render
barrier, not the full ×3 the fingerprint-only rule needs when no flag ever speaks.
For the same reason `settleSearch` probes both flags **before** it reads the rows.
Each is its own subprocess round-trip, and reading the flags first is what makes
the returned snapshot strictly newer than the flags that judged it — so a settle
can never rest on rows that predate the flag which declared them final.

**A last poll that FAILED is "not observed", never "still polling".** A record
whose `status` is null never round-tripped, and `false` here is a positive claim
that vetoes: `hasSettled` returns early on it, and `search_unsettled` then
disqualifies the whole run. Since the flag is set by poll index, the client had
already committed to stopping — so a failed final poll cannot be evidence of the
opposite. `webPollingComplete` and `LAST_POLL_PROBE` both answer `null` there and
hand the decision back to the fingerprint, which is what excluding it always
meant. A value that is neither `true` nor `false` reads as `null` for the same
reason.

---

## Non-negotiable constraints

Each was a live bug in the prior investigation. They are binary rules.

| # | Rule | Enforced in |
|---|---|---|
| 1 | The search MUST come from a pasted SRP URL; no built-in default | `argv.ts`, `srp-url.ts` |
| 2 | An unknown query param MUST fail the run | `srp-url.ts` |
| 3 | Web sort → CLI sort is a closed table with no fallback | `sort-map.ts` |
| 4 | The `searchId` MUST come from the rendered rows, never create order | `scrape.ts`, `normalize.ts` |
| 5 | An empty SRP MUST throw before the gate | `run.ts`, `taxonomy.ts` |
| 6 | The CLI MUST be read deeper than `--top` | `argv.ts` (`SPILL`) |
| 7 | `WEGO_API_URL` MUST NOT be inherited | `preflight.ts`, `cli-read.ts`, `package.json` |
| 8 | The auth token MUST be warmed once up front | `cli-read.ts` (`warmToken`) |
| 9 | A code that names a root cause MUST have observed the thing it blames | `taxonomy.ts`, `normalize.ts` |

Constraint 4 matters more than it looks: **the SRP creates twice** (a
`payment_methods` redirect remounts it) and which create wins the render is not
stable. Rows carrying a minority `searchId` are dropped before comparison and
the report says so.

---

## The codes

Thirteen, and the fourteenth is itself a finding: a code exists only once a run can
produce the evidence that distinguishes it.

| Severity | Code | Claims, and the evidence it requires |
|---|---|---|
| **FAIL** | `price_mismatch` | Same row, both amounts present, same currency, differ by > 0.01 |
| **FAIL** | `price_basis` | **Run-level.** The two sides quote different currencies, so no amount was comparable |
| **FAIL** | `api_dropped_fare` | The web holds a row the CLI never returned — needs the API's own `hasMore=false` |
| FAIL / WARN | `tie_order` | Two rows reordered, and both carry the **same observed score set**. Every rule that reads only the scores derives the same number for each, so the tiebreak is all that separates them. WARN when the rank is price-neutral |
| FAIL / WARN | `score_derivation` | Two rows reordered, their score sets **differ**, and at least one spans more than one score — so the two sides can be ranking different numbers. Not provably a tie. WARN when the rank is price-neutral |
| **FAIL** | `score_inversion` | Two rows reordered, each at a **single** observed score, and the scores **differ** — one side ranked the lower score first |
| **FAIL** | `unclassified` | A divergence with no known cause. The sharpest signal, and the correct default |
| WARN | `short_window` | **Run-level.** The page settled with fewer rows than `--top`, so the comparison is narrower than asked for |
| WARN | `evidence_incomplete` | **Run-level.** The tee lost a record, so no code may claim a trip has exactly ONE score |
| WARN | `search_unsettled` | **Run-level, and disqualifying.** The upstream reported the search as still RUNNING, so the rendered rows are a mid-flight snapshot. Nothing is graded and the run is NOT_MEASURED |
| **FAIL** | `empty_comparison` | Both sides zero rows, so every gate term is trivially satisfied |
| WARN | `price_unknown` | One side had no amount, so this position was never price-checked |
| INFO | `sponsored_injection` | An ad — no CLI surface at all, a structural exclusion |

`evidence` is mandatory for every code **except** `unclassified`, which is
precisely the code that admits it has none. `assertEvidence` enforces that
before the report renders, so an un-evidenced diagnosis is a loud harness bug
rather than a claim nobody can re-derive.

**A code that must NOT exist.** A row upstream added *between* the two reads is
a real artifact class, but no run can witness one: the reads are sequential, the
CLI's is later, and the CLI response carries no per-row timing. So it gets no
code and surfaces as `unclassified` (FAIL) — the conservative direction. A WARN
keyed on evidence no run can produce would be worse than no code, because a
clean run would then read as proof the artifact did not occur.

---

## The score is observed once, not twice

Five of the ten codes are the **order class** — `api_dropped_fare`, `tie_order`,
`score_derivation`, `score_inversion`, `unclassified`. They are the only codes a
same-rank key difference can produce, and they are graded apart from each other
because *"the two sides disagree about which flight to recommend first"* has more
than one cause and **only one of those causes is harmless**.

Telling them apart needs a score, and neither surface reports one: the CLI trip
payload carries `tripId, fares, stops, durationMinutes, outbound, featured`, and
the DOM exposes nothing. The score is not a property of either surface — it is a
property of the **upstream fare**, and it is the one ranking input both sides
read. So it is observable exactly once, from the payload the browser itself
received: `scoresFromTee` reads `fares[].score` per `tripId` off the teed polls
(`normalize.ts`), scoped to the searchId the rows agreed on.

What that payload gives is a **multiset** of scores per trip, not one number. The
one number each side ranks on is a *derivation* over that multiset, and the two
sides derive differently:

| | Takes | Source |
|---|---|---|
| wego.com | the **cheapest** fare's score | roxana `flightSort.ts` `sortTripViewModelsBasedOnScoreLogic` → `filteredFares[0]`, which `sortFlightFares(_, 'asc', _)` sorted price-ascending |
| `apps/api` | the **cheapest** fare's score | `apps/api/src/flights/normalize.ts` `cheapestScoreByTrip` → `cheapestScore` |

**The two now take the same statistic.** `apps/api` used to rank on the *highest*
fare score (`topScore`), which is what this section was written to explain; that
divergence is closed. Two consequences for reading a report:

- `score_derivation` stays in the taxonomy and stays correct — it claims only that
  a trip's score multiset spans more than one value, so the *rules could* disagree.
  It is a conservative class, not an assertion that they did.
- Until the new key is **deployed**, a live run still measures the old ranking:
  `--api` must point at the same environment as the SRP, so a parity run cannot
  exercise undeployed `apps/api` code. A pre-deploy report showing
  `score_derivation` is describing staging, not this working tree.

`topScore` survives as the tiebreak below `cheapestScore`, which needs the extra
resolution: flights scores collapse hard (measured, CGK→SIN: 20 trips → 8 distinct
values), and hotels never tie at all (20/20 distinct in all six captures).

**Neither rule is reimplemented here** — reimplementing a ranker is exactly what
this harness exists not to do, and the two rules do not even pick from the same
fare set (`apps/api` drops unjoinable and handoff-less fares first). So the only
claims made are the ones the multiset settles on its own:

- **one distinct score across both trips' fares** → every rule agrees, on both
  trips, so the scores tie and only the tiebreak is left → `tie_order`;
- **a trip spanning more than one score** (or carrying a fare with none) →
  cheapest-fare and highest-fare disagree for that trip, so the two sides can be
  ranking different numbers → `score_derivation`;
- **one distinct score per trip, and the two differ** → both rules agree on both
  numbers and both sides sort score-descending, so this order should not be
  possible → `score_inversion`, the sharpest of the three;
- **no score observed for both rows** → `unclassified`, unchanged.


#### It gates the VERDICT too, not only the loop

Vetoing the settle is half the job. The other half is what the run then *claims*: a
page that never flagged its final poll is a mid-flight snapshot, and grading one is
how the harness comes to lie. That refusal already existed for hotels, keyed on the
upstream `done` flag — but **flights upstream states no `done` flag at all**, so
`searchSettled` is `null` on every flights run and the refusal could never fire for
the one vertical whose fingerprint stops early.

So the settle loop's `lastPoll` is now carried out of `settleSearch`, stored on the
capture as `webPollingDone`, and read by `attribute` as `pollingSettled`. `false`
raises the same `search_unsettled` refusal (`NOT_MEASURED`, nothing graded); `null`
stays "not observed" and grades as before. When both signals say unfinished, the
finding names the **upstream** cause — that is the search's own state, where
`isLastPolling` is only the client's polling plan.

Why it matters, measured over the 14 flights captures on disk: **6 never reached
`isLastPolling=true`**, and every one of those predates the veto. All 6 captures
taken after it reached the flag. The flag is also always the **last** poll — 0
captures have a poll after it — so reading the newest occurrence is safe.

This is a capture-format change (`CAPTURE_VERSION` 6 → 7): a capture written before
it cannot say whether its flights page had finished polling, so `--replay` refuses
it rather than re-grading it under the new rule. Re-capture to replay.

**`validateCapture` checks the two signals for PRESENCE, not truthiness.** `null`
is a recorded value here — "the payload stated nothing", true of every flights
run — while an absent key is the field never having been written, and
`attributeCapture`'s `?? null` collapses the two. The collapsed value reads as "not
observed, grade normally", so a hand-edited or partially-upgraded v7 capture that
dropped the keys replayed a mid-search page as a real parity divergence: exactly
what the version bump exists to prevent. The docs invite editing captures with
`jq`, so this is reachable without a live run — hence the gate must separate absent
from `null`, which a null check never could. An unobserved signal is spelled
`"webSettled": null`.

### A partial observation is not the safe direction

A body the tee truncated at its cap does not parse, so it contributes nothing.
I first assumed that fails safe. **It does not**, and this is worth stating
plainly because the wrong version of it shipped:

> A trip whose fares are `[5, 9]` but whose second score was in a lost record is
> observed as `[5]`. Against another trip at `[5]` it *looks tied* — so an
> incomplete capture manufactures a **false `tie_order`**. A wrong cause, not a
> missing one.

So `evidenceComplete` gates the two codes that assert *exactly one* score:

| claim | monotone under loss? | gated? |
|---|---|---|
| `score_derivation` — "more than one score" | **yes** — losing fares cannot collapse a spread | no |
| `tie_order` — "exactly one, and equal" | no | **yes** |
| `score_inversion` — "exactly one each, and different" | no | **yes** |

When a record is lost, those two are withheld and the reorder falls to
`unclassified`. The run also emits one run-level `evidence_incomplete` (WARN),
and the report header states the coverage:

```
| Evidence | scores observed for 30 key(s); **1 of 9 teed record(s) LOST** — score attribution degraded |
```

**Measured live 2026-07-31**: a flights poll hit the 4 MB `BODY_CAP` exactly
against a **5.6 MB** payload, so 913 of 943 trips were never observed — and the
only sign was a passing log line reading `observed an upstream score for 30
key(s)`. The check that catches this is worth more than the cap that caused it:
it is a fact about the evidence layer, so it fires whatever the cause.

Bodies are now **whole or absent, never half** — a body over the cap is dropped
entirely, because sliced JSON does not parse and so buys nothing while looking
present. The cap itself is 64 MB, roughly 11x the measured payload. After both
changes the same search observed **993 keys** instead of 30.

A missing `fare.score` is handled the same way. Both rankers read it as `0`, but
substituting that here would be an inference, so it is **counted** instead and
blocks the `tie_order` claim.

**A body the tee could not READ is a loss too, and it now says so.** The XHR side
of the tee only ever kept `responseText`, so a poll issued with
`responseType: 'json'` was recorded with a `null` body — indistinguishable from a
response that carried no body at all, which `lostRecords` correctly treats as
*absent* rather than lost. A run whose evidence was incomplete therefore reported
itself complete. The tee now serializes a json-typed response, and flags anything
it still cannot read as text (`blob`, `arraybuffer`, a throwing accessor) with an
explicit `unread`, which `lostRecords` counts.

Three loss shapes, and `lostRecords` now reads all three on **every** record:
truncated at the cap, `unread`, and captured-whole-but-unparseable. The third was
skipped for creates — a `method === "POST"` short-circuit returned before the
parse was ever attempted, on the reasoning that a create carries no fare list to
lose. But `scoresFromTee` scans POST bodies like any other, and `upstreamFares` on
an unparsed body answers `[]` in silence, so a malformed create was a hole in
exactly the evidence the score codes read. The exclusion is gone: what makes a
create uninteresting is that its body *parsed*, which is what `readBody` reports.
A json-typed XHR whose native parse failed is caught the same way — the spec
yields `null` for that and for a genuinely absent body alike, and `responseText`
throws for the type, so the raw bytes cannot separate them: it fails closed as
`unread`. The `fetch` side's `text()`-rejection branch carries the flag too.

And a **capture with no `tee` at all is refused** rather than read through a `?? []`
fallback that reports zero records lost. Its absence is not an empty tee: with no
records to read, a replay would report COMPLETE evidence and claim score causes
from a payload nobody saw. An intentionally empty tee is spelled `"tee": []`. The
row shapes are validated on the same pass, so a hand-edited `"amount": "1487"`
names the file, the field and the index instead of crashing the report's price
formatter with a `TypeError`. All of this is reachable without a live run, because
these docs invite editing a capture with `jq`.

---

## Three dimensions, each with its coverage

A verdict without a coverage number is how a harness comes to reassure. Measured
live 2026-07-31: a hotels run graded order 20/20 and price **0/20**, and reported
one word — `PASS`. Every price had been skipped, and the report said the run was
clean.

So each dimension now carries what it actually graded, and the report leads with
it:

| dimension | verdict | graded |
|---|---|---|
| set | PASS | 11 / 11 |
| order | PASS | 11 / 11 |
| price | PASS | 11 / 11 |

`price.comparable` counts **same-key positions only** — two different rows at one
rank have no shared amount to disagree about, so a reorder is not an ungraded
price.

**A dimension that graded nothing has not passed; it did not run.** That verdict
is `NOT MEASURED`, and it maps to exit `2` — not `0`, because the run did not
compare what it was asked to; not `1`, because nothing diverged and calling a
never-run check a parity break is the same lie in the other direction.
Precedence is `FAIL > NOT MEASURED > PASS`, the same order `runExit` already
applies across verticals.

This generalises `empty_comparison`, whose rationale is *"both sides returned
zero rows, so every gate term is trivially satisfied"* — an argument that was
always per-dimension and had only ever been applied to the whole run.

**Zero graded is `NOT MEASURED` whatever the denominator says.** The rule was
once "zero graded out of a *non-zero* comparable", and at `comparable === 0` that
recreated the same bug at the other end: an `empty_comparison` run left order and
price at `{graded: 0, comparable: 0}` and the report printed `order | PASS | 0/0`
beside an overall `FAIL`. A check that ran on nothing did not pass.

And a `NOT MEASURED` **dimension** now reaches the shell. Precedence used to be
read off `unmeasured` — the verticals that *threw* — so a vertical that was graded
and whose gate measured nothing sat in `verdicts` carrying exit `2`, and the run
still exited `0`: the report said `NOT MEASURED` and the shell was told it passed.
`--replay` had the mirror-image bug, folding its captures with a numeric `max`
where `2 > 1`, so a confirmed reorder in one capture was hidden by an ungradeable
one beside it. Both paths fold through `runExit` now, so they agree by
construction.

---

## Order is graded on the price at each rank (#1292)

Verified across three search shapes on staging, 3 Aug 2026, and the three
outcomes are all different — which is the point:

| search | shape | set | order | price | tolerated |
|---|---|---|---|---|---|
| SIN→BKK, one-way, economy, 1 adult | the baseline | PASS | **PASS** | PASS | 4 of 4 |
| DXB↔LHR, round trip, economy, **2 adults** | multi-passenger | PASS | **FAIL** | FAIL | **0 of 15** |
| SIN→HKG, one-way, **business**, 1 adult | another cabin | PASS | **FAIL** | PASS | **3 of 12** |

Row 2 is the price-unit fault above: no rank was price-neutral, so nothing was
tolerated. Row 3 is the discriminating case — `CX734` sits at **web rank 2 and CLI
rank 13**, and rank 2 therefore offers **969 USD on the page against 485 in the
CLI**. That is exactly the divergence a set-equality rule would have passed (set
overlap was 20/20), and it FAILS here. The 3 reorders in that same run whose ranks
*were* price-neutral are still tolerated, because the decision is per rank and not
per run.

Exact-order-or-FAIL was measured and it is too strict to be useful on flights.
Live on staging, 3 Aug 2026: 16 of 20 ranks matched exactly, the other 4 were
**two adjacent swaps**, every one attributed with cited fare scores, and every one
between rows **quoted at the same price**. Failing that run reports a parity break
to a reader who would be quoted the same amount at every rank they look at. Do that
twice and the tool gets muted, which costs more than the false alarm.

**The relaxation is not "same set, any order".** That admits the case this tool
exists for: the CLI returning the page's rank-1 row at rank 20 passes a set check,
and the reader is shown a worse flight first. Set-equality retires the order
dimension and keeps its name.

So order asks a narrower question that is still worth failing on: **does the price
offered at this rank change?** A reorder is graded WARN instead of FAIL only when
all three hold.

1. The rank offers the **same price** whichever row fills it — both amounts
   present, one currency, within the same 0.01 the price dimension uses.
   `priceNeutralAtRank`. Unknown is never neutral: a null amount, a missing row or
   two currencies all keep the finding at its own severity.
2. The cause is `tie_order` or `score_derivation` — the two codes that describe
   the two sides ranking on numbers the upstream supplied, disagreeing about which
   number to derive or how to break a tie. A spec question between two teams.
   `PRICE_NEUTRAL_TOLERABLE`.
3. Nothing else. `score_inversion` stays FAIL when price-neutral — both rows at a
   single score, the scores differ, and one side put the lower first, which is
   score-descending violated rather than a disagreement. `unclassified` stays FAIL
   too: no cause was observed, and tolerating an unexplained reorder is tolerating
   a harness bug.

**What a tolerated PASS claims, exactly.** That no reader is quoted a different
price at any rank. Not that the reorder is invisible to them. The tolerated flights
pair was a 12:50 departure against an 06:30 one, both 152 USD — a reader sorting by
"best" is shown a different itinerary first. That limit is printed in the report
header beside the verdict, not filed here, and the count travels inside the order
coverage cell: `order | PASS | 20 / 20 (4 tolerated)`.

**Every tolerated finding is still emitted, still cites its scores, and is still
listed.** Tolerating is not the same as not measuring, and keeping the observation
while relaxing the grade is the whole reason order policy was moved out of the gate
into severity. The gate's accounting identity is untouched: a tolerated position
still counts in `orderAttributed`, so `exactOrder + orderAttributed === comparable`
still holds and an unattributed reorder is still a harness bug.

**Why per finding rather than a `SEVERITY` edit.** Whether a reorder costs the
reader anything is a property of the two ROWS, not of the code. The same
`score_derivation` is a FAIL at a rank where the price moves and a WARN where it
does not, so the decision cannot live in a static table. It is also not a flag:
a `--tolerate-order` switch invites picking the one that returns green.

### A tie is provable from identical score sets

The relaxation exposed an imprecision worth fixing on its own. `tie_order` used to
require **one distinct score per row**, so a pair whose two rows carried the same
*multi-valued* set fell through to `score_derivation`. Measured 3 Aug: that
mislabelled 2 of the 4 flights findings, whose two rows carried the same ten
scores.

Both known rules read only the score multiset — wego.com takes its **min** (the
cheapest fare's score), `apps/api` its **max** (the highest fare's). So when two
rows carry the same multiset, both rules return the same number for both rows, and
so would any other function of the multiset: the tie is provable and there is no
derivation gap to find. The old check is this one at multiset size 1.

Two guards on that claim:

- **Scoped to multiset functions.** A rule reading "the score of the lowest-*priced*
  fare" could differ on identical sets, because the price↔score pairing is not
  observed here. Both rules this harness knows of are multiset functions; a third
  that is not would need this revisited.
- **Gated on a complete capture.** Losing a fare from one row can make two
  *different* multisets look identical, so the claim is not monotone under loss —
  unlike `score_derivation`'s spread, which survives it.

---

## The currency is observed, never scraped

The page prices in one currency and the DOM does not always print it: `ae-beta`
renders a bare `"2,636"` where prod renders `"US$\n1,487"`. A symbol table is a
locale-specific guess besides.

The payload states it — `fares[].price.currencyCode` for flights,
`search.currencyCode` for hotels — and those **two paths are the whole rule**, not
a starting point. The reader used to walk the tree for any key named
`currencyCode`, and the same payloads carry that key in a dozen other places:
measured 2026-08-03 on a live staging capture, flights states it under
`fares[].paymentFees[]`, `fares[].fareOptions[].price`, `filters.minPrice` /
`maxPrice` and nine `filters.*[]` facets; hotels under `filter.minPrice` /
`maxPrice` and `rates[].price`. Every one agreed on that capture, so the walk
happened to be right — and a single fee quoted in another currency would have made
`currencyFromTee` see two values, return `null`, and take the whole price
dimension to "not observed" on a page that was never ambiguous.

So the run reads the two paths once and uses the answer twice:

1. it **stamps the rendered rows** that printed no symbol (a scraped symbol still
   wins when there is one — it is what the user literally saw); and
2. it **asks the CLI for that currency**, so both sides quote the same units.

**Three sources, in order: the currency the PAGE rendered, the payload's own code,
then the URL's `ucurr`.** The first exists because leaving `--currency` off is
not neutral: since issue #1386 the CLI fills an absent currency from the
operator's `settings.json`, so an unpinned run reprices according to whoever ran
it. Asking for the currency the page displayed invents nothing — it chooses a
*request parameter* from observed evidence, and if the CLI still answers in
something else, `price_basis` refuses the comparison exactly as before. A page
rendering mixed currencies is not a basis to pick from, so it stays unpinned and
the run **says so on stderr** rather than leaving a later price refusal to read as
a product fault.

Without step 2 the CLI answers in its own default. Measured live 2026-07-31: an
AE page rendering AED against a CLI answering USD put every position on both
verticals into `price_unknown`, and the price dimension graded 0.

This does not make `price_basis` vacuous. The CLI side's currency comes from the
CLI's own **response**, so the check still asks the question that matters: did
the CLI answer in the currency it was asked for?

**But be exact about what a green price column proves.** When no rendered row
states a currency, the web side was *stamped* from the payload, so the run
compared the CLI against the **payload's** currency and not against what the page
displayed. The header says so rather than leaving a reader to infer it:

```
| Currency | AED, **assumed for the web side** — no rendered row stated one … |
```

That is the case on every `ae-beta` host measured so far: the price node renders
an **icon-font glyph** (`\ue901`) where prod renders `US$`, and no symbol table
can map a private-use codepoint. So a page displaying a different currency from
the one its payload declares — a currency-cookie or site-code mismatch — would
still read as a price PASS. `webCurrencyObserved` records which case a run was,
and an older capture that never recorded it reports *provenance not recorded*
rather than defaulting to "observed".

Hotels also declare the unit outright — `priceDisplaying: {price: "PER_NIGHT",
totalTax: "EXCLUDED"}` — which the report header carries so a reader knows what
the amounts mean.

### The price UNIT is not checked, and on a multi-passenger search that is wrong

**Measured 2026-08-03, and it is a harness fault rather than a product one.** A
`2a:0c:0i` round trip (DXB↔LHR, economy) produced **20 `price_mismatch` FAILs out
of 20 rows**, every one at a ratio of exactly **0.5**:

```
web 653  cli 1305     web 605  cli 1210     web 965  cli 1930
distinct ratios across all 20 rows: 0.5, 0.5003, 0.5004
```

That uniform column is the tell the gate section tells you to read as a harness
bug, and it is one. Both sides are internally correct and **both declare their
unit in the payload this run already captured**:

| side | field | value |
|---|---|---|
| upstream fare (what the page renders) | `price.amountPerAdult` | `642.9` |
| upstream fare | `price.totalAmount` | `1286.0` |
| CLI fare (what `readCliResults` reads) | `price.scope` | **`"party"`** |
| CLI fare | `price.total` | `1305` |

The CLI **states** `scope: "party"`; `rowsFromCliFlights` reads `price.total` and
never looks at `scope`. So the harness compared a per-adult amount against a
whole-party one and reported 20 confident divergences, none of them real.

Two consequences, both of which held on that run:

- **Nothing was tolerated.** The order relaxation requires price-neutrality per
  rank, and no rank was neutral, so 0 of 15 reorders were tolerated. The policy
  switched itself off rather than paper over a run whose price basis is wrong —
  which is the behaviour wanted, arrived at by accident rather than by design.
- **`price` correctly FAILED**, so the run is not readable as clean. The damage is
  a wrong *cause*, not a wrong verdict.

**Fixed, and the two verticals needed different fixes** — because they publish
different things.

**Hotels: read the unit the CARD renders, which is `amountPerNight`.** Measured on
a 2-night stay — the only shape where the two candidate fields differ — every card
rendered 799 against `amountPerNight: 799` and `total: 1598`, all 20 rows at a
ratio of exactly 0.5.

**And `priceDisplaying.price` is NOT what the card shows.** That same payload
declared `TOTAL_STAY` while every card rendered the per-night figure. Selecting the
CLI field from that declaration was tried first and it is wrong: it reads `total`
and reports a mismatch on every row. The rendered DOM is this tool's oracle
everywhere else and it is the oracle here too — `priceDisplaying` is reported in
the header for what it is worth and trusted for nothing.

Since that leaves a measured assumption rather than a declaration,
`hotelsUnitLooksWrong` guards it: over hotels where the two fields differ, it
counts how many rendered amounts match `total` against how many match
`amountPerNight`, and a clear majority for `total` blocks the comparison. **The
guard can only refuse, never select** — picking whichever field matched the web
per run would be circular and would make the price dimension pass by
construction, so no hotels price divergence could ever be found again.

The majority needs **two** matching rows, not three. An absolute floor of 3 could
never fire on a window that settled at two rows, however lopsided the ratio — and
two rows that both rendered the whole-stay total are the same evidence as three,
so those runs graded both rows as real `price_mismatch` FAILs instead of refusing.
Since the guard can only refuse, lowering the floor cannot make anything pass.

**The guard counts over the UNRANKED rows** (`WebRead.organicUnranked`), which is
`organic` plus every row `mergeScrapes` evicted for a stale offset. Eviction
answers a question about the `top`, and it must not silently answer one about the
price: an evicted row's amount was really observed, and this guard never ranks
anything. Counting the ranked list let a ranking decision starve the majority
floor — a 2-of-3 window dropping to 1-of-2 — and skip a refusal that had nothing
to do with ranking. Every other reader still takes `organic`, so nothing is ever
ordered on a stale offset.

**Flights: refuse.** `apps/api` returns ONE amount per fare, `price.total`, with
`price.scope: "party"`. There is no per-passenger figure to select, so past one
passenger there is nothing to compare against a page that quotes per person. The
run emits one run-level `price_unit_mismatch`, grades **zero** positions, and the
price dimension reads NOT MEASURED — exit 2. Both facts it cites are declared, not
inferred: the party comes off the pax segment of the URL the site produced, the
scope off the CLI's own response.

**It refuses rather than divides, deliberately.** Dividing the party total by the
head count is arithmetic the harness would be inventing — fares are not uniform
per passenger (children and infants price differently), so the quotient is a
number neither side ever quoted, and comparing the page against it would be
comparing against a figure this tool made up. Under-reporting is the correct
direction. The refusal lifts the day `apps/api` publishes a per-passenger amount
beside its party total.

**But refusing to divide is not the same as answering "not price-neutral".** The
ORDER dimension keeps grading on a party-scoped run, and its price-neutral
tolerance (#1292, below) read the two raw amounts — so every reorder looked to
differ by the party size, no party-scoped reorder could ever be tolerated, and a
genuinely price-neutral swap was graded **FAIL**. That is a false FAIL, in the one
direction a measuring instrument must never fail. So the tolerance decision alone
divides, and only for an **adults-only** party: that is exactly the case the
refusal above is not about, since with no children or infants the quotient IS the
per-passenger amount the page quotes. The scaled figure is never reported, never
reaches the price dimension (which still refuses), and any party carrying a child
or an infant scales by 1 and tolerates nothing.

Replaying the original 2-adult capture under the fix turns **20 `price_mismatch`
FAILs into one `price_unit_mismatch`** and `price 0 / 20 NOT MEASURED`. Order
still FAILs there, and correctly: 15 rows reordered and, with price unmeasurable,
not one of them can be shown to be price-neutral.

Confirmed live on two further searches, 3 Aug 2026:

| search | shape | set | order | price |
|---|---|---|---|---|
| DXB↔LHR round trip, **2 adults** | the flights refusal | PASS | FAIL | **NOT MEASURED** |
| SIN, **2 nights**, 2 guests | the hotels read | PASS | PASS | **PASS** |

The hotels run is the one that found the wrong field choice: on the first attempt
it graded `price FAIL` on all 20 rows at a 0.5 ratio, which is how the
`priceDisplaying` assumption was caught. It passes on the per-night read.

---

## The gate is three terms, all required

**No FAIL finding**, **`exactOrder + orderAttributed === comparable`**, and
**every dimension graded something**.

The second term used to be `exactOrder === comparable`. That equality was
redundant with the FAIL count on purpose, but it was doing two jobs at once:
hard-gating exact order, *and* catching a future path that diverges a position
and emits no finding. Only the second job belongs in a gate — and keeping both
made the relaxation issue #1301 designed for **unreachable**. Dropping
`tie_order` to WARN would clear the FAIL term and still fail on the equality, so
an accepted, price-neutral tie could never pass no matter what #1292 decided.
Worse, the two jobs pull opposite ways: the only way to relax the first is to
weaken the second, and a weakened second term is how a genuinely dropped or
mispriced row slips through as "order noise".

So order policy now lives **entirely in `SEVERITY`** — one line per order code,
graded by cause — and the gate's second term is the accounting identity it always
wanted to be: every position that is not exact MUST name a cause. It still cannot
fire on any path that exists today, which is the point. It fires only on the
harness bug it was written for, and it has no opinion about which order
divergences are acceptable.

**What this buys.** The day #1292 accepts the tie, the change is one line —
`SEVERITY.tie_order: "WARN"` — and `score_derivation` / `score_inversion` do
**not** ride along on it. Both describe two sides disagreeing about the score
*itself* rather than about how to break a tie in it, and the harm there is the
same as a reordered price: the CLI recommends a flight wego.com would have ranked
lower.

---

## Reading a failure

Exit `2` means the comparison never happened. Fix the named cause and **do not
read the report**.

Exit `1` means the report answers in order — which positions diverged, then why
each one did, then whether it is one bug or a pattern.

**Then ask whether the harness is the liar.** The prior harness invented a
defect twice:

- once by reading its capture in **insertion order** instead of layout offset;
- once by scraping the struck-through `usualPrice`, because a discounted card
  renders two `[data-testid="price"]` nodes.

Both are designed against in `scrape.ts` and both have regression tests. A
finding with no cited evidence, or a suspiciously uniform column, is a harness
bug until proven otherwise.

The first live run proved the point on this tool itself: it reported nine
identical consecutive `unclassified` FAILs, and every one was the harness
under-reading a lazily-rendered list. The uniform column was the tell. That
class is now a refusal rather than a verdict (see Known limits), but the
reading order stands — **suspect the instrument before the subject**.

---

## The inner loop is offline

```sh
bun test scripts/web-parity      # every pure module
bun run parity:web --replay ./web-parity-out
```

Because the oracle is a **captured artifact** rather than a live dependency, the
loop that actually gets used is `bun test` plus `--replay` — seconds long, no
network. A live run is only needed to collect a *new* capture. If the inner loop
needed the network, the taxonomy would stop being maintained the week after it
landed.

`--replay` writes `<vertical>-report.replay.md`, so it never overwrites the live
`<vertical>-report.md`. Live and replay share one `attributeCapture` function,
which is what makes them reach the same verdict by construction.

**A capture from before the score landed will be refused, not replayed.** The
format is now version 2, and `--replay` exits `2` naming the version it found. A
v1 capture holds no `scoreByKey`, so replaying it would report every reorder as
`unclassified` where a fresh capture can name the cause — a silent
under-report, which is worse than a refusal. Collect a new one with a live run.

### Artifacts a run writes

| File | What it is |
|---|---|
| `<vertical>-capture.json` | Everything the verdict was derived from: the parsed SRP, the raw extractor output, the teed upstream payloads scoped to the searchId, the per-trip fare scores read off them, the CLI's raw response, and the normalized rows. Format **version 2** — a v1 capture is refused, not replayed, because it holds no scores and would under-report every reorder as `unclassified` |
| `<vertical>-report.md` | The rendered report |
| `<vertical>-report.replay.md` | The same, from `--replay` |

---

## Files

| Path | Role |
|---|---|
| `scripts/web-parity.ts` | The entry. A shell over `run.ts` |
| `scripts/web-parity/argv.ts` | Flags and the required-input gates, including the sort refusal — a pasted URL's sort pair is knowable before a browser opens, so it is refused at parse time |
| `scripts/web-parity/srp-url.ts` | Parse + validate a pasted SRP URL (constraints 1, 2) |
| `scripts/web-parity/sort-map.ts` | The closed web→CLI sort table (constraint 3) |
| `scripts/web-parity/scrape.ts` | The in-page extractors and their pure parsers |
| `scripts/web-parity/tee.ts` | The injected network tee — the evidence layer |
| `scripts/web-parity/normalize.ts` | Prices, keys, searchId recovery, CLI row readers, the observed scores / currency / price display |
| `scripts/web-parity/price-epsilon.ts` | The one price tolerance (`EPSILON`, `FLOAT_SLACK`, `amountsAgree`). Its own module because `taxonomy.ts` already imports from `normalize.ts`, so a constant in either would be a cycle — and the duplicate `0.01` the hotels unit guard kept had already drifted out of `taxonomy.ts`'s sight |
| `scripts/web-parity/taxonomy.ts` | The codes, the attribution pass, the gate. Owns `CARD_RENDERS_TOTAL`, the hotels unit-guard sentinel that `run.ts` builds and this module and `report.ts` each read — one constant, since nothing but a repeated literal linked the three |
| `scripts/web-parity/report.ts` | Findings → markdown |
| `scripts/web-parity/capture.ts` | Capture read/write, the format version gate and the replay-input validation |
| `scripts/web-parity/preflight.ts` | The five preconditions |
| `scripts/web-parity/browser.ts` | The only module that talks to `agent-browser` |
| `scripts/web-parity/cli-read.ts` | The only module that shells out to `wego` |
| `scripts/web-parity/run.ts` | Orchestration and the three exit codes |

Everything except `browser.ts` and the impure half of `run.ts` is unit-tested
without a browser. `cli-read.ts` is the exception that had to stop being one: it
builds the argv every CLI-side number arrives through, so a `wego results` flag
renamed in `src/` would make it construct an argv the binary rejects — and that
failure surfaces as an EMPTY CLI read, which reads as a product bug. Its flags are
asserted against the real `parseFlightResultsArgs` for flights and against the
hotels flag table's own source text for hotels.

---

## Adding a sort

An unmapped sort is a **usage error**, never a silent fallback: defaulting to
`relevance` would compare a price-sorted page against a relevance-ranked read
and blame the CLI for every position.

To add one, check the web comparator against `apps/api`'s, then add a row to
`sort-map.ts` with a `basis` string recording what that check was. The table
currently holds only the two defaults wego.com emits, each verified live on
2026-07-30 — a row is worth more than a guess, and a reviewer can re-do a
`basis` but cannot re-do a hunch.

---

## The known flights divergence (#1292)

A flights run reports order FAILs for **adjacent, same-price swaps**. Measured
live 2026-07-30: set overlap 20/20, exact order 16/20, the whole difference being
ranks 1↔2 (both 141 USD) and 3↔4 (both 166 USD).

**Read the report as two independent columns.** The price column was identical at
**all 20** positions, including the four that swapped — each swapped pair is
price-tied. So no user was overcharged and no flight was hidden. What differed is
the *recommendation*: a user booking "the first result" got a 16:15 departure on
wego.com and a 06:30 departure through the CLI, for the same $141. That is the
harm, and it is why order is graded at all — a dropped row or a mispriced fare
would also surface as an order break, so order is the tripwire that catches the
expensive bugs (like the $211 fare that reached no CLI user; see #1292).

Two causes, and the harness now distinguishes them:

**1. The tiebreak** — confirmed from **both** sides by the flights team (Slack,
2026-07-29). `apps/api` closes equal-score ties with `tripId` **ascending**
(`apps/api/src/flights/filter-sort.ts:255`); the web app has **no tiebreak** and
falls back to poll/input order (roxana `flightSort.ts:228-236`), so its order is
not stable even across two of its own sessions. → `tie_order`.

**2. The score derivation** — read from both sources 2026-07-31, and *not* part of
the original #1292 write-up. A trip has many fares, each scored, so the trip's one
score is a derivation: `apps/api` takes the **highest** fare score, wego.com takes
the **cheapest** fare's score. They agree only on a trip whose fares all share one
score. → `score_derivation`.

**This matters to #1292's decision.** The issue asks whether to accept the order
difference on the grounds that same-score flights have no correct order. That
premise holds for cause 1 and **not** for cause 2: where a trip's fares span more
than one score, the two sides are not tied — they are ranking different numbers,
and one of them is putting a flight first that the other would rank lower on its
own rule. The issue body's *"each flight has the same price and the same score on
both surfaces"* was never measured; no score was observable when it was written.
Any run from this build now grades those positions apart, so the decision can be
made per cause instead of for the whole column.

Both stay **FAIL** until #1292 rules. Per this tool's design, if #1292 accepts the
tie, `SEVERITY.tie_order` drops to WARN — one line, and nothing in `gate`
re-asserts order behind it (see "The gate is two terms"). `score_derivation` and
`score_inversion` do **not** ride along on that relaxation, and price and set stay
the hard gate regardless.

Issue [#1292](https://github.com/wego/wego-ai/issues/1292) owns the decision.
Until it lands, expect flights to FAIL on order.

---

## Known limits

- **A page shorter than `--top` is graded at the window it offers, not refused.**
  `--top` is a ceiling; the graded window is `min(--top, organic rows)`, stated
  in the header and carried by a `short_window` WARN.

  This was a hard refusal until 2026-07-31, and the refusal was aimed at the
  wrong thing. The bug it was written for — a hotels page rendering 11 rows
  against a 40-row CLI read, which emitted **nine** `unclassified` FAILs for
  positions the web never filled — came from one line:
  `positions = max(webTop.length, cliTop.length)`. Taking the max grades ranks
  only one side has. Bounding the window by the **web** rows (the oracle) removes
  the hazard at its source, so a narrow window can be graded honestly. The
  refusal, meanwhile, was discarding real measurements: three flights runs in one
  session, each with a full CLI read beside it.

  The safeguard that makes this safe now is per-dimension coverage — a narrow
  window is legible (`18 graded of 20 requested`) instead of hidden behind a
  single word. Grading `min()` and reporting both numbers is the same principle
  the price dimension already follows: report what you graded, don't refuse and
  don't inflate.
- **Filters are rejected, not compared.** Nothing consumes filter params yet,
  and a filter the browser applies but the CLI never hears about invents
  inventory and order failures.
- **`--top` is global, and the two verticals settle at different windows.**
  Measured 2026-07-31: flights 18 rows, hotels 21. Since `--top` is now a ceiling
  rather than a contract, one run grades each vertical at its own window —
  `--srp <flights> --srp <hotels> --top 20` gives a top-18 flights comparison and
  a top-20 hotels one in a single pass.
- **One search per vertical per run.** Artifacts are keyed by vertical, so a
  second would overwrite the first's report and capture; the run refuses it
  loudly. When a filter/sort matrix arrives, add a `--label` to the artifact
  prefix.
- **No CI integration.** No workflow runs this. Baselines are snapshots of the
  day they were taken; only the pure modules' unit tests are continuous.
- **Cloudflare, the warm step, and `--chrome-profile`.** The
  `/flights/searches/*` SRP is bot-scored harder than `/hotels/searches/*`.
  Before the dev egress was allowlisted, Chrome for Testing was refused
  **indefinitely** on flights (40 reads, warmed `__cf_bm`, headed) while hotels
  loaded in the same session; real Chrome with a real profile loaded both, which
  is what `--chrome-profile` is for. **With the egress allowlisted, plain Chrome
  for Testing loads flights — but only with the warm step.** Measured
  2026-07-30: navigating straight to the SRP was refused (`Just a moment…`
  headed, the harder `Attention Required!` headless), while `/en` first then the
  SRP rendered 296 testids on the first poll. That warm-then-navigate order is
  exactly what `driveSrp` does, so the default browser is fine on an allowlisted
  egress; keep `--chrome-profile` as the fallback when it is not. A blocked run
  is still exit `2`, never a graded blank page — **including a bot check that comes
  back mid-scroll.** The harvest keeps that read out of the merge (merging it would
  let a bot page's zero rows erase the harvest), and it used to simply stop there,
  so `scrape.interstitial` stayed `false` and the run graded however many rows had
  landed before the block as a merely SHORT window. It now refuses, exactly as a
  check that never cleared does.
- **A bot check and an empty page are two different observations, and the refusal
  says which it saw.** `interstitial` used to be true either when the page text
  matched a challenge string *or* when the DOM held no `[data-testid]` at all. The
  second is produced just as well by a 500, a page that never hydrated, a login
  wall, or a markup change in the SRP — so the refusal named bot scoring for four
  causes it could not show, which is the failure class this whole tool exists to
  prevent. `ScrapeResult` now carries `interstitial` (the text match, the only
  thing reportable as a bot check), `noTestids` (the observation, refused on its
  own terms) and `pageSample` (300 characters of the rendered body text, quoted
  verbatim into whichever refusal fires).
- **The browser decides whether the list recycles, and on flights it decides a
  lot.** Under Chrome for Testing the hotels DOM stuck at 11 rows and never
  recycled. Flights is worse: measured 2026-07-31, five consecutive runs of one
  URL settled at **20 → 19 → 15 → 6 → 4** organic rows, so no flights number was
  reproducible. **`--chrome-profile Default` fixed it** — real Chrome recycles,
  and the scroll harvest reached 21 distinct rows for an 18-row window in the
  same session where Chrome for Testing gave 4. Treat `--chrome-profile` as
  required for flights, not as a fallback.
- **A hotels rate-selection divergence is reported, but its cause cannot be
  named.** A `hotel_rate_choice` code existed for it and is now **removed**: it
  was unreachable, and not for want of wiring. The CLI's hotels **results**
  payload publishes no rate identity at all — only `price`,
  `lowestRefundablePrice` and the hotel's own fields (verified 2026-08-03 against
  a live staging capture and `apps/api/src/hotels/schema.ts`). A rate id does
  exist (`{searchId}:hotels.wego.com:{hotelId}:{rateHash}:{idx}`) but only on the
  per-hotel **rates** read, which is a second request per hotel this tool does not
  make. So which rate each side chose is not observable from what a run reads, and
  a code that names it could never fire. Such a divergence surfaces as
  `price_mismatch`: under-reported, never mis-reported. Naming it needs the rates
  read wired in on both sides, and that is a feature, not a fix.
- **Checkout price is not verified.** Comparing CLI price against web price is a
  *proxy* for quote integrity. The definitive check follows the CLI's own
  `handoffUrl` and asserts the checkout price matches its quote. Not built.
- **An SRP that states no locale cannot be compared.** Locale comes from `ulang`
  or from a leading path segment (`/en/flights/searches/…`); hosts differ in
  which they write, and either counts. A URL with neither was hand-edited.
