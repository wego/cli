# Testing layers

Four layers, complementary. Each proves something the others can't, so they are
additive, not redundant. **Keep all four.**

Layers 1 to 3 ask whether the software is right. Layer 4 asks whether the
*answer* is right, which is the one question none of the others can reach.

## 1. `bun test` — unit, plus the recorded e2e tier

In-process unit tests of the argv / parse / settle / dispatch logic against the
committed public dev config. Fast, hermetic, **in CI**.

**Since issue #1333 this layer also holds the `*-e2e` suites**, which are neither
in-process nor hermetic in the old sense — and still deterministic and CI-safe.
They spawn a real `apps/api` (`bun src/dev.ts`) with its upstreams replaying from
`apps/api/src/__recordings__/<vertical>/`, and drive the real CLI as a subprocess
against it. No network: a replay miss throws rather than reaching the upstream.
`flights-e2e` (#1333) and `hotels-e2e` (#1340) both live here, one booted API each,
since a recording set is per vertical.

**Both now walk their funnel to the handoff URL.** `flights-e2e` used to stop at
`trip`, which left `fares` → `booking-link` — and the fareId → brandedFareId
threading with it — proven only in tier C, a suite that needs a human token and is
therefore not in CI (#1338). Both legs turn out to be replayable: the fare-compare
read is recorded (#1341 publishes the `wegoFareId` / `wegoTripId` pair it belongs
to, so the fare, the trip and the option come from ONE offer rather than three ids
that merely type-check together), and `booking-link` is a pure stateless URL build
with no upstream at all. The threading assertion is one line — the chosen
`fareOptionId` **is** the upstream's branded fare id, and the builder puts it on the
URL as `branded_fare`.

That costs about 2s of the suite's wall clock and buys the thing layer 1 could not
previously give — a red that means *the CLI and the API stopped agreeing*, not
*a hand-written fake disagreed with itself*. The `Bun.serve` stand-in for
`apps/api` that `flights-e2e` used to carry is gone, and
`src/testing/no-api-fake.test.ts` stops it coming back. Since #1341 (commit
`abd02d4`) `hotels.test.ts` has none either — it runs on injected api deps, so the
guard's allowlist is **empty** and no file under `src/` may stand in for
`apps/api`. `apps/cli/AGENTS.md` explains what moved to `hotels-e2e` and what
could not.

What still belongs in the pure in-process tier: anything that needs to observe the
API's **inbound** calls (request counts, exact query strings). A subprocess
boundary cannot see those, so `commands.test.ts` owns them, and Check C pins the
query keys at compile time.

### The graduation rule

The in-process injected-deps suites (`hotels.test.ts`, `commands.test.ts`,
`api.test.ts`, `info.test.ts`) are this app's **A′** tier — the counterpart of
`apps/api`'s `installUpstreamStub` suites. **When the recordings gain the
expressiveness to replay an assertion an A′ block makes, that assertion graduates
to the tier-B `*-e2e` suite and its A′ copy is deleted in the same PR — only the
replayable assertions move.** A behavior proven once against a hand-built dep and
once against the replayed real body is not proven twice; the hand-built copy is a
second surface that can drift while still passing against itself. A block that
also carries assertions replay cannot express — a programmable sequence, an exact
inbound request-count, a counterfactual error — is split, not deleted whole: the
replayable assertions leave for tier B and the rest stays in A′ (the corollary
below).

Precedent: the **2026-08 prune** removed 11 such duplicate blocks across the two
apps once replay covered them, and **#1341** moved the hotels
search→details→rooms→booking-link funnel and the refundability witness out of
`hotels.test.ts`'s old `Bun.serve` fake into `hotels-e2e.test.ts` the moment the
recordings could carry them (`apps/cli/AGENTS.md` lists what moved and what could
not). The api side of this rule, with the same precedent, is
[`apps/api/docs/testing-layers.md`](../../api/docs/testing-layers.md).

The corollary is what keeps A′ populated: it exists **only** for what replay
cannot express — counterfactual error states (a typed `ApiHttpError` /
`UnauthorizedError` the healthy API never returns on demand), programmable
settle sequences (`resultsFor(n)` / `ratesFor(n)`), and the inbound-call
assertions above. A block that merely restates a happy-path shape the recordings
already carry is a graduation candidate, not an A′ citizen.

Design and the failure injections:
[`apps/api/docs/upstream-recordings.md`](../../api/docs/upstream-recordings.md).

Scoped to `src/` and `scripts/`, so a `*.test.ts` placed anywhere else — `live/`
above all — is never swept into an unattended run.

**Four `live/` files are named explicitly, and they are the only `live/`
exceptions:**

```
bun test ./src ./scripts ./live/verdict.test.ts ./live/gate.test.ts ./live/inventory.test.ts ./live/user-agent.test.ts
```

The script also names the `persona/` unit files (`persona/lib/`,
`persona/data/cases.test.ts`): pure tests of the layer 4 harness's own helpers,
reading no token and no network, so they belong in this tier while the harness
itself does not. `package.json`'s `test` script holds the authoritative list.

`live/verdict.test.ts` covers the verdict CLASSIFIER (layer 2 below), which is pure:
it builds its own inputs and reads no transcript, no token and no network. The rule
that keeps `live/` out is about tests that need the preload's drive, and this one
does not — while classification logic that nothing checks until someone runs the
live suite is exactly what rots, the more so because the verdict is shadow-mode and
a rot in it would be invisible.

`live/gate.test.ts` (#1477) qualifies on the same bar by a different route. It
asserts nothing about a live run: `gate.ts`'s whole input is two env vars and a text
file, so the test drives it as a SUBPROCESS over a temp dir and temp `GITHUB_*`
files — no token, no network, no preload. It closes the gap the issue named:
`gate.ts` is coverage-exempt CI glue whose structural failure paths were proven by
nothing, and a bug in one only surfaces when the staging post-deploy workflow runs.
What it pins is what a human reads weeks later — that every structural exit FAILS
the check, NAMES the offending value rather than emitting a static sentence, emits
the summary header exactly once, and still writes `promotable` / `promotion_reason`
(the caller posts its status with `if: always()`). It also pins the two guards'
boundary: a non-numeric `coverage.satisfied` / `coverage.ratio` is structural, while
a real ratio *below the floor* must still reach `gateDecision` — the guard is about
the field's type, never its value.

`live/inventory.test.ts` (#1534) qualifies on the same bar again: `inventory.ts` is
a pure classifier over two numbers, reading no transcript and no network, and it
decides whether an empty live page reds the suite. Getting that rule wrong is silent
in both directions - a false `ours` reds every thin-inventory minute, and a false
`thin` hides a projection regression - and neither shows up until someone runs the
live suite against a staging that happens to be thin.

`live/user-agent.test.ts` qualifies on the narrowest route of the four: it imports
one exported constant, `driver.ts`'s `WEGO_UA`, and pins its value. No transcript,
no token, no network, no subprocess. The header that constant sets is what clears
Kong's `.*Wego.*` bot-detection allow-list, so a rename that drops the `Wego` token
would not fail anything here – it would surface as bot-scoring partway through a
staging drive, which is the same delayed, expensive signal the other three
exceptions exist to pull forward.

The bar for a fifth exception is the same: an anchored path to a single file that
reads none of the drive's state. A whole `live/` directory never qualifies. All four
exceptions are repeated in `.github/workflows/ci-sonar.yml`'s coverage step, and
`.github/workflows-gate.test.ts` now asserts the two lists are identical - they were
hand-maintained copies with nothing holding them together.

The `./` carries the whole guarantee. A bun test positional is a **substring match on
the file path**, not a directory: `bun test src scripts` also runs
`live/src/a.test.ts` and `live/scripts/b.test.ts`, and so does `src/ scripts/`. Only
`./src ./scripts` anchors the two paths, because no path under `live/` contains the
prefix. Measured against a scratch tree holding all five shapes:

| Command | Files run |
|---|---|
| `bun test` | 5 (everything) |
| `bun test src scripts` | 4 — leaks `live/src`, `live/scripts` |
| `bun test src/ scripts/` | 4 — same leak |
| `bun test ./src ./scripts` | **2 — correct** |

The named `./live/verdict.test.ts` is safe for the same reason: it is an anchored
full path, so it matches that one file as a substring and nothing else.

## 2. `bun run test:integration` — tier C, the live suite

`live/`, run as `bun test --preload ./live/preload.ts ./live`. A black-box run of
the **compiled** CLI → a real `apps/api` → live upstreams, asserting response
shapes and the exit-code taxonomy across both funnels, the four `wego info` reads,
the error paths, the trip `?view=detail` projection (a real `flights trip --view
detail` invocation since the CLI gained the flag), and the fare-compare upstream's
own contract.

This is the authoritative **contract and regression** check. `local`/`prod` are
human-run; the **`staging` target also runs in CI** as a post-deploy smoke
(`.github/workflows/post-deploy-staging-smoke.yml`, #1338 slice 10a): a staging deploy
triggers the live suite on `github-runner-small`, minting a token via
`scripts/ci-staging-token.ts` (#1313: a sanctioned staging password-grant CI client)
into `WEGO_CREDENTIALS_PATH`. It reads the verdict below in **shadow**: the smoke does
not block deployment or promotion, but it does fail the check on a broken contract, a
missing or unparsable verdict, a verdict value outside the known enum, zero-evidence
insufficiency, or an UNEXPLAINED red – an `ok` or thin-inventory verdict beside a
`bun:test` exit ≠ 0, the blind spot `gateDecision` closes (see "What it does not
claim" below).

### Three targets

```sh
bun run test:integration                        # local: boots apps/api on a free port
WEGO_TARGET=staging bun run test:integration    # the deployed staging API
WEGO_TARGET=prod    bun run test:integration     # the deployed prod API
```

Multi-target is cheap because the auth team seeds the same literal public
`client_id` in both environments and `AUTH_ISSUER` is a pinned constant — only the
JWKS and the host URLs vary. Each target reads the token its own flavor stores
(`~/.config/wego` for local and prod, `~/.config/wegostaging` for staging);
`WEGO_CREDENTIALS_PATH` overrides. The token is your real one and its expiry is
**asserted**, never patched.

### Drive once, assert many

`live/preload.ts` drives every step exactly once and records
`{argv, code, out, err}` into `live/transcript.ts`; each `live/*.test.ts` only
reads. Two consequences worth stating:

- **A broken step no longer cascades.** The driver never throws, so one broken step
  yields N honest failures instead of one failure plus N skips.
- **`skip` has one meaning**: this route sold no Book-on-Wego fare today, or no
  refundable inventory could be confirmed. That is the signal #1338's four-way
  verdict is built on, so it must not be overloaded again.

The drive runs at **preload module evaluation**, not in a `beforeAll`: `bun test`
evaluates every `it.skipIf(…)` condition while collecting files, which happens
before any hook. A `beforeAll` would leave those conditions reading an empty
transcript.

### The verdict — three outcomes, not two (issue #1338, shadow mode)

A live suite that reports only red or green answers the wrong question. So the run
ends with a **classification** of the transcript, printed as a human summary plus one
machine-readable line:

```
WEGO_LIVE_VERDICT {"verdict":"insufficient_evidence","shadow":true,…}
```

One line so `grep` + `JSON.parse` is the entire parser, and last on stdout so a
consumer takes the final match.

| Verdict | Means | What to do |
|---|---|---|
| `contract_broken` | Ours, and deterministic: a live body no longer matches the shape the contract publishes | Fix the code. A retry proves nothing |
| `availability_degraded` | The world's: an upstream was rate-limited, timed out, or reported itself unavailable | Retry, and if it persists, **hold** rather than "fix" |
| `insufficient_evidence` | Nothing broke, and nothing much was proven either | Read `coverage.unevidenced`. Often just a day with no Book-on-Wego inventory |
| `ok` | Nothing broken, coverage at or above the floor | Note `coverage.unevidenced` may still be non-empty |

Precedence is most-severe-first, and it is operational rather than cosmetic:
availability says *retry*, contract says *a retry cannot help*, so reporting the
retryable one would send someone to wait out a break that is ours. All classes that
fired are kept in `reasons`; `verdict` is the worst of them.

#### The signals, and why each has exactly one meaning

It is **post-processing of `live/transcript.ts`**, not a taxonomy of thrown errors.
That distinction is the whole design: #1335 deleted a `SkipError` taxonomy because it
turned one broken step into one failure plus N cascading skips, burying every claim
the run could still have judged. Nothing in `live/verdict.ts` throws or skips.

| Signal | Reads as |
|---|---|
| A schema mismatch `parsed()` recorded on its way to throwing | `contract_broken` |
| A CLI step exiting **5** or **7** | `availability_degraded`. The CLI assigns 5 only to `rate_limited` / `upstream_unavailable` / 429 / 503, and 7 only to a host genuinely unreached or a deadline fired |
| **429 / 503 / 504** on a direct read | `availability_degraded` |
| The run-level `PreconditionError` | `insufficient_evidence`. The drive never started, so nothing was proved. This is `ClassifyInput.precondition`, set once for the whole run |
| A **step** exiting 2 | **Nothing, deliberately.** `stepReasons()` has no exit-2 branch, and must not: most exit-2 steps here are the POINT of the step (a malformed fare id, a `--page-size` over the cap), so a signal would red every healthy run. This row used to be fused with the one above, which read as though a step exiting 2 fed the verdict – and that misreading is exactly how the drive came to spawn five steps against unharvested ids while the verdict still reported `ok`. What catches that now is not a verdict signal but `live/argv-guard.test.ts`'s "drives no step against an unharvested id" |
| The driver's `-1` could-not-spawn sentinel | `insufficient_evidence` — a harness failure is evidence lost, not a product verdict |
| An `EXPECTED_STEPS` name never recorded | `insufficient_evidence` — those are owed unconditionally, so one missing is a drive regression |
| A `CONDITIONAL_STEPS` name never recorded | Coverage context only, and deliberately **not** a reason: those are contingent by declaration, so an absence is a fact about today's inventory |

**Two exit codes, and only two.** Most non-zero codes in this suite are the point of
the step — a bogus trip id must exit 4, a malformed fare id 6, a credential-less read
3 — so "did it fail" carries no signal at all. Only the classes no step ever
legitimately expects do, which is why the list is short and why widening it would
make the verdict red on every healthy run.

**`502` is deliberately absent** from the availability set. The CLI maps
`bad_gateway` to PERMANENT rather than RETRYABLE because for these upstreams a 502
means path or base drift, not an outage
([`apps/api/docs/upstream-flights-api.md`](../../api/docs/upstream-flights-api.md)) —
calling it availability would tell someone to retry a change that needs a code fix.

#### The coverage measure

Seven **evidence gates**, each a live fact the drive must harvest before some claims
can be judged at all, and each reading the same transcript note the matching
`it.skipIf(…)` reads — so the measure and the skips cannot disagree:
`flights-search`, `bow-fare`, `bow-fare-option`, `non-bow-fare`, `hotel-rate`,
`hotel-second`, `refundable-probe`.

`coverage.ratio` is `satisfied / 7`, and below **0.75** the verdict becomes
`insufficient_evidence`. That floor is calibrated against the failure mode it exists
for rather than picked round: losing the live Book-on-Wego fare takes out `bow-fare`
and the `bow-fare-option` derived from it, which is 5/7 = 0.71 and lands below it —
correctly, since that one absence silences every fare, handoff and fare-compare claim
in the suite. Losing any single gate is 6/7 = 0.86 and stays `ok`, with the gap named
in `coverage.unevidenced` so a partial run is never silently complete.

#### What it does not claim, and why it stays shadow

It cannot see `bun:test`'s own pass/fail. An assertion that failed for a reason
outside the signals above is `bun:test`'s red to report, and the verdict alone will
say `ok` beside it. That asymmetry is why the CHECK cannot read the verdict alone –
so `gateDecision(verdict, suiteExitCode)` in `live/verdict.ts` **combines the two**
(#1338, 10b): an UNEXPLAINED red fails the check. A red suite beside an `ok` verdict,
or beside a thin-inventory `insufficient_evidence`, is exactly that blind spot and
now fails; a red beside `availability_degraded` that still harvested evidence stays a
warn, because a degraded upstream EXPLAINS the failing assertions and failing there
would re-fuse the two classes the four-way fork exists to separate. The one exception:
a **zero-satisfied-gates** run fails regardless of the collapsed verdict name – a total
outage (every step degraded, nothing proved) is a structural break, not a retryable
warn, so the check keys that on the coverage fact before the availability branch. The
pure function is unit-tested in
`live/verdict.test.ts`; `live/gate.ts` is the thin adapter the post-deploy check
runs, so the matrix is tested TS rather than a bash case-matrix.

This did **not** lift shadow mode. The verdict still never changes the suite's exit
code, and nothing gates deployment or promotion – only the post-deploy CHECK's own
outcome got stricter, which is what hardens the shadow track record's honesty before
a real gate is built on it.

#### `promotionDecision` is the strict counterpart, and it is meant to disagree

`gateDecision` above answers "should this post-deploy CHECK go red". The strict
reading of the same evidence asks a different question, and
`promotionDecision(verdict, suiteExitCode)` (#1516, also in `live/verdict.ts`, also
pure) answers it as a **positive `ok` only**: a green suite, an `ok` verdict, and
**complete** coverage – every evidence gate satisfied, not merely `MIN_COVERAGE` of
them (#1534). So a degraded upstream passes its check and is still not promotable.
The commit status this used to be published as is **gone** (foundations#74 rung 7,
which retired the paired CLI↔API verdict); `promotionDecision` stays because the
strict reading is what makes a run readable, and it is still logged per run.
Still shadow: only the check's outcome gets stricter, never the suite's exit code.

**Why complete and not the floor.** `MIN_COVERAGE` answers "did this run prove enough
to be worth recording", which is the right bar for a verdict and the wrong one for a
promote: a 6/7 run has one funnel claim it never made, and `unevidenced` names it.
The bar used to be unreachable in practice, because a thin run also failed its own
harvest assertions and was rejected as a red suite. `live/inventory.ts` deliberately
removed that coupling, so a thin run now arrives here green and the floor would have
shipped it. Measured against #1510's record, no executed run has ever been exit-0
with an `ok` verdict below 7/7.

**That measurement is true and it did not mean what it was taken to mean.** Every
sub-7/7 run in the record is exit-1 for one reason: the drive spawned its
id-consuming steps against an unharvested id, they exited 2 at argv validation, and
the suite went red. So "nothing that used to pass" was doing no work – the runs the
bar would reject were already failing for a DIFFERENT and fixable reason. Once the
drive gates those steps (`CONDITIONAL_STEPS`, and `argv-guard.test.ts`'s
unharvested-id case), a 6/7 run arrives here green for the first time and the bar
rejects it as designed. The bar is still right; the reassurance was circular.

What makes it affordable rather than merely correct is that the harvests no longer
rest on a single candidate: `hotel-rate` is taken from the first hotel the refundable
probe found a rate on rather than from `hotels[0]`, and `non-bow-fare` reads a second
card when the chosen trip is Book-on-Wego throughout. Both were the coverage shortfall
the record's 6/7 rows share.

`live/verdict.test.ts`, `live/gate.test.ts`, `live/inventory.test.ts` and
`live/user-agent.test.ts` are the four `live/` files that also run in the CI tier –
see layer 1 above for why.

#### An empty live page is not automatically a failure

`live/inventory.ts` (#1534) separates the two reasons a funnel step can come up
empty, which used to be fused at the assertion site:

| observed | the corpus witness | call | what happens |
|---|---|---|---|
| rows | anything | `served` | assert normally |
| none | **> 0** | `ours` | hard red: the corpus had rows and we projected none |
| none | 0 | `thin` | nothing fails; the evidence gates record the shortfall |

Before it, `hotels.test.ts` asserted `results.length > 0` under the comment "DXB
always carries inventory on this route" – an assumption about someone else's
database written as an assertion about our code. Run 476 in
`docs/staging-smoke-agreement.md` is the case where it was false: an empty first
page, dependent steps exiting 2, and a verdict of `ok` beside a red suite, which
`gateDecision` then had to call an unexplained red when coverage explained it
exactly. The rule holds for a **first-page** read; on a later page an empty slice
beside a non-zero total is ordinary pagination.

**The witness is the strongest available one, not the read's self-report.** For the
hotels create page that is `max(metadata.resultCount, hotels-results-wide rows)`,
because run 476 is precisely a case where the two disagree: the create page settled
EMPTY while a wide read of the SAME search returned 8 hotels. Judged by its own
`resultCount` that page can call itself `thin` while the corpus demonstrably had rows
– the `ours` state slipping through the classifier built to catch it. `hotels search`
already asserts `TERMINAL_SETTLED`, so an empty settled page beside a later populated
read of the same search is a wrong settle marker or a dropped projection, and both
are ours. #1534 B2 states the same rule for the tier-B flights capture
(`apps/api/scripts/capture-page-witness.ts`): a guard is only as good as the weakest
link between what it counts and what the suite asserts.

**The cross-check applies to `converged` only.** `budget_exhausted` is the other
terminal state and it means the search stopped by its own admission rather than because
the corpus ran out, so a later read holding rows the first did not is the upstream still
filling — not our projection dropping them. Crossing the two there would hard-red a
healthy slow search, which is the failure class the gating exists to remove.

Two assertions were deleted rather than reclassified, because no witness can tell
their two causes apart: `rooms.rates.length > 0` (a real hotel can honestly have no
Book-on-Wego rate on the dates) and `tally.headlineAvailable > 0` (a city can
honestly have nothing refundable on sale). The `hotel-rate` and `refundable-probe`
evidence gates already record both absences as coverage, which is their honest home.

### The `live/` file map

| Path | Purpose |
|---|---|
| `live/preload.ts` | the whole drive pass, at module evaluation. `bun test` evaluates every `it.skipIf(…)` while collecting files — before any hook — so a `beforeAll` here would race an empty transcript |
| `live/target.ts` | `WEGO_TARGET` → API URL, `srv` host, auth URLs, per-flavor credentials path, and the stored token |
| `live/binary.ts` | compiles the host binary the suite drives |
| `live/driver.ts` | `runCli` / `apiGet` / `probeUpstream`, plus the `local` boot |
| `live/transcript.ts` | the shared store the tests read, and the zod schemas that replaced the old harness's `*Like` interfaces |
| `live/verdict.ts` | the four-way verdict, the coverage ratio, `gateDecision` and `promotionDecision` |
| `live/gate.ts` | the thin adapter the post-deploy check's classify step runs |
| `live/inventory.ts` | the empty-page rule: is an absence ours, or the corpus's? Pure, so the suite it serves can only run against staging while the rule itself is checked in tier A |
| `live/*.test.ts` | assertions only: `auth`, `flights`, `hotels`, `info`, `upstream-fares`, `argv-guard`, `verdict`, `gate`, `inventory`, `user-agent`. `verdict`, `gate`, `inventory` and `user-agent` are the four that also run in tier A |

**`target.ts` reads every host from the target, never from the ambient env**: the
wrapper loads `.env.local`, which pins the STAGING auth host and `srv`, so a `prod`
run would otherwise submit a production refresh token to `auth.wegostaging.com`.
The stored token's expiry is **asserted rather than patched**, and it must have
**15 minutes** of life left, since a drive runs for minutes and `driver.ts`
snapshots the token — a quarter of the real **1 hour** access token (measured;
canonical statement in [`UPSTREAM-B1.md`](../UPSTREAM-B1.md), #1364). No `wego`
command clears that window: `isExpired` uses a **30-second** skew, so a token with
1–15 minutes left is refreshed by neither the proactive nor the reactive path.
`wego login` re-mints.

**`binary.ts` bakes no `WEGO_BUILD_*`**, so `update` / `uninstall` stay degraded
(layer 3 below). **`WEGO_LIVE_BINARY` overrides the compile** and drives an
already-published binary instead (#1516) — `cleanup` becomes a no-op (it is someone
else's file), the real `WEGO_BUILD_*` ARE baked so `update`/`uninstall` are live,
and the refusal then rests entirely on `driver.ts`'s `FORBIDDEN_COMMANDS` plus
`argv-guard.test.ts`. A missing or non-executable path is a `PreconditionError`,
not a red suite.

**`driver.ts` never throws** — a failed step is recorded, so later assertions still
report. That includes a refused destructive command: it is recorded, not thrown, so
the spawn is still prevented without one guarded argv failing every file's import.
Every wait is bounded on the wall clock, since the drive runs outside any
`bun:test` timeout, and no per-probe floor may exceed what is left of that budget.
`FORBIDDEN_COMMANDS` is **exported and imported** by `live/argv-guard.test.ts`,
never restated there: a second literal lets the guard and its completeness test
drift. `bootApi` re-picks a port on a lost bind race (`EADDRINUSE`), which is why it
pipes the child's stderr rather than inheriting it.

**`transcript.ts` closes both settle enums.** `settled` is a **required closed
enum** on both page schemas, and `TERMINAL_SETTLED` is what a `search` step owes — a
bare `results` read owes `"unsettled"`, so both halves of the marker contract are
asserted and neither an absent nor a fourth state passes. Two step lists must stay
**disjoint**: `EXPECTED_STEPS` is what the drive owes unconditionally,
`CONDITIONAL_STEPS` names each step an inventory gate controls plus that gate. A
name in both turns a no-inventory day red, and a test reading a conditional step
must gate on `drove(name)`, since `step()` throws on an absent key.

**The dividing line is whether the step's SUBJECT is harvested**, and it is not a
matter of taste. Five names sat in `EXPECTED_STEPS` while consuming an id taken from
a page `inventory.ts` declares may honestly be empty — `flights-trip`,
`hotels-details`, `hotels-reviews`, and the two `hotels-rooms-*` reads — so a thin
page drove `hotels details 0` and `flights trip ""`, both of which exit 2 at argv
validation with no request made. Membership was satisfied (the step DID run) and the
suite went red for a fact about staging. `hotels-reviews-unknown` stays unconditional
on the other side of the same line: its id is a literal, so no harvest can fail it.
Because list membership cannot express this, `argv-guard.test.ts` asserts it directly
— no driven step's argv may hold `""` or `"0"`. It also holds
the verdict's two inputs: `peekNote` (an absent note is the verdict's DATA, so it
must ask without throwing the way `readNote` does) and `shapeDriftsFound()` — the
schema mismatches `parsed()` records on its way to throwing, the one signal here
that is unambiguously ours. Closing both CLI currency/site source enums here is
also the only detector for a drift back to the API's narrower vocabulary.

**`gate.ts` is the thin adapter the post-deploy check's classify step runs**
(`bun live/gate.ts`): it lifts the `WEGO_LIVE_VERDICT` line from the run log, hands
it plus `SUITE_EXIT` to **both** `gateDecision` and `promotionDecision`, renders the
step summary + `::error::`/`::warning::`, publishes `promotable` /
`promotion_reason` step outputs, and exits non-zero only on a `fail` CHECK decision.

**It writes those outputs on every exit path**, structural failures included —
the caller posts the commit status with `if: always()`, and an unwritten output
reads as not-promotable, which is right but silent.

**`coverage.satisfied` and `coverage.ratio` are CHECKED, not defaulted** (#1477):
a non-numeric one is a named structural failure. The old silent `0` failed in the
safe direction and that was exactly its disguise — a classifier emitting
`satisfied: "6"` reported *"0 satisfied gates – the suite exercised NOTHING"*, a
sentence about staging rather than about the shape break. The OUTCOME is identical
either way (both fail, both refuse promotion), which is what keeps this a
diagnostics change and not a decision change. `coverage.total` stays defaulted to
`EVIDENCE_GATES.length`: it decides nothing, it is only interpolated into the
promotable reason, an absent one put the literal `undefined` in the commit-status
description, and the length is a constant of the classifier rather than a guess.

Every structural message RENDERS the offending value through `JSON.stringify`
(strings included, so `"7"` and `7` cannot look alike) capped at 300 chars, and
`structural()` owns the summary header so a new exit cannot silently emit none.

All the DECIDING is in the two pure functions, so the matrix is unit-tested TS, not
a YAML case-matrix. `gate.ts` is covered by `typecheck` **and** by
`live/gate.test.ts`, which is in the tier-A scope (see layer 1 above).

### The shadow verdict has a clock

The tier-C verdict is still SHADOW, and slice 10b's exit criterion (#1510) is not
"the check has been green for a while" — it is a verdict-vs-HUMAN agreement rate.
So every executed staging smoke owes one row to the record at
`docs/staging-smoke-agreement.md` (repo root). `scripts/staging-smoke-observation.ts`
renders that row from the run's own log and prints it as one paste-ready annotation,
machine columns filled and `unreviewed` in the human one; a reviewer pastes it and
changes one word. Three rules the record depends on, each pinned by a test:

- **Only a run that executed the suite may be a row.** ~94% of the workflow's runs
  are skips, and a skipped run made no claim to agree with — counting one would
  inflate the denominator of the measure the slice is defined by. The step carries
  the same `proceed` guard the suite does.
- **`unreviewed` is not agreement.** It is excluded from the rate and reported
  beside it, so a record nobody has looked at can never read as consensus.
- **The check's own word, not GitHub's.** `gate.ts` publishes a `decision` step
  output (`pass` / `warn` / `fail`), because `steps.<id>.outcome` collapses `pass`
  and `warn` into `success` — and that distinction is precisely what the human is
  agreeing or disagreeing with.

`scripts/staging-smoke-observation.test.ts` covers the rendering, the parse and the
rate under tier A, and also parses the committed record so it cannot rot into a
shape the parser stops reading.

### What it drives

- `whoami`, and the no-credential path (exit 3, stderr only)
- `places` → **the code it resolves is what `flights search` then uses**; no
  hardcoded IATA. `ROUTE_FROM` / `ROUTE_TO` still pin the route by hand
- the four `wego info` reads, each asserting its **resolution echo** and — for a bad
  key — that the guard FIRES. All five guards the retired `verify-info-live.ts`
  proved have a driven step: an unknown market, an unresolvable schedules code, a
  nearby read with no origin (API-direct, since the CLI requires the argument), the
  place-code→coordinates resolution with its anti-geo-IP witness (a `LON` query must
  yield `LHR` and must **not** yield `SIN`/`XSP`, because that upstream ignores
  `code=` and answers from our egress), and the visa-free page walk (`>= 2` upstream
  pages plus `coverage: complete`, since a walk that stops after page 1 reports
  itself as complete). Row count is never the assertion on a resolution path: staging
  genuinely has no schedule rows for some resolved city pairs
- the flights funnel: `search` → `results` (twice, so a settled page is proved not
  to shrink) → `trip` → `fares` → `booking-link`, off a real `kind:"wego"` fare.
  Since #1308 the ranked page carries **cards, no `fares[]`**, so the page is
  asserted to have none and `price.hasWegoFare` is what picks the trip to open; the
  fare id can then only come from the trip read, else it is **live-minted** via a
  `showWegoFaresOnly` search against `srv`. A partner-only route or
  Cloudflare-blocked egress makes the BoW cases skip, not fail
- the trip `?view=detail` projection, driven as `flights trip … --view detail`
  through the real CLI. It used to be an `apiGet` bypass, because the CLI had no
  such flag; adding one also means a 0 exit proves the CLI **parses** that body —
  which `api.ts` had to learn as a union, since detail carries `legs[]` and a
  `provider` object where the default carries `outbound`/`return` and a flat
  `providerCode`. Tier B now reaches this variant too (`capture:flights` records the
  v6-trip + amenities fan-out), so `flights-e2e` parses a real detail body offline;
  the step stays here because it proves the **deployed** API against **live**
  upstreams, a distinct claim from replaying a recorded body
- the retired `?view=default`, asserted to be a **400** rather than a 200 with a
  different shape. Still API-direct, and it has to be — see the `apiGet` note
  below. `?view=card` is not driven on **either** vertical: it is the default
  projection since #1308, so the plain `results` read already covers it
- the hotels funnel: `search` → `results` → `details` → **`rooms` twice** →
  `booking-link`, asserting the dates read mints its own hotel-scoped search and
  returns the hotel's real rate list, that re-reading that same minted search with
  `--search` settles the same way, and that `reference_id` **is** the harvested
  `rateId` rather than merely containing it. The city `searchId` is deliberately
  never passed to `rooms`: the API refuses that scope with a 409
- the refundable-headline contract: no negative may appear, and every `available`
  is confirmed against the hotel's own rate list
- error paths on **harvested** ids — a non-Book-on-Wego fare id, a rate id crossed
  against the wrong hotel — plus the two classes that cannot be harvested (an
  expired fare, a malformed one)
- the fare-compare upstream directly (`live/upstream-fares.test.ts`), which is how
  "an upstream contract moved" stays a different red from "our funnel broke"

Neither vertical has a dark gate, so a flights **or** hotels 503 is a real failure.

### What `driver.apiGet` is for, now that it is not "the missing `--view` flag"

`live/driver.ts` exposes three surfaces, and `apiGet` — the API directly, no CLI —
was introduced for the `?view=` reads the CLI could not request. That reason is gone:
`flights trip` has `--view`, `hotels details` / `hotels reviews` always had it, and
the `hotels results` `?view=card` step was dropped as a re-assertion of the default
projection. **Two bypasses remain, and both are requests the CLI is right to refuse
to build** — not gaps to close:

| Step | Why the CLI cannot drive it |
|---|---|
| `GET /v1/places/nearby` with no origin | `wego info airports-near` requires an origin argument, and should. The 400 is the API's own guard on a caller that skips it |
| `?view=default` on a **results** read | The value #1308 retired. `card` is the only one the API accepts there, so those two reads carry no `--view` at all: a flag would be dead weight for `card` and a way to build a knowingly-invalid request for `default` |

Both are input-validation claims about `apps/api`, driven here because tier C is
where a real deployment answers them. A future `apiGet` needs the same
justification: *the CLI is right to refuse this*, never *the CLI cannot do this yet*.

### Three layers keep the destructive commands unreachable

`update` self-replaces the running executable, `uninstall` deletes it plus the
credentials and the skill, and `logout` unlinks the credential file. All three are
harmless from source and destructive from the compiled binary this tier drives —
against the operator's **real** credentials store, since only `XDG_CONFIG_HOME` is
redirected.

1. **`live/driver.ts` refuses to spawn any of the three**, before the call.
2. **`live/binary.ts` bakes no `WEGO_BUILD_*`**, so `version` stamps `0.0.0-dev` and
   both self-modifying commands take their degraded path. Note what does *not* hold:
   `runningFromSource()` reads the exec-path basename, which is `wego` for a compiled
   artifact, so the version stamp is the entire gate — and an unbaked stamp is a live
   env read. `driver.ts` therefore pins those vars in the child env, so a stray export
   in the operator's shell cannot lift the degradation. **The version pin is not
   empty**: `src/index.ts` reads `process.env.WEGO_BUILD_VERSION ?? "0.0.0-dev"`, and
   `??` does not catch `""`, so an empty value yields a version of `""` — which
   satisfies neither half of the `fromSource || version === "0.0.0-dev"` gate and ARMS
   the destructive path. Measured: pinning it empty did exactly that. So
   `WEGO_BUILD_VERSION` is pinned to the literal `0.0.0-dev`, and only the two URL
   vars are pinned empty, which is how `scripts/build-release.ts` passes them for an
   unbaked channel.
3. **`live/argv-guard.test.ts`** asserts no recorded step named one, and separately
   that every expected step name per track was driven — a set, not a count, because a
   failed step is recorded like a passing one, so a count cannot tell a dropped track
   from a run where everything failed. It also holds the invariant neither step list
   can express: **no driven step's argv may be `""` or `"0"`**, the two spellings an
   unharvested id takes once interpolated. Membership only ever proved a step RAN,
   and `hotels details 0` proved that much.

`bun:test` prints nothing on success, so `afterAll` replays the transcript: the
booking URLs, the fare-option names and the refundability tallies the old harness
printed on every run.

## 3. `wego-cli-sim` — agent acceptance

`bun run test:sim`, documented in [`../scripts/sim/README.md`](../scripts/sim/README.md).
An **agent-acceptance** check that runs
the **real acquisition path** on your real machine: it moves your installed binary
aside and reinstalls it from the deploy's own published `curl | bash` line, where
the **installer itself** places the skill at the user-scope default. A real nested
Claude agent then triggers the skill and drives the funnel from natural-language
conversation.

It alone exercises the download/install path, skill **triggering**, and whether
an autonomous agent can actually *use* the CLI.

The verdict gates only on plumbing: install, `whoami`, the skill was invoked, and
an env-coherent booking link. It deliberately does **not** re-assert shapes or
errors — that is layer 2's job.

### It runs on your real machine, with no sandbox

There used to be a per-scenario sandbox `HOME`, and it was removed because it
broke the **nested engine's own login**: both `HOME` and `CLAUDE_CONFIG_DIR`
relocation make `claude` report `Not logged in`, so isolation required a second,
hand-minted per-machine credential.

Acquisition coverage survived that removal, because the sandbox's real job was
manufacturing the precondition *"the CLI is absent"* — and **renaming the
installed binary aside manufactures the same thing** on a real machine. So the
published install line still runs for real, and the assertion is that it
**created** the binary and that its own skill step ran (proven by the CLI's
ownership marker, not by a presence check).

There are therefore **no env overrides at all** now: the nested session inherits
your environment, filtered only by an allowlist. That absence is pinned by
`scripts/sim/sim-env.test.ts`. `flavor-guard.ts` and its
sandbox `PATH` stubs are gone with it — cross-flavor safety is now one preventive
layer (`--disallowedTools Skill(<other>)`) plus a **gating** check that fails the
run if any command invoked the other flavor's binary.

### It reads from the live channel, not your tree

Both the binary and the skill come from the **live release channel**
(`cli/next`, `skill/next`): the installer downloads the binary, and that
binary's own `skill install` fetches the skill. Never your working tree.

So a change must be merged — and, for CLI code, released — before this harness
can see it. Use layer 2, layer 4, or `.claude/skills/wego/evals/` to iterate
pre-merge. See `scripts/sim/README.md` for the gotchas.

## 4. `bun run eval:persona` — answer quality

`persona/`, run from `apps/cli` or from that directory. A simulated traveller
drawn from a real passenger segment talks to a `claude -p` driven by the **working
tree's** skill; that agent drives the target flavor's **installed** binary
(`wegostaging` by default) against live staging through a recording proxy. The
skill is the working tree's and the CLI is not, so a change under `src/` is
invisible here unless `WEGO_PERSONA_BIN` names another binary. Human-run, **not in
CI**, and not a gate.

Every layer above asserts against a fixed expectation, so none of them can say
"the funnel worked and the traveller still got a bad answer". This one can, because
it has no fixed expectation at all: it grades the conversation that actually
happened.

Its ground truth is the **agent's own recorded traffic**. The proxy records every
request the CLI made and every response the API sent back, so the transcript can
prove what the assistant read, what it was told, and whether a link or a country it
presented came from a real response rather than from its own knowledge.

`.claude/skills/wego/evals/` is not superseded by this layer: it keeps the **frozen
regression set**, since live inventory moves and a red today against a green
yesterday may be the world rather than a change of ours.

Three properties worth knowing before reading the tree:

- **Exactly two scores**, matching the mocked eval's shape: `has_triggered`, and
  `response_quality` as the mean of every other criterion. Each criterion is one
  `closedQA` call over the whole transcript, binary.
- **Anything code can decide is precomputed**, in a harness-checks section the
  criterion then reads: the byte-identical link comparison, which country code sat
  in a request path, whether a read set a page size. Comparing long URLs with opaque
  ids is what an LLM is worst at and code is perfect at.
- **Under-searching is out of reach.** A recorded call proves what the assistant
  read, never what it failed to look for. An earlier version added an independent
  unfiltered re-read to cover that, and it was cut: a second search is a different
  search instance, so a difference proved nothing, while the recording already proved
  invention outright.

Full detail: [`../persona/AGENTS.md`](../persona/AGENTS.md).

## How they overlap

The four overlap only on "the funnel reaches a booking link on live staging".
Layer 2 is the contract foundation (a locally compiled CLI ↔ the API); layer 3 is
the **acquisition** layer stacked on top — it installs the *published* binary from
the live channel, which layer 2 deliberately does not; layer 4 stacks an **agent
and a judge** on the layer-2 foundation, grading the working tree's *skill* rather
than a released one, so it is the only live layer that can run pre-merge.

Layers 2, 3 and 4 all hit live staging. Layer 2's **`staging` target runs in CI**,
on a token minted by `scripts/ci-staging-token.ts`; its `local` / `prod` targets,
and layers 3 and 4, are human-run and reuse your own stored login token, which for
layer 4 is the `wegostaging` one. 2 and 3 are release-time smoke tests at different
layers, and 4 is a judgment instrument you run while changing the skill.
