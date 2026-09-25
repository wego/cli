#!/bin/sh
# Runs the cross-repo install contract end to end.
#
#   install-smoke.sh <install-url> <ring> <expected-version>
#
# The installer lives in `wego-ai` (`apps/api/src/routes/install.ts`) and writes
# its ring record to
#
#     "${XDG_CONFIG_HOME:-$HOME/.config}/$BIN_NAME/install.json"
#
# while this CLI reads it from `<config root>/wego/install.json`
# (`src/config.ts`, `CONFIG_SCOPE`). `$BIN_NAME` defaults to `wego`, so the two
# meet, but no unit test runs both halves: wego-ai's `install.test.ts` never
# runs a CLI, and `config.test.ts` here pins a copy of the installer's formula
# without running the script. When the CLI's scope rule once moved, the
# installer kept writing the old path, `update` refused, and every test in both
# repositories stayed green.
#
# So this installs from the real route, asserts the record lands where the
# installed binary looks, and has that binary confirm it reads the record.
#
# Everything is confined to a temp HOME and XDG_CONFIG_HOME so the runner's own
# config is untouched; `WEGO_CLI_INSTALL_SKILL=0` keeps it away from the shared
# agent skill under $HOME.
set -eu

URL="${1:-}"
RING="${2:-}"
EXPECTED="${3:-}"
[ -n "$URL" ] && [ -n "$RING" ] && [ -n "$EXPECTED" ] || {
  echo "usage: install-smoke.sh <install-url> <ring> <expected-version>" >&2
  exit 2
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM
cfg="$tmp/config"
bindir="$tmp/bin"
record="$cfg/wego/install.json"

fail() { echo "FAIL: $*" >&2; exit 1; }

echo "--- installing $RING from $URL into $tmp ---"
HOME="$tmp/home" \
XDG_CONFIG_HOME="$cfg" \
WEGO_CLI_INSTALL_DIR="$bindir" \
WEGO_CLI_INSTALL_SKILL=0 \
  sh -c "curl -fsSL '$URL?ring=$RING' | sh" \
  || fail "the install script exited non-zero"

# 1. The command name is the installer's default. A differently-named binary
#    would file its record under that name, so the contract depends on this.
[ -x "$bindir/wego" ] || fail "no executable at $bindir/wego — the installer did not use its default command name"

# 2. The record landed where this binary reads it.
[ -f "$record" ] || {
  echo "what the installer did write:" >&2
  find "$cfg" -name 'install.json' >&2 || true
  fail "no ring record at $record"
}

# 3. It names the ring that was asked for.
grep -q "\"ring\"[[:space:]]*:[[:space:]]*\"$RING\"" "$record" \
  || fail "the record at $record does not name ring $RING: $(cat "$record")"

# 4. The installed binary is the build this run published.
got=$(XDG_CONFIG_HOME="$cfg" "$bindir/wego" version) \
  || fail "the installed binary could not report its version"
[ "$got" = "$EXPECTED" ] || fail "installed version is '$got', expected '$EXPECTED'"

# 5. The binary reads that record back and agrees about the ring. Without this
#    the check would pass on a record in a plausible place the binary never
#    consults, which is the failure being tested.
out=$(XDG_CONFIG_HOME="$cfg" "$bindir/wego" update --check 2>&1) \
  || fail "\`update --check\` exited non-zero from the installed binary: $out"
printf '%s\n' "$out" | grep -q "ring $RING" \
  || fail "\`update --check\` did not resolve ring $RING from the record it wrote: $out"

echo "PASS install contract: $URL?ring=$RING -> $record -> $got, ring $RING"
