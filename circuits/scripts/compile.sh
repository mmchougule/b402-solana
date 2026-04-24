#!/usr/bin/env bash
# Compile transact.circom to R1CS + WASM + symbols.
# Artifacts land in circuits/build/.
# Requires: circom 2.2.x, pnpm exec snarkjs, node >= 20.

set -euo pipefail

cd "$(dirname "$0")/.."

mkdir -p build

echo "→ circom compile transact.circom"
circom transact.circom \
    --r1cs \
    --wasm \
    --sym \
    --O2 \
    -o build \
    -l node_modules

echo "→ pnpm exec snarkjs r1cs info"
pnpm exec snarkjs r1cs info build/transact.r1cs | tee build/transact.r1cs.info.txt

echo "→ pnpm exec snarkjs r1cs export json (for auditor inspection)"
pnpm exec snarkjs r1cs export json build/transact.r1cs build/transact.r1cs.json >/dev/null

echo "✓ compile complete. Constraint count in build/transact.r1cs.info.txt"
