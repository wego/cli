#!/bin/sh
# The cross-repo install contract, executed rather than restated.
#
#   install-smoke.sh <install-url> <ring> <expected-version>
#
# The installer lives in `wego-ai` (`apps/api/src/routes/install.ts`) and writes
# its ring record to
#
#     "${XDG_CONFIG_HOME:-$HOME/.config}/$BIN_NAME/install.json"
#
# while this CLI reads it back from `<config root>/wego/install.json`
# (`src/config.ts`, `CONFIG_SCOPE`). `$BIN_NAME` defaults to the flavor, the
# literal `wego`, so the two meet — but nothing anywhere executes both halves.
# `install.test.ts` over in wego-ai drives the script against a stub store and
# never runs a CLI; `config.test.ts` here pins a hardcoded copy of the
# installer's formula and never runs the script. Two matching statements of a
# contract are not the contract, and when the CLI's scope rule last moved the
# installer kept writing the old path: the record went invisible, `update`
# refused, and every test in both repositories stayed green.
#
# So this installs for real, from the real route, and asserts the record lands
# where the binary that was just installed actually looks — then makes that
# binary say so itself, which is what stops the check passing on a file nobody
# reads.
#
# Everything is confined to a temp HOME and a temp XDG_CONFIG_HOME: the run
# never touches the runner's own config, and `WEGO_CLI_INSTALL_SKILL=0` keeps it
# away from the agent skill, which lives under $HOME and is shared.
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

# 1. The command name is the installer's own default. A differently-named binary
#    would file its record under that name and read from `wego/`, so asserting the
#    default here is asserting the premise the whole contract rests on.
[ -x "$bindir/wego" ] || fail "no executable at $bindir/wego — the installer did not use its default command name"

# 2. The record landed where THIS binary reads it. The assertion the two
#    repositories cannot make on their own.
[ -f "$record" ] || {
  echo "what the installer did write:" >&2
  find "$cfg" -name 'install.json' >&2 || true
  fail "no ring record at $record"
}

# 3. It names the ring that was asked for, not some other one.
grep -q "\"ring\"[[:space:]]*:[[:space:]]*\"$RING\"" "$record" \
  || fail "the record at $record does not name ring $RING: $(cat "$record")"

# 4. The installed binary is the build this run published.
got=$(XDG_CONFIG_HOME="$cfg" "$bindir/wego" version) \
  || fail "the installed binary could not report its version"
[ "$got" = "$EXPECTED" ] || fail "installed version is '$got', expected '$EXPECTED'"

# 5. And the binary READS that record back and agrees about the ring. Without
#    this the check would pass on a record written somewhere plausible that the
#    binary never consults — which is precisely the failure mode being tested.
out=$(XDG_CONFIG_HOME="$cfg" "$bindir/wego" update --check 2>&1) \
  || fail "\`update --check\` exited non-zero from the installed binary: $out"
printf '%s\n' "$out" | grep -q "ring $RING" \
  || fail "\`update --check\` did not resolve ring $RING from the record it wrote: $out"

echo "PASS install contract: $URL?ring=$RING -> $record -> $got, ring $RING"
