#!/bin/sh
# Tier-A faithful `wego update` self-replace smoke.
#
#   update-smoke.sh <old-binary-path-or-url> <expected-version> [--require-replace]
#                   [--ring <name>] [--install-url <url>]
#
# --require-replace fails (instead of passing) when the predecessor is already the
# expected version, so no real byte-swap was exercised — CI uses it to stop a release
# RERUN (channel pointer already advanced) from greenwashing. Omit it locally.
#
# Takes a REAL previously-published release binary and runs its REAL `update -y`
# against the live channel baked into it, then asserts the binary has replaced
# itself in place with <expected-version>. There is NOTHING mocked or stubbed:
#   - a real compiled binary (not `bun run src/…` — source refuses to self-update)
#   - real HTTPS to the real Vercel Blob channel the binary was built to pull from
#   - the real fetch → gunzip (gz-first, issue #1235) → sha256 verify (fail-closed)
#     → atomic rename over its own process.execPath → chmod (→ macOS quarantine
#     clear) path in src/update.ts
# So once the released binary prefers the `<asset>.gz` archive, this smoke drives
# that download-and-decompress path end to end for real — no extra flag needed.
# The ONLY thing arranged is the binary's identity (an older published build); a
# consumer's `wego update` does byte-for-byte the same work.
#
# --ring <name> is part of that identity since foundations#74 rung 3: an install's
# download source is a RECORD the INSTALLER writes on the machine
# (`~/.config/<scope>/install.json`), and `update` refuses rather than guessing
# when it is absent. This smoke hand-places a binary instead of installing it, so
# for a predecessor new enough to require the record it writes one — naming the
# ring the caller passed, and the install URL the predecessor's own refusal
# printed, so no host is hardcoded here. Everything the run writes stays inside the
# temp XDG_CONFIG_HOME below. A predecessor that predates the record self-updates
# on its first run and never reaches that branch; a caller who passed no --ring
# gets a FAIL naming the flag, never a silent skip.
#
# --install-url <url> overrides where that arranged record says this install came
# from. Without it the URL is read out of the predecessor's own reinstall hint, which
# is the right default: it keeps the smoke host-agnostic and asserts the predecessor
# agrees about its own origin. But it also means the predecessor decides the store,
# and a predecessor built against production names production. Passing the flag is
# how a REHEARSAL run points the self-update at a rehearsal store through a preview
# API instead of following the `api.wego.com` hint baked into the old binary.
# Everything else about the run is unchanged.
#
# <old-binary> is a local path or an http(s) URL (downloaded to a temp file). It
# must match THIS host's platform (you run it, so pick e.g. wego-linux-x64 on
# Linux, wego-darwin-arm64 on an Apple-silicon Mac).
#
# SKIPs (exit 0) rather than fails when the binary can't self-update by design:
#   - it predates the `update` command itself (released before self-update shipped)
#   - it was built with no update channel baked (pre-go-live) or is a source run
#   - it's on Windows (a running .exe can't be swapped in place)
# so the smoke is safe to run against any build (incl. the transition release whose
# predecessor is older than `update`). POSIX self-replace only — run on Linux/macOS.
#
# Local shift-left (see apps/api/docs/cli-release.md → "Verifying a release"): point it at
# an older immutable tag's asset for your platform and the version the channel now
# serves, e.g.
#   BASE=https://<blob-host>/cli
#   sh scripts/update-smoke.sh "$BASE/v0.3.0/wego-darwin-arm64" 0.4.0
set -eu

# --require-replace: fail (don't pass) if no real byte-level swap was exercised —
# i.e. the predecessor is already the expected version. CI passes it so a release
# RERUN (where the channel pointer was already advanced by the prior attempt, making
# the "predecessor" the new build) fails loudly instead of greenwashing. Local
# shift-left omits it: an idempotent re-run against a current channel is a valid pass.
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

# Every file the predecessor writes under a config dir lands here: the ring record
# this script may arrange below, and the update-notice throttle the binary stamps.
# So a smoke run never touches the operator's real ~/.config, and the record it
# writes cannot outlive the run and quietly satisfy a later one.
XDG_CONFIG_HOME="$tmp/config"
export XDG_CONFIG_HOME

# Resolve <old-binary>: a URL is downloaded; a path is copied (we must not mutate
# the caller's file — `update` rewrites it in place, and the copy is what proves
# the swap happened).
#
# The copy is named `wego`, in a directory of its own, and the NAME is load-bearing
# for the PREDECESSOR. The binary under test scopes its config to the constant
# `wego` and no longer cares what it is called, but every predecessor up to 1.2.7
# scoped by the name it was invoked as, so a copy called `old-binary` would look for
# its ring record in `$XDG_CONFIG_HOME/old-binary/` and the record arranged below
# would be invisible to it. `wego` is what all three rules resolve to — the constant,
# the name-keyed one, and the flavor-keyed one an older predecessor uses — so this
# script keeps working against a predecessor from any side of either change.
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

# sha256, portable AND fail-closed: prefer sha256sum (Linux / brew coreutils), fall
# back to shasum (stock macOS). Two traps avoided: (1) `sha256sum … || shasum …`
# doesn't fall back — the pipe's exit is awk's (always 0), so branch on the tool;
# (2) capture the hasher WITHOUT a pipe so its failure is this function's exit status
# (a `… | awk` would mask a hasher error as awk's 0 and emit an empty digest, which a
# caller could mistake for a valid "unchanged" hash). Callers must guard `$(sha …)`.
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

# Run the real self-update. Capture output so we can (a) detect the by-design
# "can't self-update here" cases and SKIP, (b) surface the command's own message
# on a genuine failure.
set +e
out=$("$OLD" update -y 2>&1)
code=$?
set -e
echo "--- \`update -y\` output (exit $code) ---"
echo "$out"
echo "----------------------------------------"

# These SKIP patterns match the predecessor's OWN user-facing output, so they are
# coupled to the exact strings in apps/cli/src/{index,update}.ts. Most are pinned by
# assertions in src/{index,update}.test.ts ("Unknown command:", "running from
# source", "installed release binaries"), so a copy-edit of those messages trips a
# unit test before it can silently break SKIP detection here.
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

# foundations#74 rung 3: a predecessor new enough to follow a RECORDED ring finds
# none here, because this smoke places the binary rather than installing it. Arrange
# the record the installer would have written, then run the real update again. The
# install URL is read out of the refusal's own reinstall line (`curl -fsSL <url> |
# bash`), which is the predecessor's own statement of where it was installed from —
# so this stays host-agnostic, like the rest of the release tooling. One record, in
# the one `wego` config dir: the flavor axis died with foundations#74 rung 2, so a
# predecessor a ring can serve is always the `wego` build — and the copy above is
# named `wego` too, so the name-keyed scope lands in that same directory.
# The temp XDG_CONFIG_HOME above means the record cannot escape the run.
case "$out" in
  *"no release ring recorded"*)
    # `--install-url` wins when given; otherwise read the predecessor's own
    # reinstall hint, which is the host-agnostic default.
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

# Prove a real byte-level replacement actually occurred whenever the predecessor
# was an older version. (When it was already the expected version — an idempotent
# re-run — `update` correctly reports "already up to date" and the bytes are
# unchanged; that's a valid, if weaker, pass.)
if [ "$before_hash" = "$after_hash" ]; then
  # Bytes never changed. An OLDER predecessor means `update` claimed success without
  # replacing — always a failure.
  if [ "$before_ver" != "$EXPECTED" ]; then
    echo "FAIL: version reads $EXPECTED but the binary bytes never changed" >&2
    exit 1
  fi
  # Predecessor was already the expected version. Locally that's a valid
  # already-up-to-date pass; under --require-replace (CI) it means the channel
  # pointer had already advanced (a release rerun), so NO real swap was exercised —
  # fail rather than report a green that proved nothing.
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

# The updated binary must now agree it is current against the same live channel.
# Require a clean exit — `|| true` would let a genuinely failed --check slip through
# whenever its output happened to contain the up-to-date phrase.
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
