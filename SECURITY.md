# Security policy

## Reporting a vulnerability

**Use the *Report a vulnerability* button on this repository's [Security
tab](https://github.com/wego/cli/security/advisories/new). That is the channel
we prefer.** `security@wego.com` also reaches us, and is the right choice if you
would rather not use GitHub for this.

We prefer the Security tab because a report there can be taken into a temporary
private fork and fixed there. `main` is public, and `edge-cli` publishes whenever
a merge changes the CLI's source or build (the `paths:` filter in
`.github/workflows/edge-cli.yml`). A fix for a vulnerability is such a change, so
a fix developed in the open is disclosed by its own diff before the fixed binary
reaches a single user. Nothing else in this repository closes that window. A
report there also reaches the repository's maintainers through GitHub, rather
than landing in one mailbox.

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
- Findings that require an attacker to already run code as the user, or to
  already hold their Wego credentials. Exposure to *other* local users or
  processes, such as the permissions on stored tokens, is in scope.
- Missing hardening with no demonstrated impact.

## Threat model

This section is about the repository and its release pipeline. The scope above
is about the people who run the CLI.

**Who we defend against:** anyone outside the `wego` GitHub organization. That
includes the author of a pull request from a fork, anyone who can influence the
bytes an install or `wego update` downloads, and a compromised third party such
as an upstream action, a dependency or a vendor.

**What we protect, in priority order:**

1. People running `wego update` and the `/install` script.
2. The credentials the CLI holds.
3. The release pipeline and the signed build records it produces.

**Where the boundary sits:**

- The repository is public, so a pull request from a fork runs with a read-only
  `GITHUB_TOKEN` and no secrets. No workflow here uses `pull_request_target`,
  and none that a fork can trigger starts a privileged `workflow_run`.
- A change to a release path needs a review from a code owner, as listed in
  `.github/CODEOWNERS`.
- Only the release automation and the release signers can create a release tag.
- What a release carries once it is built is described under "How releases are
  protected" below.

**Insiders:** Members of the organization acting within the access they were 
granted are out of scope for this policy. Insider risk is managed through Wego’s 
internal access and monitoring controls. A member who is coerced or negligent, or 
whose account is taken over through phishing or social engineering, remains in 
scope. Leaked or stolen member credentials are also in scope and are triaged 
based on their demonstrated impact.

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
