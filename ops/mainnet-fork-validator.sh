#!/bin/bash
# Boot solana-test-validator with real Jupiter V6 + AMM pool state cloned
# from mainnet, plus all four b402 programs pre-deployed. Lets us run
# privateSwap end-to-end against production Jupiter bytecode without a
# devnet roundtrip or real money.
#
# Flow:
#   1. `ops/jup-quote.ts` fetches a real mainnet Jupiter quote + the list
#      of mainnet accounts the swap ix touches.
#   2. This script reads that list and boots the test validator with
#      `--clone` flags for every referenced account + programs.
#   3. examples/swap-e2e-jupiter.ts runs against http://127.0.0.1:8899
#      and submits the same swap the mainnet route promised.
#
# Usage:
#   # One-time: fetch a quote.
#   cd examples && pnpm tsx ../ops/jup-quote.ts \
#     --in EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
#     --out So11111111111111111111111111111111111111112 \
#     --amount 1000000 \
#     --caller $(solana address) \
#     --out-file /tmp/jup-route.json
#
#   # Boot the fork.
#   ./ops/mainnet-fork-validator.sh --route /tmp/jup-route.json --reset

set -euo pipefail
cd "$(dirname "$0")/.."

ROUTE_FILE=""
RESET=""
MAINNET_URL="${MAINNET_URL:-https://api.mainnet-beta.solana.com}"

while (( $# )); do
  case "$1" in
    --route)  ROUTE_FILE="$2"; shift 2 ;;
    --reset)  RESET="--reset"; shift ;;
    --url)    MAINNET_URL="$2"; shift 2 ;;
    *) echo "unknown arg $1"; exit 1 ;;
  esac
done

if [[ -z "$ROUTE_FILE" || ! -f "$ROUTE_FILE" ]]; then
  echo "✗ missing --route <file> (run ops/jup-quote.ts first)"
  exit 1
fi

# b402 program IDs — match declare_id! in each crate.
POOL_ID=42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y
VERIFIER_ID=Afjbnv2Ekxa98jjRw33xPPhZabevek2uZxoE75kr6ZrK
ADAPTER_ID=3RHRcbinCmcj8JPBfVxb9FW76oh4r8y21aSx4JFy3yx7
MOCK_ADAPTER_ID=89kw33YDcbXfiayVNauz599LaDm51EuU8amWydpjYKgp

# Require the pool .so to be built with --features adapt-devnet.
for so in b402_verifier_transact b402_pool b402_jupiter_adapter b402_mock_adapter; do
  if [[ ! -f "target/deploy/${so}.so" ]]; then
    echo "✗ missing target/deploy/${so}.so"
    exit 1
  fi
done

# Extract programs + data accounts from the route JSON.
# `.programs` was added to jup-quote.ts output — it's the executable-true
# accounts that need --clone-upgradeable-program. `.data` is the rest.
PROGRAMS=()
while IFS= read -r line; do PROGRAMS+=("$line"); done < <(jq -r '.programs[]?' "$ROUTE_FILE")
DATA_ACCOUNTS=()
while IFS= read -r line; do DATA_ACCOUNTS+=("$line"); done < <(jq -r '.data[]?' "$ROUTE_FILE")

# Back-compat: older route files had only .clone — treat as data.
if [[ ${#PROGRAMS[@]} -eq 0 && ${#DATA_ACCOUNTS[@]} -eq 0 ]]; then
  while IFS= read -r line; do DATA_ACCOUNTS+=("$line"); done < <(jq -r '.clone[]' "$ROUTE_FILE")
  PROGRAMS=("$(jq -r '.swap.swapInstruction.programId' "$ROUTE_FILE")")
fi

echo "▶ forking mainnet state from $MAINNET_URL"
echo "  ${#PROGRAMS[@]} program(s), ${#DATA_ACCOUNTS[@]} data account(s) to clone"
echo ""
echo "  pool     = $POOL_ID"
echo "  verifier = $VERIFIER_ID"
echo "  adapter  = $ADAPTER_ID"
echo ""

# Programs must be cloned as upgradeable so the BPF loader registers them.
# Data accounts use --maybe-clone (skips if missing on mainnet, e.g. fresh
# test wallets that haven't interacted with mainnet).
CLONE_ARGS=()
for p in "${PROGRAMS[@]}"; do
  CLONE_ARGS+=(--clone-upgradeable-program "$p")
done
for a in "${DATA_ACCOUNTS[@]}"; do
  CLONE_ARGS+=(--maybe-clone "$a")
done

exec solana-test-validator $RESET \
  --url "$MAINNET_URL" \
  "${CLONE_ARGS[@]}" \
  --bpf-program "$VERIFIER_ID" target/deploy/b402_verifier_transact.so \
  --bpf-program "$POOL_ID" target/deploy/b402_pool.so \
  --bpf-program "$ADAPTER_ID" target/deploy/b402_jupiter_adapter.so \
  --bpf-program "$MOCK_ADAPTER_ID" target/deploy/b402_mock_adapter.so \
  --log
