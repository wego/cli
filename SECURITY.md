# Security policy

## Reporting a vulnerability

**Use the *Report a vulnerability* button on this repository's [Security
tab](https://github.com/wego/cli/security/advisories/new). That is the channel
we prefer.** `security@wego.com` also reaches us, and is the right choice if you
would rather not use GitHub for this.

We prefer the Security tab because a report there can be taken into a temporary
private fork and fixed there. `main` is public and `edge-cli` publishes on every
merge to it, so a vulnerability fixed in the open is disclosed by its own diff
before the fixed binary reaches a single user. Nothing else in this repository
closes that window. A report there also notifies all ten repository admins,
rather than landing in one mailbox.

Reporting this way is not what lets us publish an advisory. We can do that
either way, and always could. It only changes where the fix is developed.

Report anything you think is a security problem. We would rather look at a
report that turns out to be nothing than miss one because you were unsure it
counted.

Do not open a public issue for a suspected vulnerability, and do not raise one
through a pull request or a discussion. If you have already done so, use one of
the two channels above rather than adding detail to the public thread.

Please include what you did, what you observed, and what you expected, along with
the CLI version (`wego version`), your operating system and architecture, and
whether you were following `stable`, `next` or `edge`. A proof of concept helps.

This is not a bug bounty program. Wego does not currently offer or guarantee
monetary rewards for reports submitted under this policy.

**What to expect:** we will acknowledge your report and keep you informed while
we work on it, but **we cannot promise when.** Acknowledgement is not a fix:
how long a fix takes depends on what you found, and we will tell you what we
know as we know it. We will tell you when a fix is released, and we are glad
to credit you unless you would rather we did not.

Please give us reasonable time to fix an issue before disclosing it publicly.

## Supported versions

Only the version `cli/stable` currently serves is supported. There are no
long-term support branches and no backports to earlier versions.

`wego update` is the upgrade path. It compares the binary you have against the
bytes the ring serves, so it moves you to the supported version regardless of
which version you are on.

## Scope

**In scope**

- The `wego` binary itself: credential handling, the OAuth + PKCE login flow,
  token storage on disk, and command output.
- The self-update path, including signature verification and how an update
  decides what to install.
- The release pipeline in this repository, and the signed build records it
  produces.
- The install script served from `/install`.

**Out of scope**

- The Wego API and website. This policy covers the CLI and its release pipeline;
  reports about the wider Wego platform are triaged by Wego's security team
  rather than by this repository's maintainers.
- Findings that require an attacker to already control the user's machine or
  their account.
- Missing hardening with no demonstrated impact.

## How releases are protected

Useful background if you are looking at the supply chain:

- Every published release carries a build record signed with keyless cosign,
  stored on a prefix separate from the downloads it vouches for, so the write
  that serves a binary cannot replace the record that attests to it.
- `wego update` verifies that record before it reads a manifest, against Fulcio
  trust anchors pinned in the binary rather than fetched at verify time.
- The API verifies the record before serving a manifest to the install script,
  because a POSIX `sh` installer cannot check a signature itself.
- A promote copies bytes and their record from an immutable per-version prefix.
  Nothing is rebuilt or re-signed to promote it.

`docs/release.md` describes all of this, including how to verify a release by
hand.
