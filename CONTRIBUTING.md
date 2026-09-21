# Contributing to the `wego` CLI

Thanks for taking the time. Please read the next section before you write any
code, then the rest when you are ready to open something. This document covers
how we take contributions, what this repository is for, how to build and test
it, and what happens to a pull request after you open it.

## Open an issue first. Always.

**Please do not send a pull request we have not discussed.** Open an issue,
describe what you want to change and why, and wait for a maintainer to respond
before you write the code.

This is not a formality, and it is not about code quality. The `wego` CLI is
built to a roadmap that is not public, and it has obligations that are not
visible from the source: it is the runtime behind a published agent skill, its
output shape and exit codes are a contract other software depends on, and its
release pipeline is held to guarantees about what an installed binary can be
made to do. A change can be well written, well tested and still conflict with
something we have already committed to.

So please take this seriously: **a contribution may be declined because it
conflicts with our roadmap, even when there is nothing wrong with it.** We would
much rather tell you that in a five-line issue reply than after you have spent a
weekend on a branch. If we say no, it is not a judgement on the work.

An issue also lets us tell you the thing you could not have known: that a fix is
already in flight, that the real problem is server-side, or that the behaviour
you are seeing is deliberate.

## What belongs here

This repository is the `wego` command: a public OAuth + PKCE client that logs a
user in against `auth.wego.com` and drives the Wego API as that user. It holds no
secret of its own.

Most likely to be accepted: bug fixes, clearer errors and help text, output and
formatting fixes, portability fixes, and tests. Still open an issue first, but
these rarely conflict with anything.

Needs a real discussion, and is most likely to be declined: new commands, new
flags, changes to the JSON envelope or to exit codes, anything touching the login
flow or credential storage, and anything touching the release or signing lanes.
These have consequences outside this repository.

The Wego API itself is not in this repository. If the fix belongs server-side,
say so in an issue and we will route it.

## Getting set up

You need [Bun](https://bun.sh). The version is pinned by the `packageManager`
field in `package.json`. Do not use `npm`, `yarn` or `npx`; use `bunx` for
one-offs.

```bash
bun install
cp .env.local.example .env.local      # public OAuth config, no secrets in it
bun run dev -- places "singapore"     # run from source
```

Without `.env.local` the CLI refuses any command that talks to the API and names
the variable it wanted. That is deliberate, not a bug.

### Running `wego` from source

The repository ships an `.envrc`. With [direnv](https://direnv.net) installed,
`direnv allow` once and `wego` inside the repository resolves to `.bin/wego`, a
symlink to `src/index.ts`, executed directly with no compile step. It also
exports `.env.local` into your shell, so `wego` works from any subdirectory
instead of only the repository root. direnv restores your previous `PATH`
verbatim when you leave, and each worktree gets its own source.

**This matters more than it looks.** Without it, typing `wego` runs whatever is
installed on your machine, which for most people is the released production
binary. You can then "test" a change and watch nothing happen, because you never
ran your own code. If you would rather not use direnv, either go through
`bun run dev --` every time, or `bun link` once. Either way, check `which wego`
before you trust a result.

## Signed commits

**Every commit that reaches `main` must carry a signature GitHub can verify.** A
repository ruleset enforces it, and that ruleset has an empty bypass list — no
maintainer, no administrator and no organisation owner can merge past it. Unsigned
commits make the merge box say *"Commits must have verified signatures"*, and it
stays that way until you fix it.

This is not the release signing described in `docs/release.md`. That is
[cosign](https://docs.sigstore.dev) proving which workflow built a published
binary. This is git proving who wrote a line of source. Both exist because a
release is only as trustworthy as the commit it was built from, and git's author
field is free text: anyone can commit under your name and address, and nothing
checks it. A signature is what turns that claim into something verifiable.

Setting it up is three steps, and **the third is the one people miss**.

### 1. Tell git to sign

SSH signing reuses the key you already push with, so there is no GPG keyring to
manage:

```bash
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/id_ed25519.pub
git config --global commit.gpgsign true
```

Use your own public key's path if it differs. To scope this to one repository
rather than your whole machine, drop `--global` and run it inside your checkout.

### 2. Confirm git is actually signing

Deliberately without `-S`, so this tests the configuration rather than bypassing
it:

```bash
git commit --allow-empty -m "chore: signing check"
git log --show-signature -1
git reset --soft HEAD~1      # discard it; the commit was empty, so nothing is lost
```

### 3. Register the key with GitHub — as a *signing* key

Go to [github.com/settings/ssh/new](https://github.com/settings/ssh/new), paste
the contents of your `.pub` file, and **change the "Key type" dropdown to Signing
Key**. It defaults to *Authentication Key*, and an authentication entry does
nothing for signatures — even when it is the same key you already push with. A key
GitHub knows for access is not a key GitHub will verify signatures against; it
needs its own entry.

Miss this and your commit is signed but reports `unknown_key`, which reads like a
git problem and is not one.

### Checking, and fixing what you already pushed

```bash
PR=123     # your pull request number
gh api "repos/wego/cli/pulls/$PR/commits" --jq \
  '.[] | "\(.sha[0:7])\t\(.commit.verification.verified)\t\(.commit.verification.reason)"'
```

| `reason` | What it means | Fix |
| --- | --- | --- |
| `valid` | Nothing to do | — |
| `unsigned` | git is not signing | Step 1 |
| `unknown_key` | Signed, but GitHub does not know the key | Step 3 |

**`unknown_key` needs no new commit.** GitHub verifies at read time, so registering
the key retroactively verifies what is already pushed. Re-run the check above.

`unsigned` does need the commits rewriting:

```bash
git rebase --exec 'git commit --amend --no-edit -S' origin/main
git push --force-with-lease
```

Only on a branch you own — rewriting a branch someone else has checked out breaks
their copy. The ruleset covers `main` only, so your feature branch takes a
force-push without complaint.

## Before you open a pull request

```bash
bun run lint         # Biome
bun run format       # Biome, writes
bun run typecheck    # tsc --noEmit
bun test             # unit tests
```

All four must be clean. `ci-cli` runs the same checks and is a required check on
`main`.

One note on running tests locally: a few tests assert that an unreadable file
fails closed, which cannot hold when the test runs as **root**, because root
bypasses file permission checks. If you are in a container that runs as root you
will see those fail locally while CI is green. Run as an unprivileged user to get
a true result.

## Commit messages

This repository uses [Conventional Commits](https://www.conventionalcommits.org).
They are not decoration: release-please reads them to compute the next version
and to write the changelog.

```
fix(update): keep the ring when the manifest is unreadable
feat(hotels): add --sort for room rates
docs: explain how a promote picks its bytes
```

`fix:` produces a patch release, `feat:` a minor one, and a `!` or a
`BREAKING CHANGE:` footer a major one. `docs:`, `chore:`, `test:` and `refactor:`
produce no release.

**Your pull request title matters more than your commit messages.** Pull requests
are squashed, and the squash takes its subject from the title, so the title is
what release-please actually reads.

## What happens next

`main` requires a review from a code owner, so every change is reviewed before it
merges. CI must be green, and every commit must be signed — see
[Signed commits](#signed-commits) if the merge box is asking for verified
signatures.

**We will do our best to respond, but we cannot promise when.** This repository
is maintained by a team with its own roadmap and on-call load, and issues and
pull requests are picked up as those priorities allow rather than in the order
they arrive. Some threads are answered the same day and some sit for a while.

A quiet thread is not a rejection and not a decision. If something has gone
unanswered and you are still interested, adding a comment to say so is welcome
and often enough to surface it.

Merging does not publish anything. A release is a separate, deliberate act, and
reaching users is another one after that: `docs/release.md` describes both.

## Security

Do not report a suspected vulnerability in a public issue. `SECURITY.md` has the
private route.

## Licensing

This project is licensed under Apache-2.0; see `LICENSE`. Section 5 of that
license already covers contributions: anything you intentionally submit for
inclusion is licensed under the same terms unless you say otherwise in writing.
There is no contributor licence agreement to sign and no sign-off to remember.

There is deliberately no `NOTICE` file. Apache-2.0 only requires propagating a
`NOTICE` that a licensed dependency actually ships, and nothing bundled into the
released binary carries one: the single runtime dependency is `zod`, under MIT.
The two `NOTICE` files present in a development checkout belong to the TypeScript
compiler packages, which are build-time only and never shipped.
