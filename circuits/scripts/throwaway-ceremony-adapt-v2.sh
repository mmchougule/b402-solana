#!/usr/bin/env bash
# Throwaway Phase-1 + Phase-2 trusted setup for the ADAPT v2 circuit.
# DO NOT USE FOR MAINNET. Production ceremony plan is in PRD-08 §2.

set -euo pipefail

cd "$(dirname "$0")/.."

mkdir -p build/ceremony

echo "⚠️  THROWAWAY CEREMONY — DEVNET / LOCAL ONLY (adapt v2)"
echo "⚠️  The entropy below is NOT audited, NOT witnessed, and the resulting"
echo "⚠️  zkey MUST NEVER be deployed to mainnet."

# Adapt v2 circuit has ~22,500 constraints; fits in 2^17 powers of tau.
# Reuse the same PPoT file the v1 ceremony downloaded if present.
PTAU=build/ceremony/powersOfTau28_hez_final_17.ptau
if [ ! -f "$PTAU" ]; then
    echo "→ downloading PPoT Phase-1 (2^17 constraints)"
    curl -L -o "$PTAU" \
        "https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_17.ptau"
fi

ZKEY0=build/ceremony/adapt_v2_0000.zkey
ZKEY1=build/ceremony/adapt_v2_final.zkey

echo "→ pnpm exec snarkjs groth16 setup (Phase-2 init)"
pnpm exec snarkjs groth16 setup build/adapt_v2.r1cs "$PTAU" "$ZKEY0"

echo "→ pnpm exec snarkjs zkey contribute (throwaway)"
pnpm exec snarkjs zkey contribute "$ZKEY0" "$ZKEY1" \
    --name="throwaway-adapt-v2-$(date +%s)" \
    -e="$(head -c 32 /dev/urandom | xxd -p)"

echo "→ pnpm exec snarkjs zkey export verificationkey"
pnpm exec snarkjs zkey export verificationkey "$ZKEY1" build/ceremony/adapt_v2_verification_key.json

echo "✓ adapt v2 ceremony complete. zkey: $ZKEY1"
echo "  VK hash:"
sha256sum build/ceremony/adapt_v2_verification_key.json
