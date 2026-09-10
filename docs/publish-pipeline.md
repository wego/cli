# Build and publish pipeline

The scripts behind a CLI release. The **runbook** — how to cut a release, the
pipeline stages, rollback, go-live — is the single source of truth in
[`apps/api/docs/cli-release.md`](../../api/docs/cli-release.md). This page
documents what each script does and why, so nobody has to read the runbook to
change one.

## `scripts/build-release.ts` + `scripts/release-config.ts`

Cross-compile the one `wego-*` build for every platform (`bun run build:binaries`,
no arguments) and validate its canonical public config bundle before deleting or
producing artifacts. The backend is chosen at run time by `--target`, so there is
one Environment rather than one per flavor,
and one artifact set for the publish job to take.

The builder:

- Maps canonical inputs to internal static `WEGO_BUILD_*` compiler symbols.
- Bakes the public PKCE `client_id` and the release version.
- Passes `--no-compile-autoload-dotenv`, so a stray `.env` in the tester's CWD
  can't silently override the baked config.
- Takes the version from `RELEASE_TAG` (`cli-vX.Y.Z` → `X.Y.Z`, set by the release
  workflow). A local build with no tag stamps `0.0.0-dev`.
- Bakes `WEGO_BUILD_FLAVOR` – one value now (`wego`), kept as a baked key rather
  than a literal so `update` and the publisher still read the asset-name prefix from
  one place. **No channel base is baked**: `update` and the new-version notice both
  read the ring the installer recorded (rung 3), so retargeting an install is a file
  write rather than a rebuild, and there is no second source of truth to drift.
- Bakes the optional PostHog key **explicitly with `?? ""`**, so an ambient
  `WEGO_BUILD_*` can't leak into the binary. (The skill store origin was baked
  the same way in wego-ai; the skill channel is not present in this repository,
  so there is nothing left to bake beside the key.)

Output goes to `dist/` (gitignored): each binary plus a `gzip -9 -n -k`
`<asset>.gz` copy (issue #1235). `bun --compile` output is ~99.5% embedded Bun
runtime — an empty `console.log` compiles to 63.45 MB on darwin-arm64 against our
63.79 MB — so nothing at build time can shrink it, but it compresses ~2.7×
(63.8 MB → 24.0 MB), and the download is the whole install cost. The workflow's
manifest step is `sha256sum *`, so the archives enter `SHA256SUMS.txt`
automatically and are covered by the promote consistency barrier and
`verify-published.sh all`. **Both consumers now fetch them gz-first** (this
change): `/install` and `wego update` download `<asset>.gz`, decompress it, and
verify the DECOMPRESSED binary against the raw asset's `SHA256SUMS.txt` line — the
check that counts, since the binary is what runs. The gz is **preferred, not
required**: an **absent** gz (HTTP 404 — a channel frozen from a pre-#1235 tag
carries none) falls back to the raw asset, verified fail-closed all the same.
`/install` additionally falls back when the host lacks a `gunzip` command;
`wego update` decompresses in-process with `Bun.gunzipSync`, so that condition
never applies to it — it falls back only on the 404. A gz that is **present but
bad** — a hash mismatch on either path, or a non-404 HTTP status / transport
failure — is a hard abort, never a silent downgrade to a different download. Raw
binaries are never
removed: every already-shipped `update` has its raw asset name baked in, so the
fallback always has a target. `verify-published.sh` also decompresses the native
`<asset>.gz` and asserts it round-trips to the raw binary, so the gz path cannot
rot the way the unconsumed archives could have.

The workflow writes one more file into `dist/` immediately before that manifest
step: **`VERSION`**, the bare version string (`0.4.2\n`) from the release tag. It
rides the same free path the archives do — into `SHA256SUMS.txt`, then copied by
`upload-release-blob.ts` and hash-verified by `waitChannelConsistent`. It is the
one asset copied **after** the manifest commit point, because it is an
advertisement rather than a deliverable (see phase 2 below). It exists because the
channel otherwise carries **no** version string: `wego update --check` compares
checksums, so it can report *that* a newer build exists but never *which*. The
installed binary's proactive notice (`src/version-notice.ts`) reads it in the
background and names both versions. Absence is always silent — every tag published
before this change has no `VERSION`, as does a locally built `--freeze`.

`release-config.ts` adds two guards:

1. A **production-host pin** on the baked auth and api endpoints: each must be a
   `wego.com` host, or the build fails. The retired flavor axis policed this as a
   two-way cross-check (a `wegostaging` build's hosts had to contain
   `wegostaging`, a `wego` build's had to not). With one build there is no label
   left to contradict, but the danger grew rather than went: a `Production – cli`
   Environment mis-set to staging values would compile staging endpoints into the
   binary everyone installs, and no second build's absence would be noticed.
2. It **pins both baked channel bases to the release Blob host family**
   (`*.public.blob.vercel-storage.com`), as a suffix match so a store migration
   stays possible. That pin exists because a baked base is compiled into a public
   binary and the client-side SHA256 verify cannot detect a wrong origin — an
   attacker host would serve the `SHA256SUMS` too. Reaching it needs
   GitHub-Environment write access, so this is defence-in-depth.

## `scripts/upload-release-blob.ts`

Publishes `dist/*` to a **public** Vercel Blob store (stable, no-suffix
pathnames), so `apps/api`'s `GET /install` fetches binaries with no auth.

### Two phases

1. **`put`** each file to immutable `cli/<tag>/*` — no-overwrite, cached hard.
   Idempotent: it skips already-present files and treats an already-published
   conflict (matched broadly, including precondition and ETag) as success, so a
   partial-upload re-run resumes.
2. Server-side **`copy`** each frozen `cli/<tag>` blob to the ring being advanced
   (short cache), so the ring is byte-identical to the published version even on a
   rebuilt re-run. The release workflow advances `cli/next`; `promote-cli.yml`
   later copies the same frozen blobs to `cli/stable`, which is why the two rings
   serve identical checksums and a promote is never a rebuild.

Phase 2 is **manifest-last and consistency-gated**: it copies the binaries first,
copies `SHA256SUMS.txt` (the commit point) **last of the deliverables**, then
blocks on `waitChannelConsistent` until the channel's own served manifest and
every binary it lists agree. A channel is therefore never reported advanced while
a consumer (`wego update`, `/install`, the release self-update smoke) could
observe a fresh manifest fronting a still-propagating binary — the read-after-write
race that fail-closes those verifiers. No pointer indirection; see PR #1054.

`VERSION` is then copied **after** that barrier, with a second barrier that
re-compares the manifest and reads only that one new body (`skipAssets` in
`blob-consistency.ts` — the first barrier skips `VERSION`'s body, the second skips
the deliverables' bodies, and **both compare the full manifest**, because a
trimmed expected map is a size mismatch `sameSums` can never resolve). The
publisher's second barrier does verify `VERSION`; what no **installed-client**
verifier consumes is `VERSION` itself — `wego update` and `/install` cross-check a
binary against the manifest and never read it, so the notice is its only reader
once the release is published. Advertised early, it would name a release the
channel cannot yet serve — the user is told to update, `wego update` reads the
still-old manifest and reports itself current, and because the notice **persists**
its answer, one propagation window becomes a whole throttle window (24h on prod) of
that contradiction. Advertised late, a stale `VERSION` only delays a notice.

### Three rings, three moving pointers

`cli/edge`, `cli/next` and `cli/stable` (foundations#74 rungs 4 and 7). The set and
the crossing rules live in `scripts/ring-rules.ts`:

| Ring | Serves | Advanced by |
|---|---|---|
| `cli/edge` | `X.Y.Z-edge.<sha>` only | `edge-cli.yml`, every merge to main |
| `cli/next` | plain `X.Y.Z` | `release-cli.yml`, every release |
| `cli/stable` | plain `X.Y.Z` | `promote-cli.yml`, a human decision |

`next` and `stable` serve **byte-identical** builds, proved at promote time by
diffing `SHA256SUMS.txt` from both. Each api deploy points
`CLI_DOWNLOAD_BASE_URL` at the ring it serves by default, and that base's last path
segment IS the ring the installer records for `wego update` to follow (rung 3).

The pre-ring `cli/latest` and `cli/staging` prefixes are no longer written by
anything and no longer pointed at: rung 7's cutover repointed both api deploys onto
`cli/stable` and `cli/next`. They still hold the last flavour-era release, which is
all they are now - see `apps/api/docs/runtime-configuration.md`, "CLI installer
bundle".

### Modes

| Invocation | Effect |
|---|---|
| bare `<tag>` | phase 1 + advance the **one** ring the tag belongs on. A local one-shot reproduces the release job's routing. |
| `--freeze <tag>` | phase 1 only, advances **no** pointer. The release workflow uses this so a pointer is advanced by a separate `--promote` only *after* the frozen artifact is smoke-verified. |
| `--promote <tag> [--to next\|stable] [--require-serving <ring>]` | phase 2 only: copy an already-published `cli/<tag>` to the ring, no local build. For a promote, or a rollback. |

`--to` defaults to `next`. A crossed pair is refused: `edge` takes only
`-edge.*` versions, `next` and `stable` only plain `X.Y.Z`, because `update`
replaces on a checksum difference and never compares versions - whatever a ring
serves is what its install base receives next. The rule is
`scripts/ring-rules.ts`, shared with the release workflow's gates.

`--require-serving <ring>` refuses unless that ring already serves the tag, read
from the same store the write targets. `promote-cli.yml` passes
`--require-serving next`, so a promote can only ship the build people have actually
been running; its `allow_not_next` input drops that check for a rollback.

`--freeze` / `--promote` take the tag from argv **only** — no `RELEASE_TAG`
fallback, so a stray export can't promote the wrong version. An unknown `--flag`
in either position is rejected up front, and `--promote` rejects an unpublished
tag.

The `-rc.N` scheme is gone (rung 7). The only prerelease line is `cli/edge`, and
`release-cli.yml` refuses a prerelease tag outright rather than routing it.

### The signed build record (foundations#74 rung 9)

Before any pointer moves, the publisher requires a **signed build record** for the
tag and refuses on absence as well as on a bad record: "no record yet, advance
anyway" is the state an attacker would arrange. Three checks, all fail-closed:

1. a record exists at `cli-sig/<tag>/SHA256SUMS.txt.sigstore.json` - a prefix
   **outside** the `cli/*` downloads, because a record the same store write could
   replace would prove nothing;
2. `verifySignedManifest` accepts the signing identity **for the ring being
   advanced** - an edge record does not vouch for a release ring, or vice versa;
3. `manifestCoversAll` - every object being served is listed, so an omitted object
   is an object nothing signed.

**The workflow must sign with `cosign sign-blob --new-bundle-format.`** On cosign
2.5.x `--bundle` alone writes the legacy cosign bundle
(`{base64Signature, cert, rekorBundle}`), and `@wego/release-signing`'s
`parseBundle` reads only the Sigstore protobuf bundle - it goes for
`verificationMaterial`, which the legacy shape has no key for. The publisher then
refuses the ring it just uploaded to, with `malformed DER: bundle is not an
object`. That killed edge run `32930712877` and then the first real release, run
`32977203696` (`cli-v0.7.0`), because the flag had been added to `edge-cli.yml`
only. Both lanes now carry it and `.github/workflows-gate.test.ts` pins the format
across every workflow that signs.

### Commit-binding

When `RELEASE_COMMIT` is set (the workflow passes `github.sha`), the first publish
writes an immutable `cli-sig/<tag>/COMMIT` sidecar (`commitSidecarPath`). A later resume whose commit
differs is **refused** — bump the version instead. Since `bun build` is
non-reproducible, this stops a rerun after the branch moved from pairing a tag
with binaries from another build.

An unreadable or empty sidecar is a hard refusal, never fail-open. A same-commit
resume racing Blob read-after-write re-reads and continues.

**It lives on the RECORD prefix, not beside the downloads**, and that placement is
load-bearing rather than tidy. Rung 9 requires every object under `cli/<tag>/` to be
listed in the signed manifest, and this sidecar cannot be: the publisher writes it
after the manifest was hashed and signed. Both rules are right, and they first met on
`cli-v0.7.1`, which published and verified all 13 objects and then refused its own
pointer move with `COMMIT is not listed in the signed SHA256SUMS.txt`
(run 33036257401). On `cli-sig/` the sidecar sits outside what coverage scans, so
neither rule bends – and nothing unsigned is served, which the old placement could
not claim.

Two things it is deliberately NOT:

- **not exempted from coverage.** An exemption is a permanent hole in "a pointer can
  never name an unsigned file", and this sidecar's whole job is to be trustworthy
  enough to refuse a mismatched resume.
- **not written into `dist/` to get itself signed.** That would work once and rot:
  phase 1 is idempotent, skipping already-present files and treating an
  "already exists" put as success, so a resume from a DIFFERENT commit would have its
  mismatch silently swallowed – the guard still present, no longer guarding.

The same coverage rule also runs against `dist/` in `--freeze`, before anything
uploads, so a manifest that omits a file fails at the producer instead of nine steps
later at the pointer move. Failing early costs a build; failing at the pointer move
costs a version number, because this very sidecar makes a re-publish from a different
commit impossible.

### Other behavior

`REQUIRE_PUBLISH=true` makes a missing `BLOB_READ_WRITE_TOKEN` **fail** (exit 1)
instead of skipping gracefully; the workflow sets it for a deliberate release.
Malformed tags are rejected, and releases serialize via the release job's
`release-cli` concurrency group - one group, because every release writes the same
`cli/next` pointer and a split would let two interleave on it. It appends `store_origin=…` to `$GITHUB_OUTPUT` when set (for
the workflow smoke test) and prints the `CLI_DOWNLOAD_BASE_URL` base for each
channel it advanced.

## `scripts/blob-consistency.ts`

The channel **consistency barrier** for the promote above.

A moving channel is advanced by a **non-atomic** multi-object copy over a CDN, and
every verifying consumer reads two coupled objects (`SHA256SUMS.txt` + a binary)
and cross-checks them. So a brief window can serve a fresh manifest next to a
stale binary, which fail-closes `wego update`, `/install`, and the release
self-update smoke — the root cause of a Smoke-3 failure.

`waitChannelConsistent(base, expectedSums, deps)` polls the channel's OWN served
URLs (the exact plain GETs a consumer makes) until the served manifest equals the
tag's and every binary hash-matches, then returns. It throws after a bounded
budget (default 24 × 5s, longer than the 60s cache TTL), so a genuinely
mismatched publish fails rather than hangs.

Plus the pure `parseSums` / `sameSums`. Dependency-injected (fetch, hash, sleep,
log) so it unit-tests without network or a Blob store
(`blob-consistency.test.ts`).

## `scripts/update-smoke.sh`

**Tier-A faithful `wego update` self-replace smoke.**

It takes a REAL previously-published binary and runs its own `update -y`, which
follows the release ring recorded in `install.json` (this script arranges that
record from `--ring`, see below), asserting it self-replaces in place to the
expected version. Nothing is mocked: real compiled binary, real HTTPS to the real
Blob channel, real fetch → gunzip (gz-first, issue #1235) → verify → atomic
rename. Once the released predecessor prefers the archive, this drives the
download-and-decompress path end to end for real — no extra flag.

It **SKIPs** (exit 0, never a false fail) any build that can't self-update by
design: one that predates the `update` command, has no recorded ring to follow
(source or pre-go-live), or is Windows. POSIX self-replace only.

**`--ring <name>`** (foundations#74 rung 3). A predecessor that follows a
*recorded* ring finds no record here, because this script places a binary rather
than installing one. On that refusal it writes the record the installer would
have — the ring the caller named, and the install URL the refusal's own reinstall
line printed, so no host is hardcoded — then re-runs the real `update -y`. One
record, in the one `wego` config dir: the flavour axis died with rung 2, so a
predecessor a ring can serve is always the `wego` build and picks that directory.
Everything lands under a temp `XDG_CONFIG_HOME`, so no run touches the operator's
`~/.config` or leaves a record that could satisfy a later run. No `--ring` against
such a predecessor is a FAIL naming the flag, never a skip.

The release workflow's **Smoke 3** wires it against `cli/next` — the one ring that
workflow advances — reading its predecessor from the immutable `cli/<prev-tag>/`
prefix, which does not move, so a rerun reads the same genuine older bytes in any
order with nothing persisted. Local shift-left is documented
in [`apps/api/docs/cli-release.md`](../../api/docs/cli-release.md) → "Verify a
release".

## Local builds

Quick check with no publish: load one complete canonical env bundle, run
`bun run build:binaries`, then run `dist/wego-<os>-<arch>` directly (add
`--target staging` to point it at the cheap backend). Before go-live you can also just hand
someone the single standalone binary — no channel needed.

Use the workflow for a real release: it is the path that builds the one artifact
set under the `Production – cli` Environment before publishing.

**Overrides still work.** An explicit exported env var (for example
`WEGO_API_URL=https://…`) overrides the baked value. The dropped `.env` autoload
means only *explicit* env wins, never a stray file.
