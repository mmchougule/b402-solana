#!/bin/bash
# One-shot: discover Kamino state, generate alice + USDC ATA injection,
# boot the mainnet-fork validator. After this lands, run:
#
#   pnpm tsx examples/kamino-fork-deposit.ts
#
# to exercise the full deposit flow against real cloned Kamino bytecode.

set -euo pipefail
cd "$(dirname "$0")/.."

ALICE_KEYPAIR=/tmp/b402-alice.json
ALICE_USDC_ATA_FILE=/tmp/alice-usdc-ata.json
KAMINO_CLONE=/tmp/kamino-clone.json

if [[ ! -f "$ALICE_KEYPAIR" ]]; then
  echo "▶ generating alice keypair → $ALICE_KEYPAIR"
  solana-keygen new --no-bip39-passphrase --silent --outfile "$ALICE_KEYPAIR" --force
fi
ALICE_PUBKEY=$(solana-keygen pubkey "$ALICE_KEYPAIR")
echo "  alice = $ALICE_PUBKEY"

if [[ ! -f "$KAMINO_CLONE" ]]; then
  echo "▶ enumerating Kamino mainnet accounts → $KAMINO_CLONE"
  ( cd examples && pnpm tsx ../ops/kamino-clone.ts --out-file "$KAMINO_CLONE" )
fi

echo "▶ generating alice USDC ATA injection json"
( cd examples && pnpm tsx ../ops/inject-usdc-ata.ts \
    --owner "$ALICE_PUBKEY" \
    --mint  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
    --amount 100000000 \
    --out   "$ALICE_USDC_ATA_FILE" )
ALICE_USDC_ATA=$(jq -r '.pubkey' "$ALICE_USDC_ATA_FILE")
echo "  ata = $ALICE_USDC_ATA"

# Warp above the cloned reserve's last_update.slot. We over-shoot to be safe.
WARP_SLOT=${WARP_SLOT:-415900000}

# Restart the validator clean.
pkill -f solana-test-validator 2>&1 || true
sleep 2
rm -rf test-ledger

echo "▶ booting mainnet-fork validator"
./ops/mainnet-fork-validator.sh \
  --clone "$KAMINO_CLONE" \
  --warp-slot "$WARP_SLOT" \
  --account "$ALICE_USDC_ATA" "$ALICE_USDC_ATA_FILE" \
  --reset > /tmp/v-fork.log 2>&1 &

# Wait for RPC to come up.
for i in {1..30}; do
  if solana -u http://127.0.0.1:8899 cluster-version >/dev/null 2>&1; then break; fi
  sleep 1
done
SLOT=$(solana -u http://127.0.0.1:8899 slot)
echo "▶ fork up at slot $SLOT"
echo "▶ next: pnpm tsx examples/kamino-fork-deposit.ts  (alice keypair: $ALICE_KEYPAIR)"
