#!/bin/bash
# Mainnet alpha initialization: init pool, register adapter, add USDC + wSOL
# token configs. Run AFTER ./ops/mainnet-deploy.sh.

set -euo pipefail
cd "$(dirname "$0")/.."

POOL_ID=42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y
VERIFIER_T_ID=Afjbnv2Ekxa98jjRw33xPPhZabevek2uZxoE75kr6ZrK
VERIFIER_A_ID=3Y2tyhNSaUiW5AcZcmFGRyTMdnroxHxc5GqFQPcMTZae
JUP_ADAPTER_ID=3RHRcbinCmcj8JPBfVxb9FW76oh4r8y21aSx4JFy3yx7

USDC=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
WSOL=So11111111111111111111111111111111111111112
JUP_V6=JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4

echo "== mainnet init =="

# Allow caller to override RPC_URL (e.g. Helius); otherwise default to public mainnet.
: "${RPC_URL:=https://api.mainnet-beta.solana.com}"
: "${ADMIN_KEYPAIR:=$HOME/.config/solana/id.json}"

export RPC_URL ADMIN_KEYPAIR POOL_ID VERIFIER_T_ID VERIFIER_A_ID JUP_ADAPTER_ID USDC WSOL JUP_V6
(cd examples && pnpm exec tsx mainnet-init.ts)

echo ""
echo "== mainnet init complete =="
echo "next: cd examples && pnpm tsx mainnet-private-swap.ts"
