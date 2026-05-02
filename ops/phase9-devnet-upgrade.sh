#!/usr/bin/env bash
# Phase 9 devnet upgrade — verifier_adapt + pool.
#
# Order matters: upgrade verifier FIRST so the pool's CPI to it always sees
# the new VK. Pool upgrade SECOND so the SDK + pool wire shape flip in one
# step. (Reverse order would have the pool issuing 24-input proofs against
# a 23-input VK, rejecting every adapt_execute mid-window.)
#
# Pre-conditions:
#   - cargo build-sbf --features phase_9_dual_note ran for both crates.
#   - Local target/deploy/b402_pool.so + b402_verifier_adapt.so present.
#   - solana CLI authed as the upgrade authority for both programs
#     (4ym542u1DuC2i9hVxnr2EAdss8fHp4Rf4RFnyfqfy82t).
#   - At least 6 SOL on the upgrade authority (peak working capital during
#     write-buffer; refunded on upgrade-and-close).
#
# Usage:
#   bash ops/phase9-devnet-upgrade.sh [--cluster devnet|mainnet] [--dry-run]
#
# Idempotency notes:
#   - write-buffer is one-shot — don't re-run once written. The buffer
#     pubkey is the only handle to the rent. Print + persist to a state
#     file so recovery works.
#   - extend-program-data is additive; calling it twice with the same delta
#     just doubles the extension. Caller must check current ProgramData
#     account size before extending.

set -euo pipefail

CLUSTER="devnet"
DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case $1 in
    --cluster)  CLUSTER="$2"; shift 2 ;;
    --dry-run)  DRY_RUN=1; shift ;;
    *)          echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

case "$CLUSTER" in
  devnet)   RPC="https://api.devnet.solana.com" ;;
  mainnet)  RPC="https://api.mainnet-beta.solana.com" ;;
  *)        echo "cluster must be devnet|mainnet" >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
POOL_SO="$ROOT/target/deploy/b402_pool.so"
VERIFIER_SO="$ROOT/target/deploy/b402_verifier_adapt.so"
POOL_ID="42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y"
VERIFIER_ID="3Y2tyhNSaUiW5AcZcmFGRyTMdnroxHxc5GqFQPcMTZae"

# Persisted state — buffer pubkeys + step markers so we can recover from
# a partial run without re-paying rent.
STATE_DIR="$ROOT/ops/state"
mkdir -p "$STATE_DIR"
STATE_FILE="$STATE_DIR/phase9-${CLUSTER}-upgrade.json"

GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; NC='\033[0m'
say()  { echo -e "${GREEN}→${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC}  $*"; }
die()  { echo -e "${RED}✗${NC} $*"; exit 1; }

# ── pre-flight ──────────────────────────────────────────────────────────
[ -f "$POOL_SO" ]     || die "missing $POOL_SO — run cargo build-sbf"
[ -f "$VERIFIER_SO" ] || die "missing $VERIFIER_SO — run cargo build-sbf"

POOL_SIZE=$(wc -c < "$POOL_SO")
VERIFIER_SIZE=$(wc -c < "$VERIFIER_SO")
say "local pool .so:     $POOL_SIZE bytes"
say "local verifier .so: $VERIFIER_SIZE bytes"

# ── state on the cluster ─────────────────────────────────────────────────
DEPLOYED_POOL=$(solana program show "$POOL_ID" --url "$RPC" 2>&1 | grep "Data Length" | awk '{print $3}')
DEPLOYED_VERIFIER=$(solana program show "$VERIFIER_ID" --url "$RPC" 2>&1 | grep "Data Length" | awk '{print $3}')
say "deployed pool:      $DEPLOYED_POOL bytes"
say "deployed verifier:  $DEPLOYED_VERIFIER bytes"

# Pool extend logic — only if the new binary doesn't fit.
POOL_EXTEND=0
if [ "$POOL_SIZE" -gt "$DEPLOYED_POOL" ]; then
  POOL_EXTEND=$((POOL_SIZE - DEPLOYED_POOL + 4096))  # 4 KB safety margin
fi
VERIFIER_EXTEND=0
if [ "$VERIFIER_SIZE" -gt "$DEPLOYED_VERIFIER" ]; then
  VERIFIER_EXTEND=$((VERIFIER_SIZE - DEPLOYED_VERIFIER + 4096))
fi
say "pool extend:     $POOL_EXTEND bytes"
say "verifier extend: $VERIFIER_EXTEND bytes"

BALANCE=$(solana balance --url "$RPC" 2>&1 | awk '{print $1}')
say "authority balance: $BALANCE SOL"

if [ "$DRY_RUN" = 1 ]; then
  say "dry-run: not executing any tx. Plan above."
  exit 0
fi

# ── confirm before writing ──────────────────────────────────────────────
warn "ABOUT TO UPGRADE $CLUSTER:"
warn "  verifier_adapt → Phase 9 24-input VK (BREAKING for any client"
warn "                   sending the old 23-input wire shape)"
warn "  pool           → Phase 9 wire-shape + dual-note mint block"
warn ""
read -p "type YES to proceed: " confirm
[ "$confirm" = "YES" ] || die "aborted"

# ── 1. verifier_adapt: write-buffer → extend → upgrade ──────────────────
say "verifier: write-buffer ($VERIFIER_SIZE bytes) — ~30s"
# `solana program write-buffer` prints "Buffer: <pubkey>" on success; grep
# specifically for that prefix so we don't accidentally pick up a warning
# or progress line.
VERIFIER_BUFFER=$(solana program write-buffer "$VERIFIER_SO" --url "$RPC" 2>&1 | grep "^Buffer:" | awk '{print $2}')
[ -n "$VERIFIER_BUFFER" ] || die "verifier write-buffer returned no Buffer pubkey"
echo "{\"verifier_buffer\":\"$VERIFIER_BUFFER\"}" > "$STATE_FILE"
say "verifier buffer: $VERIFIER_BUFFER"

if [ "$VERIFIER_EXTEND" -gt 0 ]; then
  say "verifier: extend-program-data +$VERIFIER_EXTEND bytes"
  solana program extend "$VERIFIER_ID" "$VERIFIER_EXTEND" --url "$RPC"
fi

say "verifier: upgrade"
solana program upgrade "$VERIFIER_BUFFER" "$VERIFIER_ID" --url "$RPC"

# ── 2. pool: write-buffer → extend → upgrade ────────────────────────────
say "pool: write-buffer ($POOL_SIZE bytes) — ~60s"
POOL_BUFFER=$(solana program write-buffer "$POOL_SO" --url "$RPC" 2>&1 | grep "^Buffer:" | awk '{print $2}')
[ -n "$POOL_BUFFER" ] || die "pool write-buffer returned no Buffer pubkey"
echo "{\"verifier_buffer\":\"$VERIFIER_BUFFER\",\"pool_buffer\":\"$POOL_BUFFER\"}" > "$STATE_FILE"
say "pool buffer: $POOL_BUFFER"

if [ "$POOL_EXTEND" -gt 0 ]; then
  say "pool: extend-program-data +$POOL_EXTEND bytes"
  solana program extend "$POOL_ID" "$POOL_EXTEND" --url "$RPC"
fi

say "pool: upgrade"
solana program upgrade "$POOL_BUFFER" "$POOL_ID" --url "$RPC"

POST_BALANCE=$(solana balance --url "$RPC" 2>&1 | awk '{print $1}')
SPENT=$(echo "$BALANCE - $POST_BALANCE" | bc)

echo
echo "════════════════════════════════════════════════════════════════"
echo " Phase 9 $CLUSTER upgrade complete"
echo "════════════════════════════════════════════════════════════════"
echo "  pre balance:  $BALANCE SOL"
echo "  post balance: $POST_BALANCE SOL"
echo "  spent:        $SPENT SOL"
echo
echo " Verify on-chain:"
echo "   solana program show $VERIFIER_ID --url $RPC"
echo "   solana program show $POOL_ID --url $RPC"
echo
echo " Smoke test:"
echo "   SOLANA_RPC=$RPC pnpm --filter @b402ai/solana-v2-tests test phase9"
