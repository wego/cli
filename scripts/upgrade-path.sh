#!/bin/sh
# An upgrade path, driven for real, hop by hop, to the version a ring serves.
#
#   upgrade-path.sh <start-binary-path-or-url> <ring> <expected-final-version>
#                   [--via <v1,v2,…>] [--max-hops <n>] [--install-url <url>]
#
# `update-smoke.sh` checks that the previous release can reach this one in one
# hop. The install base is not all one hop behind: `apps/api`'s legacy bridge pin
# (wego/foundations#132) serves any `?dl=` request for ring `stable` whose user
# agent starts with `Bun/` from the frozen `cli/cli-v1.1.0/` prefix, so a 1.0.x
# machine lands on 1.1.0 and only the next `update` carries it the rest of the way.
# Two hops, and the intermediate one is a different repository's signature.
#
# So this script keeps the binary it just became and runs it again, until it
# reports the expected version or the hop budget runs out. It asserts:
#
#   converges   the chain reaches <expected-final-version> within --max-hops
#   advances    every hop changes the bytes and the version; an `update` that
#               exits 0 without moving is a failure
#   terminates  no version is visited twice. wego/cli#25's agent-less build
#               updated to 1.1.0, which read the live pointer, which served the
#               agent-less build, forever. Every hop succeeded; only the sequence
#               was wrong, so only a driver that keeps the sequence can see it.
#   routes      --via pins the waypoints, so 1.0.1's route through the frozen
#               bridge is asserted. A pin that stopped matching would still
#               converge by another route and pass without --via.
#   settles     the arrived binary reports itself up to date against the same ring
#
# Nothing is mocked: real HTTPS to the real deploy, real `?dl=`/`&sig=1` routing,
# real sigstore verification against each binary's own baked trust set, the real
# download and atomic self-replace. The only thing arranged is the install record,
# because this places a binary rather than installing one.
#
# <start-binary> must match this host's platform. POSIX only (Linux/macOS): a
# running .exe cannot be swapped in place on Windows.
#
# Examples, the two paths CI runs:
#
#   BASE=https://<store>/cli
#   # relay → the bytes `stable` is about to serve (the pre-promote gate)
#   sh scripts/upgrade-path.sh "$BASE/cli-v1.1.0/wego-linux-x64" next 1.2.6
#   # pre-relay → stable, via the frozen bridge (the install-base gate)
#   sh scripts/upgrade-path.sh "$BASE/cli-v1.0.1/wego-linux-x64" stable 1.2.6 --via 1.1.0
#
# No SKIPs. `update-smoke.sh` skips a predecessor that cannot self-update because
# it is handed whatever the previous release was. Here the start binary is named
# because it can self-update, so one that cannot is a broken argument.
set -eu

VIA=""
MAX_HOPS=4
INSTALL_URL=""
SRC=""
RING=""
EXPECTED=""
want=""
for a in "$@"; do
  if [ -n "$want" ]; then
    case "$want" in
      via) VIA="$a" ;;
      hops) MAX_HOPS="$a" ;;
      url) INSTALL_URL="$a" ;;
    esac
    want=""
    continue
  fi
  case "$a" in
    --via) want=via ;;
    --max-hops) want=hops ;;
    --install-url) want=url ;;
    -*) echo "unknown option: $a" >&2; exit 2 ;;
    *)
      if [ -z "$SRC" ]; then SRC="$a"
      elif [ -z "$RING" ]; then RING="$a"
      elif [ -z "$EXPECTED" ]; then EXPECTED="$a"
      else echo "unexpected argument: $a" >&2; exit 2; fi
      ;;
  esac
done
[ -z "$want" ] || { echo "--$want needs a value" >&2; exit 2; }
[ -n "$SRC" ] && [ -n "$RING" ] && [ -n "$EXPECTED" ] || {
  echo "usage: upgrade-path.sh <start-binary-path-or-url> <ring> <expected-final-version> [--via <v1,v2,…>] [--max-hops <n>] [--install-url <url>]" >&2
  exit 2
}
case "$MAX_HOPS" in
  '' | *[!0-9]*) echo "--max-hops must be a whole number, got: $MAX_HOPS" >&2; exit 2 ;;
esac
[ "$MAX_HOPS" -ge 1 ] || { echo "--max-hops must be at least 1" >&2; exit 2; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Every file any binary in the chain writes (the install record, the update-notice
# throttle, a session) lands here and is removed with the run, so a pass never
# depends on leftover state and the operator's real ~/.config is untouched.
XDG_CONFIG_HOME="$tmp/config"
HOME="$tmp/home"
export XDG_CONFIG_HOME HOME
mkdir -p "$HOME"
# Telemetry off: the events would describe upgrades no person performed.
WEGO_CLI_TELEMETRY=0
export WEGO_CLI_TELEMETRY

# The copy must be named `wego`. The config scope is the constant `wego`
# (`src/config.ts` `CONFIG_SCOPE`), but builds up to 1.2.7 scope by the name they
# were invoked as, so a copy called `start-binary` would look for its ring record
# in `$XDG_CONFIG_HOME/start-binary/` and miss the one arranged below. Pinned by
# `upgrade-path.test.ts`.
mkdir -p "$tmp/bin"
BIN="$tmp/bin/wego"
case "$SRC" in
  http://* | https://*)
    curl -fsSL --connect-timeout 15 --max-time 600 "$SRC" -o "$BIN" ||
      { echo "FAIL: could not download the start binary: $SRC" >&2; exit 1; }
    ;;
  *)
    [ -f "$SRC" ] || { echo "FAIL: no such file: $SRC" >&2; exit 1; }
    # Copy, never run in place: `update` rewrites the file, and the caller's copy
    # is usually a cached artifact a later step still needs intact.
    cp "$SRC" "$BIN"
    ;;
esac
chmod +x "$BIN"

# Portable and fail-closed, as in `update-smoke.sh`: branch on the tool rather
# than `sha256sum ... || shasum ...`, and capture without a pipe so a hasher
# failure is this function's status, not an empty digest a caller could read as
# "unchanged".
sha() {
  if command -v sha256sum >/dev/null 2>&1; then
    result=$(sha256sum "$1") || return 1
  else
    result=$(shasum -a 256 "$1") || return 1
  fi
  printf '%s\n' "${result%% *}"
}

# Where this install came from: `--install-url`, or else the reinstall hint the
# start binary prints in its own refusal. Reading the hint keeps the script
# host-agnostic.
if [ -n "$INSTALL_URL" ]; then
  install_url="$INSTALL_URL"
else
  set +e
  hint=$("$BIN" update --check 2>&1)
  set -e
  install_url=$(printf '%s\n' "$hint" |
    sed -n 's#.*curl -fsSL \(https://[^ ]*\).*#\1#p' | head -1)
  [ -n "$install_url" ] || {
    echo "FAIL: the start binary named no install URL to record. Its output was:" >&2
    printf '%s\n' "$hint" >&2
    echo "Pass --install-url <url> to name one." >&2
    exit 1
  }
fi

# The record the installer would have written. `update` refuses when it is absent,
# so a script that places a binary has to arrange it. One record serves the whole
# chain: every binary reads the same `wego` scope, so the ring survives each
# self-replace, as it does on a real machine after the bridge hands it 1.1.0.
mkdir -p "$XDG_CONFIG_HOME/wego"
printf '{\n  "ring": "%s",\n  "installUrl": "%s"\n}\n' "$RING" "$install_url" \
  > "$XDG_CONFIG_HOME/wego/install.json"
echo "ring=$RING installUrl=$install_url expected=$EXPECTED max-hops=$MAX_HOPS"

start_ver=$("$BIN" version) || { echo "FAIL: could not read the start binary's version" >&2; exit 1; }
[ "$start_ver" != "$EXPECTED" ] || {
  # Not a pass: a start binary already at the destination walks no path. As with
  # `update-smoke.sh --require-replace`, on a rerun the pointer may have moved to
  # meet it.
  echo "FAIL: the start binary is already $EXPECTED, so no upgrade path was exercised." >&2
  exit 1
}
echo "start: $start_ver"

# `route` holds the versions visited after the start, for the --via check. `seen`
# also holds the start, so a chain that returns to where it began is caught as a
# loop.
route=""
seen=" $start_ver "
cur="$start_ver"
hop=0

while [ "$cur" != "$EXPECTED" ]; do
  hop=$((hop + 1))
  [ "$hop" -le "$MAX_HOPS" ] || {
    echo "FAIL: still at $cur after $MAX_HOPS hop(s) — route so far:$route. The ring may serve a version this chain cannot reach, or each hop is advancing less than expected." >&2
    exit 1
  }

  before_hash=$(sha "$BIN") || { echo "FAIL: could not hash the binary before hop $hop" >&2; exit 1; }
  echo "--- hop $hop: $cur → ? (ring $RING) ---"
  set +e
  out=$("$BIN" update -y 2>&1)
  code=$?
  set -e
  printf '%s\n' "$out"
  [ "$code" -eq 0 ] || {
    echo "FAIL: hop $hop — \`update -y\` from $cur exited $code. Exit 6 is a signed record this binary's baked trust set does not accept; anything else is in the route, download, manifest or replace path." >&2
    exit 1
  }

  after=$("$BIN" version) || { echo "FAIL: hop $hop — could not read the version after update" >&2; exit 1; }
  after_hash=$(sha "$BIN") || { echo "FAIL: hop $hop — could not hash the updated binary" >&2; exit 1; }

  # An `update` that exits 0 and moves nothing means the ring is serving this
  # binary its own bytes while the chain is short of the destination: a pointer
  # that never advanced, or a route that sent this hop back to itself.
  if [ "$after" = "$cur" ] && [ "$after_hash" = "$before_hash" ]; then
    echo "FAIL: hop $hop reported success from $cur but replaced nothing, and $cur is not the expected $EXPECTED. Ring $RING is serving this binary back to itself." >&2
    exit 1
  fi
  # Bytes moved but the version did not, or vice versa.
  if [ "$after" = "$cur" ] || [ "$after_hash" = "$before_hash" ]; then
    if [ "$after_hash" = "$before_hash" ]; then moved=unchanged; else moved=changed; fi
    echo "FAIL: hop $hop left the version and the bytes disagreeing (version $cur → $after, bytes $moved)." >&2
    exit 1
  fi

  # A revisited version means the chain is a cycle that would swap forever. Catch
  # it at the first repeat, rather than when the hop budget expires, so the error
  # names the loop instead of "did not converge".
  case "$seen" in
    *" $after "*)
      echo "FAIL: hop $hop returned to $after, which this chain already visited (route:$route $after). That is a self-update LOOP — each hop succeeds and the install never settles." >&2
      exit 1
      ;;
  esac

  route="$route $after"
  seen="$seen$after "
  cur="$after"
  echo "--- hop $hop: → $cur ---"
done

echo "converged: $start_ver$route ($hop hop(s))"

# --via pins the route, not just the destination. Without it a chain that reached
# the right version another way (say the legacy bridge pin stopped matching)
# passes silently.
if [ -n "$VIA" ]; then
  want_route=$(printf '%s' "$VIA" | tr ',' ' ' | tr -s ' ')
  want_route="$want_route $EXPECTED"
  got_route="${route# }"
  [ "$got_route" = "$want_route" ] || {
    echo "FAIL: expected the route to be '$want_route', got '$got_route'." >&2
    exit 1
  }
  echo "route matches --via: $got_route"
fi

# The arrived binary must agree it is current against the same ring. Require a
# clean exit: `|| true` would let a failed --check through whenever its output
# contained the phrase.
set +e
check=$("$BIN" update --check 2>&1)
check_code=$?
set -e
[ "$check_code" -eq 0 ] || { echo "FAIL: post-arrival --check exited $check_code: $check" >&2; exit 1; }
case "$check" in
  *"Already up to date"*) ;;
  *) echo "FAIL: post-arrival --check did not report up to date: $check" >&2; exit 1 ;;
esac

echo "OK: $start_ver → $EXPECTED on ring $RING in $hop hop(s), settled."
