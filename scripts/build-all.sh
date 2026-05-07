#!/usr/bin/env bash
# Build all 5 mainnet-alpha programs from current HEAD using cargo build-sbf.
# Idempotent — only rebuilds what's stale.
#
# Output: target/deploy/<name>.so  (consumed by ops/mainnet-deploy.sh + tests).
#
# Toolchain pinned to v1.54 so litesvm + on-chain bytecode stay in lockstep
# with the assurance harness (see b402-solana-assurance/reports/onchain-summary.md).
#
# Usage:
#   ./scripts/build-all.sh          # build the 5 alpha programs
#   ./scripts/build-all.sh --all    # also build mock + perp + orca + adrena (dev only)
set -euo pipefail
cd "$(dirname "$0")/.."

ALPHA=(
  b402-verifier-transact
  b402-verifier-adapt
  b402-jupiter-adapter
  b402-kamino-adapter
  b402-pool
)

DEV_ONLY=(
  b402-mock-adapter
  b402-jupiter-perps-adapter
  b402-orca-adapter
  b402-adrena-adapter
)

PROGRAMS=("${ALPHA[@]}")
if [[ "${1:-}" == "--all" ]]; then
  PROGRAMS+=("${DEV_ONLY[@]}")
fi

# Per-program feature sets. Mainnet binaries are built with these flags;
# local builds MUST match or the SDK's wire format gets rejected by the
# on-chain Borsh deserializer (Anchor 102). bash 3.2 (macOS default) has
# no assoc-array support — use case.
features_for() {
  case "$1" in
    b402-pool)                echo "prd_35_pending_inputs inline_cpi_nullifier phase_9_dual_note" ;;
    b402-verifier-adapt)      echo "phase_9_dual_note" ;;
    b402-nullifier)           echo "cpi-only" ;;
    b402-kamino-adapter)      echo "per_user_obligation" ;;
    b402-percolator-adapter)  echo "cpi-only" ;;
    *)                        echo "" ;;
  esac
}

for p in "${PROGRAMS[@]}"; do
  echo ""
  echo "==> $p"
  feat=$(features_for "$p")
  if [[ -n "$feat" ]]; then
    cargo build-sbf --tools-version v1.54 \
      --manifest-path "programs/$p/Cargo.toml" \
      -- --features "$feat"
  else
    cargo build-sbf --tools-version v1.54 --manifest-path "programs/$p/Cargo.toml"
  fi
done

echo ""
echo "== built ${#PROGRAMS[@]} programs =="
for p in "${PROGRAMS[@]}"; do
  so="target/deploy/${p//-/_}.so"
  if [[ -f "$so" ]]; then
    size=$(wc -c < "$so")
    printf "  %-30s %6d B\n" "$p" "$size"
  else
    echo "  ✗ MISSING: $so"
    exit 1
  fi
done
