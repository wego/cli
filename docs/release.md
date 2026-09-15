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

Fires on `push: tags: ['v*']`. Four jobs, in order:

- **`prepare`** – refuses a tag that is not on `main`, then lint, format,
  typecheck and unit tests.
- **`build`** – the five-target matrix. **No `environment:`**, deliberately: this
  job never touches the store, so it cannot reach the store token.
- **`release`** – `environment: production`, `concurrency: group: ring-next` with
  `cancel-in-progress: false`, because a cancel mid-copy is a half-moved ring.
- The commit-point order inside `release` matters and is fixed: **binaries and
  the `COMMIT` sidecar first, then the record, then `SHA256SUMS.txt`, then a
  consistency barrier, and `VERSION` last.** A reader that sees the new `VERSION`
  is guaranteed to find everything it names.

Gates the run has to pass, in the order it meets them:

| Gate | What it refuses |
|---|---|
| Refuse a non-`main` commit | A tag cut off a branch |
| Build smoke | A binary that does not run |
| **Distinguishable from a pre-relay install** | A build whose update path sends no user agent. Runs the freshly compiled binary against a loopback listener and fails **before the run's first store write** |
| Publish immutable `cli/<tag>/` | `allowOverwrite: false`. On "already exists", hashes local against served and fails loud on a mismatch |
| Commit binding | A resume of this tag from a different commit. `bun build --compile` is not reproducible, so mixing two builds under one version is refused outright |
| Verify the prefix, identity gate | A record not signed by an identity `identitiesForRing()` accepts |
| Refuse to move `cli/next` backwards | A tag older than what the ring already serves |
| SMOKE 3 | The predecessor on `cli/next` failing to self-update onto these bytes |
| SMOKE 4 | The binary this run built failing to update **itself**. Expects "already up to date", asserted, because `cli/next` now serves exactly these bytes |

SMOKE 3 proves machines can *arrive* at this version. SMOKE 4 proves one can
*leave* it. Both exist because a release once shipped a binary that could never
update again while every other check passed.

---

## An edge build

`edge-cli.yml` runs on every push to `main`. Version is `package.json` plus
`-edge.<sha>`, shallow checkout, `concurrency: group: ring-edge`,
`environment: production`. It uses the same publisher as the release lane:
`--freeze` to write the immutable prefix, then a separate `--promote --to edge`.

Edge carries its own signing identity, distinct from the release one.

---

## A promote

`promote-cli.yml`, `workflow_dispatch` only. Inputs: `tag`, and `allow_not_next`
for the rollback path.

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
stands. Its gates:

- A completed, **successful** `release-cli.yml` run must exist for the tag.
  `allow_not_next` does not bypass this.
- The tag's tree must be able to publish the plugin, checked **before** the ring
  moves, so a promote cannot succeed having silently published nothing.
- The legacy bridge pin must be answering.
- The tag's binary must be distinguishable from a pre-relay install.
- After the move: `cli/next` and `cli/stable` must serve byte-identical
  manifests, and a promoted binary must report itself current.

Then the plugin publishes to `wego/skills` from the tag's own tree.

---

## A rollback

Rolling `cli/stable` back is a promote of an earlier tag:

```
promote-cli.yml  with  tag=vX.Y.Z  and  allow_not_next=true
```

`allow_not_next` relaxes **which** tag may be promoted – it drops the requirement
that `cli/next` already serves it. It does not bypass the requirement that the
tag has a successful release run behind it.

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

There is no automatic notice when Fulcio rotates. That is what the check below is
for.

---

## Quarterly dependency check

Once a quarter, and always before a release that changes the verifier:

1. Compare `src/release-signing/sigstore-roots.ts` against
   `https://fulcio.sigstore.dev/api/v1/rootCert`. A difference is a code change,
   reviewed, released and promoted like any other.
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
