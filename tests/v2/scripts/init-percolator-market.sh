#!/usr/bin/env bash
# Bootstrap a fresh percolator market on a running surfpool fork.
#
# What this does (step by step, human-runnable):
#   1. Generate a fresh slab keypair (saved to /tmp/percolator-slab-keypair.json).
#   2. Generate a vault keypair + create the collateral vault SPL account.
#   3. Call `percolator-cli init-market` in Hyperp mode (no external oracle —
#      mark price is the slab's own; lets the harness run without Pyth/Switchboard).
#   4. Generate a matcher-context keypair + initialize the passive LP matcher.
#   5. Call `percolator-cli init-lp` with a fixed `lp_idx = 0` + fee.
#   6. Emit /tmp/percolator-market.json with all addresses the e2e harness needs:
#        { slab, vault, mint, matcher_program, matcher_context, lp_owner,
#          lp_idx, lp_pda, oracle, percolator_program, percolator_adapter }
#
# Pre-conditions:
#   - `tests/v2/scripts/start-percolator-fork.sh` running in another terminal
#   - `~/development/ai/percolator-cli` installed (`pnpm install` + build)
#   - `solana config set --url http://127.0.0.1:8899` pointing at the fork
#   - `~/.config/solana/id.json` funded (run `solana airdrop 100` first)
#
# Usage:
#   tests/v2/scripts/init-percolator-market.sh
#
# Output:
#   /tmp/percolator-market.json — consumed by examples/percolator-adapter-fork.mjs
#
# This script is a runbook/scaffold — actual percolator-cli invocations
# need parameter tuning per market type. v1 uses Hyperp + the passive
# matcher because both are oracle-free and easiest to reason about.

set -euo pipefail

PERCOLATOR_CLI="${PERCOLATOR_CLI:-$HOME/development/ai/percolator-cli/dist/cli.js}"
USDC_MINT="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
PERCOLATOR_PROG="DzLTTqyx7tFjwseeDTnu4f6c55H5abPgcohRVkNCS4Bn"
PERCOLATOR_MATCH="BoYEMRSe6cRw6jswHtApQVqjLf1PPakfuuDyxgWijYBU"
PERCOLATOR_ADAPTER="65NRt6GpeakqXhqvKcN3knohzKEZT37arUyQi3SZwfxv"
RPC="${RPC:-http://127.0.0.1:8899}"

if [[ ! -f "$PERCOLATOR_CLI" ]]; then
  echo "FAIL: percolator-cli not found at $PERCOLATOR_CLI" >&2
  echo "      cd ~/development/ai/percolator-cli && pnpm install && pnpm build" >&2
  exit 1
fi

# 1. Slab + vault keypairs
SLAB_KP="${SLAB_KP:-/tmp/percolator-slab-keypair.json}"
VAULT_KP="${VAULT_KP:-/tmp/percolator-vault-keypair.json}"
MATCHER_CTX_KP="${MATCHER_CTX_KP:-/tmp/percolator-matcher-ctx-keypair.json}"
solana-keygen new --no-bip39-passphrase --silent --force --outfile "$SLAB_KP"
solana-keygen new --no-bip39-passphrase --silent --force --outfile "$VAULT_KP"
solana-keygen new --no-bip39-passphrase --silent --force --outfile "$MATCHER_CTX_KP"

SLAB=$(solana address -k "$SLAB_KP")
VAULT=$(solana address -k "$VAULT_KP")
MATCHER_CTX=$(solana address -k "$MATCHER_CTX_KP")

echo "==> slab=$SLAB"
echo "==> vault=$VAULT"
echo "==> matcher_ctx=$MATCHER_CTX"

# 2. Create the collateral vault (SPL token account owned by the slab's PDA).
#    percolator's vault_authority PDA: derive_vault_authority(slab) — see
#    ~/development/ai/percolator-cli/src/solana/pda.ts. We delegate the
#    full account creation + ix sequencing to percolator-cli.

# 3. init-market (Hyperp mode — index_feed_id all zeros, mark price set
#    by us). All values are illustrative defaults; tune per test scenario.
INDEX_FEED_ID="0000000000000000000000000000000000000000000000000000000000000000"

echo "==> percolator-cli init-market (Hyperp, $200 mark)"
node "$PERCOLATOR_CLI" \
  --rpc-url "$RPC" \
  --keypair "$HOME/.config/solana/id.json" \
  init-market \
  --slab "$SLAB" \
  --mint "$USDC_MINT" \
  --vault "$VAULT" \
  --index-feed-id "$INDEX_FEED_ID" \
  --max-staleness-secs 60 \
  --conf-filter-bps 100 \
  --invert 0 \
  --unit-scale 0 \
  --initial-mark-price 200000000 \
  --maintenance-fee-per-slot 0 \
  --h-min 100 \
  --h-max 1000 \
  --maintenance-margin-bps 500 \
  --initial-margin-bps 1000 \
  --trading-fee-bps 5 \
  --max-accounts 1024 \
  --new-account-fee 1000 \
  --max-crank-staleness 100 \
  --liquidation-fee-bps 50

# 4. + 5. Matcher init + init-lp
#
# These are placeholders — passive matcher init + LP init have specific
# arg schemas that need to be confirmed from percolator-match's program
# source. Slice 5 next pass: hand-run the CLI commands once, capture the
# successful arg sets here, then emit the JSON state file.

echo
echo "TODO: matcher init + init-lp commands once per-test-validator runs"
echo "      have validated the right arg shapes."
echo
echo "Bootstrap-so-far:"
cat <<EOF | tee /tmp/percolator-market.json
{
  "rpc": "$RPC",
  "slab": "$SLAB",
  "vault": "$VAULT",
  "mint": "$USDC_MINT",
  "matcher_program": "$PERCOLATOR_MATCH",
  "matcher_context": "$MATCHER_CTX",
  "percolator_program": "$PERCOLATOR_PROG",
  "percolator_adapter": "$PERCOLATOR_ADAPTER",
  "_status": "init-market done; matcher-init + init-lp pending"
}
EOF
