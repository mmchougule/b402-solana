#!/usr/bin/env bash
# Gate 2 — mainnet-fork e2e. Boot the local fork validator with the
# new binary, run the fork-tagged tests for the changed program. Pass
# = no test failure; fail = abort upgrade.

set -euo pipefail

PROGRAM="$1"
PROGRAM_ID="$2"
FEATURES="$3"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

echo "stopping any prior validator..."
light test-validator --stop >/dev/null 2>&1 || true

echo "booting fork validator with prd_35 + per_user_obligation feature
binaries..."
INJECT_USDC_ATA=/tmp/alice-usdc-ata.json \
ALICE_USDC_ATA="${ALICE_USDC_ATA:-C8pMt1GJcVximLsVjz1xiu9FgYuEjLnaAPzCbgQGUfGy}" \
  tests/v2/scripts/start-mainnet-fork.sh > /tmp/b402-fork.log 2>&1 &

# Wait up to 120s for RPC.
for i in $(seq 1 60); do
  if curl -s http://127.0.0.1:8899 -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null | grep -q '"ok"'; then
    echo "  rpc ok at ${i}s"
    break
  fi
  sleep 2
done

echo "initialising pool..."
node tests/v2/scripts/init-localnet.mjs > /tmp/b402-init.log 2>&1

# Per-program test selection. PRD-34 §4.2 lists the required tests.
case "$PROGRAM" in
  b402-pool)
    TESTS=(
      "tests/v2/e2e/v2_fork_lend_per_user.test.ts"
      "tests/v2/e2e/v2_fork_swap.test.ts"
      "tests/v2/e2e/prd_35_pending_inputs_smoke.test.ts"
    )
    ;;
  b402-verifier-adapt)
    TESTS=(
      "tests/v2/e2e/prd_35_pending_inputs_smoke.test.ts"
    )
    ;;
  b402-kamino-adapter)
    TESTS=(
      "tests/v2/e2e/v2_fork_lend_per_user.test.ts"
    )
    ;;
  *)
    echo "WARN: no fork-tests defined for $PROGRAM. Add in $0." >&2
    TESTS=()
    ;;
esac

if [[ ${#TESTS[@]} -eq 0 ]]; then
  echo "✓ no required fork tests for $PROGRAM (gate skipped)"
  exit 0
fi

cd tests/v2
for t in "${TESTS[@]}"; do
  rel="${t#tests/v2/}"
  echo "running $rel ..."
  if ! B402_FORK_PRD_35=1 pnpm vitest run "$rel" --no-coverage; then
    echo "FAIL: $rel" >&2
    light test-validator --stop >/dev/null 2>&1 || true
    exit 1
  fi
done

light test-validator --stop >/dev/null 2>&1 || true
echo "✓ all required fork tests green for $PROGRAM"
