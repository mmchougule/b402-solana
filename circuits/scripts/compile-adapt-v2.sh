#!/usr/bin/env bash
# Compile adapt_v2.circom to R1CS + WASM + symbols.
# Artifacts land in circuits/build/.
# Requires: circom 2.2.x, pnpm exec snarkjs, node >= 20.

set -euo pipefail

cd "$(dirname "$0")/.."

mkdir -p build

echo "→ circom compile adapt_v2.circom"
circom adapt_v2.circom \
    --r1cs \
    --wasm \
    --sym \
    --O2 \
    -o build \
    -l node_modules

echo "→ pnpm exec snarkjs r1cs info"
pnpm exec snarkjs r1cs info build/adapt_v2.r1cs | tee build/adapt_v2.r1cs.info.txt

echo "→ pnpm exec snarkjs r1cs export json (for auditor inspection)"
pnpm exec snarkjs r1cs export json build/adapt_v2.r1cs build/adapt_v2.r1cs.json >/dev/null

echo "✓ compile complete. Constraint count in build/adapt_v2.r1cs.info.txt"
