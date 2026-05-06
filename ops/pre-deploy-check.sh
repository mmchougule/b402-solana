#!/usr/bin/env bash
# PRD-34 pre-deploy gate. Wraps 5 independent checks; any non-zero exit
# aborts BEFORE the irreversible `solana program upgrade` runs.
#
# Usage:
#   ops/pre-deploy-check.sh <program-name> <program-id> [features]
#
# Examples:
#   ops/pre-deploy-check.sh b402-pool \
#       42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y \
#       inline_cpi_nullifier,phase_9_dual_note,prd_35_pending_inputs
#
#   ops/pre-deploy-check.sh b402-verifier-adapt \
#       3Y2tyhNSaUiW5AcZcmFGRyTMdnroxHxc5GqFQPcMTZae \
#       phase_9_dual_note
#
# Bypass for emergency hotfixes (logged):
#   ops/pre-deploy-check.sh ... --skip-checks
#
# Each gate is a separate sub-script in ops/pre-deploy/. They can be run
# individually for fast iteration; this wrapper is the canonical full run.

set -euo pipefail

PROGRAM="${1:?usage: $0 <program-name> <program-id> [features]}"
PROGRAM_ID="${2:?usage: $0 <program-name> <program-id> [features]}"
FEATURES="${3:-}"
SKIP_CHECKS=""
for arg in "${@:4}"; do
  if [[ "$arg" == "--skip-checks" ]]; then
    SKIP_CHECKS="1"
    echo "WARN: --skip-checks bypass requested. Logged for postmortem." >&2
  fi
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GATES_DIR="$REPO_ROOT/ops/pre-deploy"

# Sanity: require gates dir exists.
if [[ ! -d "$GATES_DIR" ]]; then
  echo "FAIL: gates dir missing at $GATES_DIR" >&2
  exit 1
fi

run_gate() {
  local n=$1; local name=$2; local script=$3
  echo ""
  echo "=== gate $n/5: $name ==="
  if ! "$script" "$PROGRAM" "$PROGRAM_ID" "$FEATURES"; then
    echo "FAIL: gate $n ($name) failed" >&2
    if [[ -z "$SKIP_CHECKS" ]]; then
      echo "ABORT: not safe to upgrade $PROGRAM_ID. Re-run individual gate" >&2
      echo "       to debug, or pass --skip-checks (logged) to override." >&2
      exit 1
    fi
    echo "WARN: skip-checks overrode gate $n failure." >&2
  fi
}

run_gate 1 "reproducible build" "$GATES_DIR/01-reproducible-build.sh"
run_gate 2 "mainnet-fork e2e" "$GATES_DIR/02-mainnet-fork-e2e.sh"
run_gate 3 "upgrade dry-run" "$GATES_DIR/03-upgrade-dry-run.sh"
run_gate 4 "IDL diff" "$GATES_DIR/04-idl-diff.sh"
run_gate 5 "CU + tx size budget" "$GATES_DIR/05-cu-budget.sh"

echo ""
echo "✓ all 5 gates passed for $PROGRAM"
echo ""
echo "Safe to run:"
echo "  solana -u mainnet-beta program write-buffer target/deploy/${PROGRAM//-/_}.so \\"
echo "    --max-len <new-program-data-size>"
echo "  solana -u mainnet-beta program upgrade <buffer-pubkey> $PROGRAM_ID \\"
echo "    --upgrade-authority <auth-keypair>"
echo ""
echo "Capture the buffer pubkey + upgrade signature to ops/MAINNET-DEPLOY-RUNBOOK.md."
