#!/usr/bin/env bash
# Boot a mainnet-fork harness for the percolator-adapter slice 5
# integration tests.
#
# What this loads at boot (declare_id! → .so):
#   - b402-pool                           (42a3hsCXt…)
#   - b402-nullifier                      (2AnRZwWu6…)
#   - b402-verifier-adapt                 (3Y2tyhNSa…)
#   - b402-percolator-adapter             (65NRt6Gpe…) [keypair-derived]
#   - percolator-prog (upstream)            (DzLTTqyx7…)
#   - percolator-match passive_lp         (BoYEMRSe6…)
#
# What it clones from mainnet:
#   - Mainnet USDC mint (collateral for percolator's slab + b402 shielded
#     pool). Same pubkey both layers use, so a single clone suffices.
#
# Light Protocol services (Photon indexer, Light prover, address tree)
# are launched alongside by `light test-validator` — required for b402's
# nullifier-set CPI.
#
# After this is up, run the percolator-cli setup script
# (`tests/v2/scripts/init-percolator-market.sh`) to create a fresh slab,
# fund an LP, and emit a JSON state file the e2e tests consume.
#
# Pre-conditions:
#   - target/deploy/b402_pool.so + nullifier + verifier_adapt + b402_percolator_adapter.so
#   - ~/development/ai/percolator-prog/target/deploy/percolator_prog.so
#   - ~/development/ai/percolator-match/target/deploy/percolator_match.so
#   - light + solana CLI tools on PATH; ~/.config/solana/id.json present
#
# Usage:
#   tests/v2/scripts/start-percolator-fork.sh
#
# Stop:
#   light test-validator --stop

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# --- b402 program IDs (declare_id!, must match SDK + Anchor.toml) ---
POOL_ID="42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y"
NULLIFIER_ID="2AnRZwWu6CTurZs1yQpqrcJWo4yRYL1xpeV78b2siweq"
VERIFIER_ADAPT_ID="3Y2tyhNSaUiW5AcZcmFGRyTMdnroxHxc5GqFQPcMTZae"
VERIFIER_TRANSACT_ID="Afjbnv2Ekxa98jjRw33xPPhZabevek2uZxoE75kr6ZrK"
PERCOLATOR_ADAPTER_ID="65NRt6GpeakqXhqvKcN3knohzKEZT37arUyQi3SZwfxv"

# --- percolator IDs (upstream keypairs) ---
PERCOLATOR_PROG_ID="DzLTTqyx7tFjwseeDTnu4f6c55H5abPgcohRVkNCS4Bn"
PERCOLATOR_MATCH_ID="BoYEMRSe6cRw6jswHtApQVqjLf1PPakfuuDyxgWijYBU"

# --- mainnet USDC ---
USDC_MINT="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

# --- .so files ---
# Default to mainnet's binary for the pool — local builds with our feature
# combo strip panic strings, and the resulting binary fails init_pool with
# an Access violation at addr 0x32 (Borsh panic dereferences NULL fmt
# pointer). Mainnet's binary works on this validator. Override with
# POOL_SO=path/to/local.so if you specifically want to test a local change.
POOL_SO="${POOL_SO:-/tmp/mainnet_pool.so}"
NULLIFIER_SO="$ROOT/programs/b402-nullifier/target/deploy/b402_nullifier.so"
VERIFIER_ADAPT_SO="$ROOT/target/deploy/b402_verifier_adapt.so"
VERIFIER_TRANSACT_SO="${VERIFIER_TRANSACT_SO:-/tmp/mainnet_verifier_transact.so}"
PERCOLATOR_ADAPTER_SO="$ROOT/target/deploy/b402_percolator_adapter.so"
PERCOLATOR_PROG_SO="${PERCOLATOR_PROG_SO:-$HOME/development/ai/percolator-prog/target/deploy/percolator_prog.so}"
PERCOLATOR_MATCH_SO="${PERCOLATOR_MATCH_SO:-$HOME/development/ai/percolator-match/target/deploy/percolator_match.so}"

for f in "$POOL_SO" "$NULLIFIER_SO" "$VERIFIER_ADAPT_SO" "$VERIFIER_TRANSACT_SO" "$PERCOLATOR_ADAPTER_SO" "$PERCOLATOR_PROG_SO" "$PERCOLATOR_MATCH_SO"; do
  if [[ ! -f "$f" ]]; then
    echo "FAIL: missing $f" >&2
    echo "  - b402 .so: 'anchor build' (and rebuild b402-nullifier separately)" >&2
    echo "  - percolator-prog: 'cd ~/development/ai/percolator-prog && cargo build-sbf'" >&2
    echo "  - percolator-match: 'cd ~/development/ai/percolator-match && cargo build-sbf'" >&2
    exit 1
  fi
done

UPGRADE_AUTH="$HOME/.config/solana/id.json"
if [[ ! -f "$UPGRADE_AUTH" ]]; then
  echo "FAIL: $UPGRADE_AUTH missing — set up Solana CLI keypair first." >&2
  exit 1
fi

PERCOLATOR_PROG_KP="${PERCOLATOR_PROG_KP:-$HOME/development/ai/percolator-prog/target/deploy/percolator_prog-keypair.json}"
PERCOLATOR_MATCH_KP="${PERCOLATOR_MATCH_KP:-$HOME/development/ai/percolator-match/target/deploy/percolator_match-keypair.json}"

echo "==> stopping any previous test-validator"
light test-validator --stop || true

echo "==> starting mainnet-forked test-validator + Photon"
echo "    pool=$POOL_ID nullifier=$NULLIFIER_ID verifier_adapt=$VERIFIER_ADAPT_ID"
echo "    percolator_adapter=$PERCOLATOR_ADAPTER_ID"
echo "    percolator_prog=$PERCOLATOR_PROG_ID match=$PERCOLATOR_MATCH_ID"
echo "    USDC=$USDC_MINT (cloned from mainnet)"

# Boot args: load every program at boot. Keep this list tight — Light's
# --validator-args has a hard arg-length cap (kamino harness hit it
# around 7 --clone flags). Six --upgradeable-program entries fits cleanly.
BOOT_ARGS="\
  --upgradeable-program $POOL_ID $POOL_SO $UPGRADE_AUTH \
  --upgradeable-program $NULLIFIER_ID $NULLIFIER_SO $UPGRADE_AUTH \
  --upgradeable-program $VERIFIER_TRANSACT_ID $VERIFIER_TRANSACT_SO $UPGRADE_AUTH \
  --upgradeable-program $VERIFIER_ADAPT_ID $VERIFIER_ADAPT_SO $UPGRADE_AUTH \
  --upgradeable-program $PERCOLATOR_ADAPTER_ID $PERCOLATOR_ADAPTER_SO $UPGRADE_AUTH \
  --upgradeable-program $PERCOLATOR_PROG_ID $PERCOLATOR_PROG_SO $UPGRADE_AUTH \
  --upgradeable-program $PERCOLATOR_MATCH_ID $PERCOLATOR_MATCH_SO $UPGRADE_AUTH"

# Optional: inject a pre-funded USDC ATA so alice has spendable USDC.
# USDC mint authority is Circle's — we can't mint locally — so the
# pattern is: clone an ATA off mainnet that already has USDC, dump it
# to a JSON file, inject the file at boot under a wallet we control.
INJECT_ARGS=""
if [[ -n "${INJECT_USDC_ATA:-}" && -n "${ALICE_USDC_ATA:-}" && -f "$INJECT_USDC_ATA" ]]; then
  INJECT_ARGS="--account $ALICE_USDC_ATA $INJECT_USDC_ATA"
  echo "    injecting USDC ATA $ALICE_USDC_ATA from $INJECT_USDC_ATA"
fi

VALIDATOR_ARGS=$(echo "--url mainnet-beta --clone $USDC_MINT $INJECT_ARGS" | tr -s ' ' | sed 's/^ //;s/ $//')

light test-validator $BOOT_ARGS \
  --validator-args "$VALIDATOR_ARGS"
