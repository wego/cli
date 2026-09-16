#!/bin/sh
# Resolve the version `cli/stable` currently serves — the one a build proves it can
# replace itself WITH — and refuse when that proof would be vacuous.
#
#   outgoing-stable.sh <binary> <this-version> --stage pre-publish|post-advance
#                      [--probe-url <url>]
#
# Two jobs ask this question at two different moments, and before this script they
# each carried their own copy of the asking: chmod, the baked-version guard, the
# `?dl=VERSION&ring=stable` probe and both refusals — the same three checks written
# twice, differing only in the wording of their complaints. Identical checks in two
# places do not stay identical; the pair of predecessor-checksum steps this
# repository already had drifted into using different hashing commands.
#
# STDOUT CARRIES EXACTLY ONE THING: the outgoing version, and nothing else, because
# the caller does `outgoing=$(…)`. Anything chatty added here would land inside that
# variable and point the upgrade path at garbage — a failure that would look like a
# bad release rather than a bad echo. Every message below therefore goes to stderr,
# and `outgoing-stable.test.ts` pins that: one line out, nothing on the success
# path, nothing on any refusal path.
#
# --stage picks which job's wording to use. The complaints differ because the
# CONSEQUENCES differ: refusing before publication means "do not ship this", while
# refusing after the ring moved means "the ordinary path users take is broken". A
# single generic message would lose the half of the diagnosis that says what to do
# about it, so both sets live here, next to the checks that raise them.
set -eu

BIN="${1:-}"
VERSION="${2:-}"
shift 2 2>/dev/null || true

STAGE=""
PROBE="https://api.wego.com/install"
while [ $# -gt 0 ]; do
  case "$1" in
    --stage) STAGE="${2:-}"; shift 2 ;;
    # Test-only, exactly as `update-smoke.sh` takes `--install-url`: the lane never
    # passes it, and `release-platform-coverage.test.ts` asserts neither call site
    # does — a gate pointable at a shim proves nothing about the real route.
    --probe-url) PROBE="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -n "$BIN" ] && [ -n "$VERSION" ] || {
  echo "usage: outgoing-stable.sh <binary> <this-version> --stage pre-publish|post-advance" >&2
  exit 2
}
case "$STAGE" in
  pre-publish|post-advance) ;;
  *) echo "--stage must be pre-publish or post-advance; got '${STAGE}'" >&2; exit 2 ;;
esac

name=$(basename "$BIN")

# The artifact hop does not carry the exec bit.
chmod +x "$BIN" 2>/dev/null || true

# A dev-versioned binary makes `update` return OK without acting, so a gate handed
# one would go green having tested nothing. Assert the build baked its version
# rather than hoping it did.
got=$("$BIN" version 2>/dev/null) || got=""
if [ "$got" != "$VERSION" ]; then
  if [ "$STAGE" = "pre-publish" ]; then
    echo "::error::$BIN reports '$got', not '$VERSION'. It was built without WEGO_BUILD_VERSION baked, so 'wego update' would exit OK without doing anything and this gate would prove nothing." >&2
  else
    echo "::error::$name reports '$got', not '$VERSION' - built without WEGO_BUILD_VERSION baked, so 'wego update' would return having done nothing and this leg would prove nothing." >&2
  fi
  exit 1
fi

outgoing=$(curl -fsSL "$PROBE?dl=VERSION&ring=stable" | tr -d '\r\n') || outgoing=""

if [ -z "$outgoing" ]; then
  if [ "$STAGE" = "pre-publish" ]; then
    echo "::error::cli/stable serves no VERSION, so there is nothing for this build to update ONTO and its replace path cannot be exercised. Refusing to publish a build whose ability to leave is unproven." >&2
  else
    echo "::error::cli/stable serves no VERSION, so there are no differing bytes for this build to replace itself with and the unforced path cannot be exercised." >&2
  fi
  exit 1
fi

if [ "$outgoing" = "$VERSION" ]; then
  if [ "$STAGE" = "pre-publish" ]; then
    echo "::error::cli/stable already serves $VERSION, so pointing this build at it would exercise no byte swap. Re-releasing a version that is already stable leaves the replace path untested - cut a new version instead." >&2
  else
    echo "::error::cli/stable already serves $VERSION, so no byte swap is possible and a pass here would prove nothing. Cut a new version rather than re-releasing one that is already stable." >&2
  fi
  exit 1
fi

# The one thing on stdout.
printf '%s\n' "$outgoing"
