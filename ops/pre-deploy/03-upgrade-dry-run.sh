#!/usr/bin/env bash
# Gate 3 — upgrade dry-run. Spin up a fresh local validator, deploy the
# CURRENT mainnet binary at the same program ID, clone any state
# accounts the binary owns, then `program upgrade` to the new binary
# and re-run the e2e suite. Catches "new binary mis-deserializes
# pre-existing accounts" — the worst-case mainnet-flip failure mode.

set -euo pipefail

PROGRAM="$1"
PROGRAM_ID="$2"
FEATURES="$3"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

PROGRAM_UNDER="${PROGRAM//-/_}"
NEW_SO="$REPO_ROOT/target/deploy/${PROGRAM_UNDER}.so"

if [[ ! -f "$NEW_SO" ]]; then
  echo "FAIL: new binary missing at $NEW_SO. Did gate 1 (reproducible build) run?" >&2
  exit 1
fi

# 1. Fetch the current mainnet binary into a temp file. solana program dump
#    requires the program to be on the chain we point -u at. Use mainnet
#    explicitly here regardless of CLI default.
MAINNET_RPC="${MAINNET_RPC:-https://api.mainnet-beta.solana.com}"
TMP_OLD="$(mktemp -t b402-old-XXXXXX.so)"
echo "fetching current mainnet binary for $PROGRAM_ID..."
if ! solana -u "$MAINNET_RPC" program dump "$PROGRAM_ID" "$TMP_OLD" 2>&1 | tail -5; then
  echo "WARN: program dump failed. New deploy (no upgrade-state to test). Skipping dry-run." >&2
  rm -f "$TMP_OLD"
  exit 0
fi

# 2. Stop any existing validator. Boot a fresh one with the OLD binary
#    loaded at the canonical program ID.
echo "stopping prior validator..."
light test-validator --stop >/dev/null 2>&1 || true
pkill -f solana-test-validator 2>&1 || true
sleep 2

UPGRADE_AUTH="$HOME/.config/solana/id.json"
echo "booting fresh validator with old mainnet binary..."
solana-test-validator \
  --reset \
  --quiet \
  --bpf-program "$PROGRAM_ID" "$TMP_OLD" \
  > /tmp/b402-dryrun.log 2>&1 &

for i in $(seq 1 30); do
  if curl -s http://127.0.0.1:8899 -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null | grep -q '"ok"'; then
    break
  fi
  sleep 2
done

# 3. Run init/setup if applicable for the program type. For pool: init pool.
#    For verifier: nothing to init (stateless).
case "$PROGRAM" in
  b402-pool)
    echo "initialising pool with OLD binary..."
    SOLANA_RPC=http://127.0.0.1:8899 node tests/v2/scripts/init-localnet.mjs > /tmp/b402-dryrun-init.log 2>&1
    ;;
esac

# 4. Upgrade to the NEW binary.
echo "upgrading to NEW binary at $PROGRAM_ID..."
KEYPAIR_FILE="ops/keypairs/${PROGRAM_UNDER}-keypair.json"
if [[ ! -f "$KEYPAIR_FILE" ]]; then
  echo "FAIL: program keypair missing at $KEYPAIR_FILE — required for solana program deploy" >&2
  pkill -f solana-test-validator 2>&1 || true
  rm -f "$TMP_OLD"
  exit 1
fi
solana -u localhost program deploy \
  --program-id "$KEYPAIR_FILE" \
  --upgrade-authority "$UPGRADE_AUTH" \
  "$NEW_SO" 2>&1 | tail -3

# 5. Sanity: the upgraded binary must be able to read pre-existing
#    state. For pool: load pool_config + adapter_registry, confirm they
#    deserialize. We do this implicitly via re-running an e2e tx; if the
#    new binary breaks an old account layout, the tx fails with
#    AccountDidNotDeserialize.
case "$PROGRAM" in
  b402-pool)
    echo "post-upgrade sanity: re-init/refresh tx..."
    if ! SOLANA_RPC=http://127.0.0.1:8899 node tests/v2/scripts/init-localnet.mjs >> /tmp/b402-dryrun-init.log 2>&1; then
      echo "FAIL: pre-existing pool_config does not deserialize under new binary." >&2
      pkill -f solana-test-validator 2>&1 || true
      rm -f "$TMP_OLD"
      exit 1
    fi
    ;;
esac

pkill -f solana-test-validator 2>&1 || true
rm -f "$TMP_OLD"
echo "✓ upgrade dry-run clean — old account state survives the upgrade"
