#!/bin/sh
# Verify published CLI release assets against their SHA256SUMS.txt at a Blob base.
# A Linux CI helper: it runs on the release runner and executes the `*-linux-x64`
# assets (so it assumes sha256sum + a Linux-runnable native binary).
#
#   verify-published.sh <base-url> <expected-version> <all|native>
#
#   all     checksum EVERY asset listed in SHA256SUMS.txt. Use before advancing a
#           ring (cli/next in the release lane, cli/stable in the promote lane;
#           `cli/latest` was retired with the flavor axis, #74 rung 7):
#           `bun build --compile` is non-reproducible, so a partial
#           --freeze upload that is re-run keeps the first build's SHA256SUMS.txt
#           while rebuilding the missing assets' bytes — checking only the one
#           runner-native binary would miss a mismatch on any other asset.
#   native  checksum + run only the `*-linux-x64` assets. Use for a ring pointer
#           (cli/next or cli/stable), each a byte-identical server-side copy of the
#           already fully-verified cli/<tag>.
#
# WHICH native asset: derived from the manifest under verification, never
# hardcoded. This mattered acutely when two flavors published two different native
# names and a hardcoded one made the guard asymmetric; the flavor axis is gone
# (#74 rung 7) and every ring now serves the one `wego-*` family, but the
# derivation stays, because the property it buys is not about flavors: every
# `*-linux-x64` line in SHA256SUMS.txt is verified and run, and a manifest listing
# none is an error. Whatever a set claims, all of it must check out, and a set
# claiming no runnable native at all is not a release.
#
# Each native binary is ALWAYS checksum-verified before it is run (verify-then-
# execute), so a missing sums line, a checksum mismatch, or a version mismatch all
# exit 1. Retries downloads for Blob read-after-write consistency.
set -eu

BASE="$1"
EXPECTED="$2"
MODE="$3" # all | native — required; both call sites pass it explicitly

case "$MODE" in
  all | native) ;;
  *)
    echo "usage: verify-published.sh <base-url> <expected-version> <all|native>" >&2
    exit 1
    ;;
esac

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

fetch() { # url dest — retry for eventual consistency
  i=1
  while [ "$i" -le 5 ]; do
    # Bounded so a stalled connection/transfer can't hang the release job for
    # hours: fail this attempt and fall through to the retry instead.
    if curl -fsSL --connect-timeout 15 --max-time 600 "$1" -o "$2"; then return 0; fi
    echo "retry $i for $1 (Blob eventual consistency)..." >&2
    i=$((i + 1))
    sleep 5
  done
  echo "download failed after 5 retries: $1" >&2
  return 1
}

verify_one() { # name — checksum one published asset against SHA256SUMS.txt
  name="$1"
  # Reject a path-y asset name from a tampered sums file (defense-in-depth;
  # `sha256sum *` never emits path separators, so a real release never trips this).
  case "$name" in
    */* | *..*)
      echo "error: unsafe asset name '$name'" >&2
      return 1
      ;;
  esac
  exp=$(awk -v f="$name" '$2==f {print $1}' "$tmp/SHA256SUMS.txt")
  [ -n "$exp" ] || {
    echo "error: $name not listed in SHA256SUMS.txt" >&2
    return 1
  }
  fetch "$BASE/$name" "$tmp/$name"
  act=$(sha256sum "$tmp/$name" | awk '{print $1}')
  [ "$exp" = "$act" ] || {
    echo "checksum mismatch for $name (expected $exp, got $act)" >&2
    return 1
  }
  echo "ok: $name"
}

fetch "$BASE/SHA256SUMS.txt" "$tmp/SHA256SUMS.txt"

if [ "$MODE" = "all" ]; then
  while read -r _hash name; do
    [ -n "$name" ] || continue
    verify_one "$name"
  done <"$tmp/SHA256SUMS.txt"
fi

# The runnable natives this asset set actually claims. `-linux-x64$` excludes the
# `.gz` archives, which are handled per-native below.
natives=$(awk '$2 ~ /-linux-x64$/ {print $2}' "$tmp/SHA256SUMS.txt")
[ -n "$natives" ] || {
  echo "error: SHA256SUMS.txt lists no *-linux-x64 asset — nothing runnable to verify" >&2
  exit 1
}

for NATIVE in $natives; do
  # Always checksum-verify the native binary before running it — idempotent, so in
  # `all` mode this re-checks the (already-verified) native asset, and an asset that
  # is absent from the manifest can never be fetched-and-run unverified.
  verify_one "$NATIVE"
  chmod +x "$tmp/$NATIVE"
  got=$("$tmp/$NATIVE" version)
  [ "$got" = "$EXPECTED" ] || {
    echo "version mismatch for $NATIVE: $got != $EXPECTED" >&2
    exit 1
  }

  # Prove the gzipped archive round-trips to the raw binary — the exact operation
  # `GET /install` and `wego update` now perform (issue #1235): decompress
  # <native>.gz and assert it hashes to the raw binary's OWN SHA256SUMS line. This
  # keeps the gz consumers from rotting the way the unconsumed archives could have.
  # `verify_one` already proved the archive matches its own line (its checksum), and
  # in `all` mode every asset — the .gz included — was checksummed above; this adds
  # the archive->binary equality that neither check covers. Guarded on the .gz being
  # listed: a channel frozen from a pre-#1235 tag carries none, exactly the absent
  # case the consumers fall back on, so its absence is a skip, never a failure.
  gz_native="$NATIVE.gz"
  gz_raw_exp=$(awk -v f="$NATIVE" '$2==f {print $1}' "$tmp/SHA256SUMS.txt")
  if awk -v f="$gz_native" '$2==f {found=1} END{exit !found}' "$tmp/SHA256SUMS.txt"; then
    verify_one "$gz_native"
    gunzip -c "$tmp/$gz_native" >"$tmp/$NATIVE.from-gz"
    gz_act=$(sha256sum "$tmp/$NATIVE.from-gz" | awk '{print $1}')
    [ "$gz_act" = "$gz_raw_exp" ] || {
      echo "gz round-trip mismatch: $gz_native decompresses to $gz_act, raw $NATIVE is $gz_raw_exp" >&2
      exit 1
    }
    echo "ok: $gz_native decompresses to the raw $NATIVE"
  else
    echo "note: no $gz_native on this channel (pre-#1235 tag) — skipping gz round-trip check"
  fi
done

echo "verified $BASE ($MODE): version $EXPECTED, checksums OK"
