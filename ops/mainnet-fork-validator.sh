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

CLONE_FILES=()
RESET=""
WARP_SLOT=""
MAINNET_URL="${MAINNET_URL:-https://api.mainnet-beta.solana.com}"

while (( $# )); do
  case "$1" in
    # Each --clone / --route file contributes its .programs[] and .data[]
    # arrays to the union we'll clone. Both flags are aliases.
    --clone|--route) CLONE_FILES+=("$2"); shift 2 ;;
    --reset)         RESET="--reset"; shift ;;
    --url)           MAINNET_URL="$2"; shift 2 ;;
    # Pin the fork's slot above the cloned state's last_update slots.
    # Required for protocols (e.g. Kamino) that compute current_slot -
    # last_update.slot — without warp the subtraction underflows because
    # cloned slots are from mainnet (~400M) and the fork starts at slot 1.
    --warp-slot)     WARP_SLOT="$2"; shift 2 ;;
    *) echo "unknown arg $1"; exit 1 ;;
  esac
done

if (( ${#CLONE_FILES[@]} == 0 )); then
  echo "✗ missing --clone <file> (run ops/jup-quote.ts or ops/kamino-clone.ts first)"
  echo "  multiple --clone flags are accepted; programs + data unioned across all files"
  exit 1
fi
for f in "${CLONE_FILES[@]}"; do
  if [[ ! -f "$f" ]]; then echo "✗ $f does not exist"; exit 1; fi
done

# b402 program IDs — match declare_id! in each crate.
POOL_ID=42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y
VERIFIER_T_ID=Afjbnv2Ekxa98jjRw33xPPhZabevek2uZxoE75kr6ZrK
VERIFIER_A_ID=3Y2tyhNSaUiW5AcZcmFGRyTMdnroxHxc5GqFQPcMTZae
JUP_ADAPTER_ID=3RHRcbinCmcj8JPBfVxb9FW76oh4r8y21aSx4JFy3yx7
MOCK_ADAPTER_ID=89kw33YDcbXfiayVNauz599LaDm51EuU8amWydpjYKgp
KAMINO_ADAPTER_ID=2enwFgcGKJDqruHpCtvmhtxe3DYcV3k72VTvoGcdt2rX

for so in b402_verifier_transact b402_verifier_adapt b402_pool b402_jupiter_adapter b402_mock_adapter b402_kamino_adapter; do
  if [[ ! -f "target/deploy/${so}.so" ]]; then
    echo "✗ missing target/deploy/${so}.so"
    echo "  run: cargo build-sbf --tools-version v1.54 --manifest-path programs/${so//_/-}/Cargo.toml"
    exit 1
  fi
done

# Union .programs[] and .data[] across all --clone files (macOS bash 3.2
# has no associative arrays — concat then sort -u).
PROGRAMS_RAW=""
DATA_RAW=""
for f in "${CLONE_FILES[@]}"; do
  PROGRAMS_RAW="$PROGRAMS_RAW"$'\n'"$(jq -r '.programs[]?' "$f")"
  DATA_RAW="$DATA_RAW"$'\n'"$(jq -r '.data[]?' "$f")"
  # Back-compat: jup-route style with only `.clone[]` and a swap ix.
  if jq -e '.clone? and .swap?' "$f" >/dev/null 2>&1; then
    DATA_RAW="$DATA_RAW"$'\n'"$(jq -r '.clone[]' "$f")"
    PROGRAMS_RAW="$PROGRAMS_RAW"$'\n'"$(jq -r '.swap.swapInstruction.programId' "$f")"
  fi
done
PROGRAMS=()
while IFS= read -r line; do
  [[ -n "$line" ]] && PROGRAMS+=("$line")
done < <(echo "$PROGRAMS_RAW" | grep -v '^$' | sort -u)
DATA_ACCOUNTS=()
while IFS= read -r line; do
  [[ -n "$line" ]] && DATA_ACCOUNTS+=("$line")
done < <(echo "$DATA_RAW" | grep -v '^$' | sort -u)

echo "▶ forking mainnet state from $MAINNET_URL"
echo "  ${#CLONE_FILES[@]} clone-spec file(s), ${#PROGRAMS[@]} program(s), ${#DATA_ACCOUNTS[@]} data account(s)"
echo ""
echo "  pool             = $POOL_ID"
echo "  verifier_transact = $VERIFIER_T_ID"
echo "  verifier_adapt    = $VERIFIER_A_ID"
echo "  jupiter adapter   = $JUP_ADAPTER_ID"
echo "  kamino adapter    = $KAMINO_ADAPTER_ID"
echo "  mock adapter      = $MOCK_ADAPTER_ID"
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

WARP_ARGS=()
if [[ -n "$WARP_SLOT" ]]; then
  WARP_ARGS+=(--warp-slot "$WARP_SLOT")
  echo "  warp slot         = $WARP_SLOT"
  echo ""
fi

exec solana-test-validator $RESET \
  --url "$MAINNET_URL" \
  "${WARP_ARGS[@]}" \
  "${CLONE_ARGS[@]}" \
  --bpf-program "$VERIFIER_T_ID"   target/deploy/b402_verifier_transact.so \
  --bpf-program "$VERIFIER_A_ID"   target/deploy/b402_verifier_adapt.so \
  --bpf-program "$POOL_ID"         target/deploy/b402_pool.so \
  --bpf-program "$JUP_ADAPTER_ID"  target/deploy/b402_jupiter_adapter.so \
  --bpf-program "$MOCK_ADAPTER_ID" target/deploy/b402_mock_adapter.so \
  --bpf-program "$KAMINO_ADAPTER_ID" target/deploy/b402_kamino_adapter.so \
  --log
