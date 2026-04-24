#!/usr/bin/env bash
# Throwaway Phase-1 + Phase-2 trusted setup for Track B devnet prototype.
# DO NOT USE FOR MAINNET. Production ceremony plan is in PRD-08 §2.

set -euo pipefail

cd "$(dirname "$0")/.."

mkdir -p build/ceremony

echo "⚠️  THROWAWAY CEREMONY — DEVNET ONLY"
echo "⚠️  The entropy below is NOT audited, NOT witnessed, and the resulting"
echo "⚠️  zkey MUST NEVER be deployed to mainnet."

PTAU=build/ceremony/powersOfTau28_hez_final_17.ptau
if [ ! -f "$PTAU" ]; then
    echo "→ downloading PPoT Phase-1 (2^17 constraints)"
    curl -L -o "$PTAU" \
        "https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_17.ptau"
fi

ZKEY0=build/ceremony/transact_0000.zkey
ZKEY1=build/ceremony/transact_final.zkey

echo "→ pnpm exec snarkjs groth16 setup (Phase-2 init)"
pnpm exec snarkjs groth16 setup build/transact.r1cs "$PTAU" "$ZKEY0"

echo "→ pnpm exec snarkjs zkey contribute (throwaway)"
pnpm exec snarkjs zkey contribute "$ZKEY0" "$ZKEY1" \
    --name="throwaway-$(date +%s)" \
    -e="$(head -c 32 /dev/urandom | xxd -p)"

echo "→ pnpm exec snarkjs zkey export verificationkey"
pnpm exec snarkjs zkey export verificationkey "$ZKEY1" build/ceremony/verification_key.json

echo "✓ ceremony complete. zkey: $ZKEY1"
echo "  VK hash:"
sha256sum build/ceremony/verification_key.json
