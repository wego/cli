#!/bin/sh
# `wego update` self-replace smoke.
#
#   update-smoke.sh <old-binary-path-or-url> <expected-version> [--require-replace]
#                   [--ring <name>] [--install-url <url>]
#
# Takes a real previously-published release binary, runs its own `update -y`
# against the live channel, and asserts the binary replaced itself in place with
# <expected-version>. Nothing is mocked: a real compiled binary (source refuses to
# self-update), real HTTPS to the real store, and the real fetch, gunzip, sha256
# verify, atomic rename over process.execPath and chmod (plus macOS quarantine
# clear) in src/update.ts. The only thing arranged is the binary's identity (an
# older published build); a consumer's `wego update` does the same work.
#
# --require-replace fails when the predecessor is already the expected version, so
# no real byte-swap ran. CI passes it so a release rerun (where the prior attempt
# already advanced the pointer, making the "predecessor" the new build) fails
# instead of passing. Omit it locally: an idempotent re-run is a valid pass.
#
# --ring <name>: an install's download source is a record the installer writes
# (`~/.config/<scope>/install.json`), and `update` refuses when it is absent. This
# smoke places a binary instead of installing it, so for a predecessor that needs
# the record it writes one, naming the ring passed here and the install URL the
# predecessor's own refusal printed, so no host is hardcoded. A predecessor that
# predates the record self-updates on its first run and never reaches that branch;
# a caller who passed no --ring gets a FAIL naming the flag, never a silent skip.
#
# --install-url <url> overrides the URL in that arranged record. By default it is
# read from the predecessor's reinstall hint, which keeps the smoke host-agnostic,
# but a predecessor built against production names production. The flag points a
# run against a non-production store at that store through a preview API instead.
#
# <old-binary> is a local path or an http(s) URL (downloaded to a temp file). It
# must match this host's platform (e.g. wego-linux-x64 on Linux,
# wego-darwin-arm64 on an Apple-silicon Mac).
#
# SKIPs (exit 0) rather than fails when the binary can't self-update by design:
#   - it predates the `update` command
#   - it was built with no update channel baked (pre-go-live) or is a source run
#   - it's on Windows (a running .exe can't be swapped in place)
# so the smoke is safe to run against any build. POSIX only: run on Linux/macOS.
#
# Locally, point it at an older immutable tag's asset for your platform and the
# version the channel now serves, e.g.
#   BASE=https://<blob-host>/cli
#   sh scripts/update-smoke.sh "$BASE/v0.3.0/wego-darwin-arm64" 0.4.0
set -eu

REQUIRE_REPLACE=0
RING=""
INSTALL_URL=""
SRC=""
EXPECTED=""
want_ring=0
want_install_url=0
for a in "$@"; do
  if [ "$want_ring" = 1 ]; then RING="$a"; want_ring=0; continue; fi
  if [ "$want_install_url" = 1 ]; then INSTALL_URL="$a"; want_install_url=0; continue; fi
  case "$a" in
    --require-replace) REQUIRE_REPLACE=1 ;;
    --ring) want_ring=1 ;;
    --install-url) want_install_url=1 ;;
    -*) echo "unknown option: $a" >&2; exit 2 ;;
    *)
      if [ -z "$SRC" ]; then SRC="$a"
      elif [ -z "$EXPECTED" ]; then EXPECTED="$a"
      else echo "unexpected argument: $a" >&2; exit 2; fi
      ;;
  esac
done
[ "$want_ring" = 0 ] || { echo "--ring needs a value" >&2; exit 2; }
[ "$want_install_url" = 0 ] || { echo "--install-url needs a value" >&2; exit 2; }
[ -n "$SRC" ] && [ -n "$EXPECTED" ] || {
  echo "usage: update-smoke.sh <old-binary-path-or-url> <expected-version> [--require-replace] [--ring <name>] [--install-url <url>]" >&2
  exit 2
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Every file the predecessor writes under a config dir lands here (the ring record
# arranged below, the update-notice throttle), so a run never touches the
# operator's real ~/.config and its record cannot satisfy a later run.
XDG_CONFIG_HOME="$tmp/config"
export XDG_CONFIG_HOME

# Resolve <old-binary>: a URL is downloaded; a path is copied, because `update`
# rewrites the file in place and the caller's file must not be mutated.
#
# The copy must be named `wego`. Predecessors up to 1.2.7 scope their config by the
# name they were invoked as, so a copy called `old-binary` would look for its ring
# record in `$XDG_CONFIG_HOME/old-binary/` and miss the one arranged below. `wego`
# is what every scoping rule (constant, name-keyed, flavor-keyed) resolves to.
mkdir -p "$tmp/bin"
OLD="$tmp/bin/wego"
case "$SRC" in
  http://* | https://*)
    curl -fsSL --connect-timeout 15 --max-time 600 "$SRC" -o "$OLD" ||
      { echo "could not download old binary: $SRC" >&2; exit 1; }
    ;;
  *)
    [ -f "$SRC" ] || { echo "no such file: $SRC" >&2; exit 1; }
    cp "$SRC" "$OLD"
    ;;
esac
chmod +x "$OLD"

# sha256, portable and fail-closed: sha256sum (Linux, brew coreutils) or shasum
# (stock macOS). Branch on the tool rather than `sha256sum ... || shasum ...`, and
# capture without a pipe: a `... | awk` would mask a hasher error as awk's exit 0
# and emit an empty digest a caller could mistake for an "unchanged" hash. Callers
# must guard `$(sha ...)`.
sha() {
  if command -v sha256sum >/dev/null 2>&1; then
    result=$(sha256sum "$1") || return 1
  else
    result=$(shasum -a 256 "$1") || return 1
  fi
  printf '%s\n' "${result%% *}"
}

before_ver=$("$OLD" version) || { echo "FAIL: could not read the predecessor binary's version" >&2; exit 1; }
before_hash=$(sha "$OLD") || { echo "FAIL: could not hash the predecessor binary" >&2; exit 1; }
echo "predecessor: version=$before_ver hash=$(printf '%s' "$before_hash" | cut -c1-10)…"

# Output is captured to detect the by-design "can't self-update here" cases and
# to surface the command's own message on a real failure.
set +e
out=$("$OLD" update -y 2>&1)
code=$?
set -e
echo "--- \`update -y\` output (exit $code) ---"
echo "$out"
echo "----------------------------------------"

# These SKIP patterns match the predecessor's own output, so they are coupled to
# the exact strings in src/{index,update}.ts. Tests pin those strings, so a
# copy-edit fails a test before it can silently break SKIP detection here.
case "$out" in
  *"Unknown command: update"* | *"Unknown command:update"*)
    echo "SKIP: this binary predates the \`update\` command (released before self-update shipped)."
    exit 0
    ;;
  *"installed release binaries"* | *"running from source"*)
    echo "SKIP: this binary has no update channel baked (pre-go-live or source build)."
    exit 0
    ;;
  *"isn't supported on Windows"*)
    echo "SKIP: Windows can't self-replace a running binary in place."
    exit 0
    ;;
esac

# A predecessor that follows a recorded ring finds none here, because this smoke
# places the binary rather than installing it. Arrange the record the installer
# would have written, then run the real update again. Without --install-url, the
# URL is read from the refusal's own reinstall line (`curl -fsSL <url> | bash`),
# which keeps this host-agnostic.
case "$out" in
  *"no release ring recorded"*)
    if [ -n "$INSTALL_URL" ]; then
      ring_url="$INSTALL_URL"
    else
      ring_url=$(printf '%s\n' "$out" |
        sed -n 's#.*curl -fsSL \(https://[^ ]*\).*#\1#p' | head -1)
    fi
    [ -n "$RING" ] || {
      echo "FAIL: the predecessor follows a recorded ring and none was given - re-run with --ring <name>" >&2
      exit 1
    }
    [ -n "$ring_url" ] || {
      echo "FAIL: the predecessor named no install URL to record (its reinstall hint is a placeholder) - pass --install-url <url> to name one" >&2
      exit 1
    }
    mkdir -p "$XDG_CONFIG_HOME/wego"
    printf '{\n  "ring": "%s",\n  "installUrl": "%s"\n}\n' \
      "$RING" "$ring_url" > "$XDG_CONFIG_HOME/wego/install.json"
    echo "arranged the install record: ring=$RING installUrl=$ring_url - retrying"
    set +e
    out=$("$OLD" update -y 2>&1)
    code=$?
    set -e
    echo "--- \`update -y\` retry output (exit $code) ---"
    echo "$out"
    echo "----------------------------------------------"
    ;;
esac

[ "$code" -eq 0 ] || { echo "FAIL: \`update -y\` exited $code" >&2; exit 1; }

after_ver=$("$OLD" version)
after_hash=$(sha "$OLD") || { echo "FAIL: could not hash the updated binary" >&2; exit 1; }

[ "$after_ver" = "$EXPECTED" ] || {
  echo "FAIL: after update version is '$after_ver', expected '$EXPECTED'" >&2
  exit 1
}

# An older predecessor must have changed bytes. One already at the expected
# version (an idempotent re-run) reports "already up to date" with the bytes
# unchanged, which is a valid, weaker pass unless --require-replace is set.
if [ "$before_hash" = "$after_hash" ]; then
  # An older predecessor means `update` claimed success without replacing.
  if [ "$before_ver" != "$EXPECTED" ]; then
    echo "FAIL: version reads $EXPECTED but the binary bytes never changed" >&2
    exit 1
  fi
  if [ "$REQUIRE_REPLACE" -eq 1 ]; then
    echo "FAIL: --require-replace: predecessor is already $EXPECTED, so no real self-replace ran (channel pointer already advanced — likely a release rerun after cli/next moved)." >&2
    exit 1
  fi
  replaced=0
  echo "note: predecessor was already $EXPECTED — bytes unchanged (already-up-to-date path)."
else
  replaced=1
  echo "replaced: bytes changed $before_ver → $after_ver."
fi

# The updated binary must now agree it is current. Require a clean exit: `|| true`
# would let a failed --check through whenever its output contained the up-to-date
# phrase.
set +e
check=$("$OLD" update --check 2>&1)
check_code=$?
set -e
[ "$check_code" -eq 0 ] || { echo "FAIL: post-update --check exited $check_code: $check" >&2; exit 1; }
case "$check" in
  *"Already up to date"*) echo "post-update --check: already up to date ✓" ;;
  *) echo "FAIL: post-update --check did not report up to date: $check" >&2; exit 1 ;;
esac

if [ "$replaced" -eq 1 ]; then
  echo "OK: real self-update replaced the binary in place → $EXPECTED"
else
  echo "OK: already up to date at $EXPECTED (no byte-swap exercised this run)."
fi
