#!/usr/bin/env bash
# Gate 1 — reproducible build. Two consecutive `cargo build-sbf` runs
# from a clean tree must produce byte-identical .so. If they don't, the
# build environment has nondeterminism (RUSTFLAGS metadata, build paths,
# proc-macro state) we need to fix BEFORE relying on the binary's
# identity for upgrade authority decisions.

set -euo pipefail

PROGRAM="$1"
PROGRAM_ID="$2"
FEATURES="$3"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROGRAM_UNDER="${PROGRAM//-/_}"
SO_PATH="$REPO_ROOT/target/deploy/${PROGRAM_UNDER}.so"

cd "$REPO_ROOT"

FEATURES_ARG=""
if [[ -n "$FEATURES" ]]; then FEATURES_ARG="--features $FEATURES"; fi

echo "build run 1/2 ..."
cargo clean -p "$PROGRAM" >/dev/null 2>&1 || true
RUSTFLAGS="-C metadata=" cargo build-sbf \
  --manifest-path "programs/$PROGRAM/Cargo.toml" \
  $FEATURES_ARG >/dev/null 2>&1
SHA1=$(shasum -a 256 "$SO_PATH" | awk '{print $1}')
echo "  sha256: $SHA1"

echo "build run 2/2 ..."
cargo clean -p "$PROGRAM" >/dev/null 2>&1 || true
RUSTFLAGS="-C metadata=" cargo build-sbf \
  --manifest-path "programs/$PROGRAM/Cargo.toml" \
  $FEATURES_ARG >/dev/null 2>&1
SHA2=$(shasum -a 256 "$SO_PATH" | awk '{print $1}')
echo "  sha256: $SHA2"

if [[ "$SHA1" != "$SHA2" ]]; then
  echo "FAIL: builds are not byte-identical." >&2
  echo "      $SHA1 (run 1)" >&2
  echo "      $SHA2 (run 2)" >&2
  echo "      Investigate: RUSTFLAGS leaking metadata, dependency macro nondeterminism." >&2
  exit 1
fi

echo "✓ reproducible: $SHA1"
