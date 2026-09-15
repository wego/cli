# Contributing to the `wego` CLI

Thanks for taking the time. Please read the next section before you write any
code, then the rest when you are ready to open something. This document covers
how we take contributions, what this repository is for, how to build and test
it, and what happens to a pull request after you open it.

<!-- TBD(#141): the TBD- tokens below are placeholders and must be replaced
     before this file is merged. See wego/foundations#141. -->

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
bun run dev -- places "singapore"     # run from source
```

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
merges. CI must be green.

**We aim to respond to a new issue or pull request within `TBD-RESPONSE-WINDOW`,
through `TBD-ROTATION`.** If nothing has happened after that, it is fair to say so
on the thread.

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
