# Security policy

## Reporting a vulnerability

**Use the *Report a vulnerability* button on this repository's [Security
tab](https://github.com/wego/cli/security/advisories/new). That is the channel we
prefer.** `security@wego.com` also reaches us, and is the right choice if you
would rather not use GitHub for this.

Do not open a public issue for a suspected vulnerability, and do not raise one
through a pull request or a discussion. If you have already done so, use one of
the two channels above rather than adding detail to the public thread.

**Why we prefer the Security tab.** A report there can open a temporary private
fork, and we can develop the fix in it. That matters more here than it would in
a private repository: `main` is public, and `.github/workflows/edge-cli.yml`
publishes an edge build on every push to `main` that touches the CLI itself
(`src/**`, `scripts/**`, the build config) — which is what a vulnerability fix
touches. So a fix developed in the open is public the moment it merges, while
the people on `cli/stable` are still waiting for the separate, manual promote
that reaches them. The private fork is the only mechanism in this repository
that closes that window.

A report there also lands as a triage advisory that every admin can see on the
Security tab, rather than in one mailbox. GitHub notifies admins and security
managers according to each person's own security-alert settings, so the visible
queue is the reliable part rather than the notification.

This is only about where the fix is developed. Publishing an advisory afterwards
works the same either way, and always has; reporting by mail does not cost you
one.

Please include what you did, what you observed, and what you expected, along with
the CLI version (`wego version`), your operating system and architecture, and
whether you were following `stable`, `next` or `edge`. A proof of concept helps.

This is not a bug bounty program. Wego does not currently offer or guarantee
monetary rewards for reports submitted under this policy.

**What to expect:** we will acknowledge your report and keep you informed while
we work on it, but **we cannot promise when.** No one person is on call for this
policy and there is no triage rotation behind it, so a response time is not
something we can honestly commit to. Reporting through the Security tab is the
best hedge we can offer against that: the report sits in a queue every admin can
see, rather than depending on one person reading mail.
Acknowledgement is not a fix: how long a fix takes depends on what you
found, and we will tell you what we know as we know it. We will tell you when a
fix is released, and we are glad to credit you unless you would rather we did
not.

Please give us reasonable time to fix an issue before disclosing it publicly.

## Supported versions

Only the version `cli/stable` currently serves is supported. There are no
long-term support branches and no backports to earlier versions.

`wego update` is the upgrade path. It compares the binary you have against the
bytes the ring serves, so it moves you to the supported version regardless of
which version you are on.

## Threat model

This is the axis we triage on, and it is what the *Scope* section below
applies.

**In scope: external attackers** — anyone without a legitimate grant of access
to this repository, its release pipeline, or a user's machine. That includes an
external attacker holding a **stolen credential**: a leaked token, a lifted
session, an exfiltrated key. A stolen credential is an external attacker wearing
an insider's identity, so it stays in scope.

**Out of scope: insiders acting deliberately within their granted access.** A
maintainer merging their own change, an admin editing a ruleset, someone with
write access using the write access they were given — those are governance
questions rather than vulnerabilities, and this policy does not triage them as
findings.

**That exclusion is narrow. It does not cover:**

- **The coerced.** Someone pressured, deceived or socially engineered into using
  their access is not acting deliberately. In scope.
- **The negligent.** A mistake, a misconfiguration, a credential pasted where it
  should not have been. In scope.
- **An account compromised through a person** rather than through a token —
  phishing, a device taken over, a session hijacked at the keyboard. The
  attacker is external and only the identity is an insider's. In scope.

That carve-out is the load-bearing part. Do not read the insider exclusion as
covering anything an insider's account did; read it as covering only what an
insider chose to do.

**What this model accepts.** Four gaps in this repository are accepted rather
than closed, and each one is accepted *because of* this model rather than in
spite of it. They are decisions, not oversights:

- **No incident-response runbook.** No named triage owner, no severity rubric,
  no credential-rotation procedure. The periodic sweep that would partly cover
  it needs organisation-admin scope, which `GITHUB_TOKEN` does not have, and the
  credentials that would bridge that — an organisation PAT, an admin-scoped App
  — are a worse standing exposure than the gap they would close. This is also
  why the section above promises no response time.
- **No audit log.** Not available on this GitHub plan, and not something this
  repository can add. Accepted at the repository level.
- **An admin merging without review.** The default branch ruleset requires a
  pull request and has an empty bypass list, so no one merges past it. But an
  account that can delete the ruleset does not need to merge past it, and that
  is insider-shaped by definition. A report showing how an *external* attacker
  reaches that account is a different thing, and it is in scope.
- **The number of people with write access.** Those are deliberate grants.
  Insider-shaped, and a matter for access review rather than for this policy.

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
- Findings that assume the attacker already holds the access the finding is
  about: a local attacker who already has the user's disk and keychain, or an
  insider exercising a grant they legitimately hold. **How** an account or a
  machine came to be controlled is the part we want, and that part is in scope —
  phishing, a hijacked session, a stolen token, and the coerced and negligent
  cases above all count.
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
