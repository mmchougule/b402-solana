#!/usr/bin/env bash
# PRD-35 mainnet deploy — verifier-adapt + pool, sequenced.
#
# READ THIS BEFORE RUNNING: this script reproduces the deploy plan in
# PRD-35 §5.8 step-by-step. Each `solana program upgrade` is irreversible
# in the same tx. The buffer write costs ~3 SOL recoverable rent.
# Total cost estimate at $180/SOL: ~$0.10 per upgrade after rent refund.
#
# WHAT IT DOES (in order):
#   1. Run pre-deploy-check.sh against verifier-adapt + pool. ABORT on
#      any failed gate.
#   2. Build both binaries with the right features.
#   3. Write verifier-adapt buffer; deploy via program upgrade.
#   4. Write pool buffer; deploy via program upgrade.
#   5. Confirm new program data on chain via solana program show.
#
# Order matters: verifier-adapt MUST upgrade first because it gains a
# NEW ix variant (`verify_with_account_inputs`) that the new pool will
# CPI into. If pool ships before verifier, every adapt_execute call
# fires the new CPI and the old verifier rejects on unknown ix disc.
#
# WHAT IT DOES NOT DO:
#   - Activate the new path. Pool's `prd_35_pending_inputs` feature is
#     OFF by default in the new binary too — the new path is reachable
#     only when SDK callers pass `pendingInputsMode: true`. So
#     existing mainnet privateSwap traffic keeps the inline-inputs
#     path until SDK callers opt in.
#   - Deploy kamino-adapter with per_user_obligation. That's PRD-33 V1
#     and gates on this PRD landing first (per PRD-35 §9 sequencing).
#
# Usage:
#   MAINNET_RPC="https://your-helius-rpc-url" \
#   ops/prd-35-mainnet-deploy.sh
#
# Pre-conditions:
#   - solana CLI configured with the upgrade-authority keypair
#     (~/.config/solana/id.json today; multisig in Phase 35).
#   - Sufficient SOL in the upgrade-authority for buffer rent (~6 SOL).
#   - All host tests + fork e2e green locally.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

VERIFIER_ADAPT_ID="3Y2tyhNSaUiW5AcZcmFGRyTMdnroxHxc5GqFQPcMTZae"
POOL_ID="42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y"
MAINNET_RPC="${MAINNET_RPC:?set MAINNET_RPC, e.g. https://your-helius-rpc-url}"
UPGRADE_AUTH="${UPGRADE_AUTH:-$HOME/.config/solana/id.json}"

VERIFIER_ADAPT_FEATURES="phase_9_dual_note"
POOL_FEATURES="inline_cpi_nullifier,phase_9_dual_note,prd_35_pending_inputs"

# ---- 0. balance sanity ----
BAL_LAMPORTS=$(solana -u "$MAINNET_RPC" balance "$(solana-keygen pubkey "$UPGRADE_AUTH")" --lamports | awk '{print $1}')
if [[ "$BAL_LAMPORTS" -lt 6000000000 ]]; then
  echo "FAIL: upgrade authority needs ≥6 SOL for buffer rent. Have: $BAL_LAMPORTS lamports." >&2
  exit 1
fi
echo "✓ upgrade authority has $((BAL_LAMPORTS / 1000000000)) SOL"

# ---- 1. pre-deploy gates for both programs ----
echo ""
echo "=== gate run for verifier-adapt ==="
ops/pre-deploy-check.sh b402-verifier-adapt "$VERIFIER_ADAPT_ID" "$VERIFIER_ADAPT_FEATURES"

echo ""
echo "=== gate run for pool ==="
ops/pre-deploy-check.sh b402-pool "$POOL_ID" "$POOL_FEATURES"

# ---- 2. fresh builds ----
echo ""
echo "=== rebuild final binaries ==="
cargo clean -p b402-verifier-adapt -p b402-pool >/dev/null 2>&1 || true
cargo build-sbf --manifest-path programs/b402-verifier-adapt/Cargo.toml \
  --features "$VERIFIER_ADAPT_FEATURES"
cargo build-sbf --manifest-path programs/b402-pool/Cargo.toml \
  --features "$POOL_FEATURES"

VA_SO="$REPO_ROOT/target/deploy/b402_verifier_adapt.so"
POOL_SO="$REPO_ROOT/target/deploy/b402_pool.so"
echo "  $VA_SO ($(wc -c <"$VA_SO") B)"
echo "  $POOL_SO ($(wc -c <"$POOL_SO") B)"

# ---- 3. verifier-adapt upgrade ----
echo ""
echo "=== upgrade verifier-adapt ==="
echo "  IMPORTANT: this is irreversible. Press Ctrl+C in the next 10s to abort."
sleep 10

VA_BUFFER=$(solana -u "$MAINNET_RPC" program write-buffer "$VA_SO" \
  --upgrade-authority "$UPGRADE_AUTH" 2>&1 | grep "^Buffer:" | awk '{print $2}')
echo "  buffer: $VA_BUFFER"

solana -u "$MAINNET_RPC" program upgrade "$VA_BUFFER" "$VERIFIER_ADAPT_ID" \
  --upgrade-authority "$UPGRADE_AUTH"
echo "  ✓ verifier-adapt upgraded at $VERIFIER_ADAPT_ID"

# Brief delay so subsequent reads see the new state.
sleep 5

# ---- 4. pool upgrade ----
echo ""
echo "=== upgrade pool ==="
echo "  IMPORTANT: irreversible. Press Ctrl+C in the next 10s to abort."
sleep 10

POOL_BUFFER=$(solana -u "$MAINNET_RPC" program write-buffer "$POOL_SO" \
  --upgrade-authority "$UPGRADE_AUTH" 2>&1 | grep "^Buffer:" | awk '{print $2}')
echo "  buffer: $POOL_BUFFER"

solana -u "$MAINNET_RPC" program upgrade "$POOL_BUFFER" "$POOL_ID" \
  --upgrade-authority "$UPGRADE_AUTH"
echo "  ✓ pool upgraded at $POOL_ID"

# ---- 5. post-deploy sanity ----
echo ""
echo "=== post-deploy sanity ==="
solana -u "$MAINNET_RPC" program show "$VERIFIER_ADAPT_ID" | tail -8
echo ""
solana -u "$MAINNET_RPC" program show "$POOL_ID" | tail -8

echo ""
echo "=== DEPLOY COMPLETE ==="
echo ""
echo "Append to ops/MAINNET-DEPLOY-RUNBOOK.md:"
echo "  date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "  verifier-adapt buffer: $VA_BUFFER"
echo "  pool           buffer: $POOL_BUFFER"
echo ""
echo "Next steps:"
echo "  1. Smoke test: run a privateSwap with pendingInputsMode: true via SDK"
echo "  2. Verify a privateSwap WITHOUT the flag still works (backward compat path)"
echo "  3. PRD-33 V1 mainnet flip: ops/phase9-mainnet-upgrade.sh kamino-adapter"
