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

## Threat model

Two decisions decide what the *Scope* section below accepts. They were made
separately, and the second narrows the first without replacing it.

**Who is in scope.** External attackers, including an external attacker using a
**stolen credential**. A stolen credential is an external attacker wearing an
insider's identity, so it stays in scope.

**Who is out of scope.** Insiders acting deliberately within their granted
access. A maintainer merging their own change, an admin editing a ruleset,
someone with write access using the access they were given: those are governance
questions rather than vulnerabilities, and this policy does not triage them as
findings.

**That exclusion is narrow. It does not cover:**

- **The coerced.** Someone pressured, deceived or socially engineered into using
  their access is not acting deliberately. In scope.
- **The negligent.** A mistake, a misconfiguration, a credential left somewhere
  it should not have been. In scope.
- **An account compromised through a person** rather than through a token:
  phishing, a device taken over, a session hijacked at the keyboard. The
  attacker is external and only the identity is an insider's. In scope.

Read the exclusion as covering what an insider chose to do, not anything an
insider's account did.

**What we work on first.** Separately, we put ten live findings to a blunter
question: can a person who is not a member of the `wego` GitHub organisation
reach this? Three survived it. The other seven were deprioritized, and
**deprioritized is not accepted.** They are still live, still real, and still
ours to fix.

**That changed what we work on first, not what is in scope.** A stolen
credential is still in scope, and nothing above moved out of it. The cost of
parking those seven is worth stating plainly: an attacker who is **already
inside** meets less resistance than they otherwise would.

**The decisions this records.** Six were made on the strength of the two models
above. They are written here because a reader who finds them undocumented will
conclude they were missed rather than chosen:

| Finding | Disposition | Why |
|---|---|---|
| REPO-10 | accepted | No incident-response runbook. The periodic sweep that would compensate needs access this repository's own automation does not have, and the credentials that would bridge it are a worse exposure than the gap. |
| ORG-7 | accepted | No audit log. Not available on this GitHub plan, and not something this repository can add. |
| REPO-9 | skipped | Build provenance is largely redundant with cosign and the Fulcio SAN, and the SBOM available to us would describe only a fraction of our packages. |
| REPO-1 | parked | An admin merging without review. Insider-shaped: an account that can change the rules is not constrained by them. |
| ORG-2 | parked | The size of the collaborator list. Those are deliberate grants. |
| REPO-8 | parked | The push-protection bypass has no approver. |

REPO-8 is the finding that shows why the carve-out earns its place. A delegated
bypass with no approver is reachable through a person, so it could not simply
take the disposition that REPO-1 and ORG-2 took.

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
  insider exercising a grant they legitimately hold. How an account or a machine
  came to be controlled is the part we want, and that part is in scope,
  including the coerced, negligent and person-compromised cases above.
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
