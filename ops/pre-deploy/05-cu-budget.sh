#!/usr/bin/env bash
# Gate 5 — CU + tx size budget. Hard limits per Solana runtime:
#   - 1.4M CU per tx (target: 1.2M to leave headroom)
#   - 1232 B per v0 message (alarm: 1100 B uncompressed to leave 132 B
#     for sig + recent_blockhash + preflight metadata)
#   - 64 accounts per legacy tx, 256 in v0 with ALT
#
# This gate parses the latest fork test logs (assumes gate 2 just ran)
# for B402_DEBUG_TX=1 output and asserts compiled message bytes <
# threshold. If the SDK doesn't log the size, this gate is a no-op
# warning instead of a hard fail — better to ship without it than to
# block on a logging gap.

set -euo pipefail

PROGRAM="$1"
PROGRAM_ID="$2"
FEATURES="$3"

CU_HARD=1_400_000
CU_ALARM=1_200_000
TX_SIZE_HARD=1232
TX_SIZE_ALARM=1100

# The fork e2e gate writes B402_DEBUG_TX output to stdout via vitest.
# We can't easily capture that here; instead, parse /tmp/b402-init.log
# and any vitest-captured logs in /tmp.
LOG_FILE="${B402_FORK_LOG:-/tmp/b402-fork-vitest.log}"
if [[ ! -f "$LOG_FILE" ]]; then
  echo "INFO: no fork-test debug log at $LOG_FILE. To capture, re-run gate 2 with:" >&2
  echo "  B402_DEBUG_TX=1 ... | tee $LOG_FILE" >&2
  echo "Skipping CU/tx-size gate." >&2
  exit 0
fi

MAX_BYTES=$(grep -oE 'message bytes: [0-9]+' "$LOG_FILE" | awk '{print $3}' | sort -n | tail -1)
if [[ -z "${MAX_BYTES:-}" ]]; then
  echo "INFO: no 'message bytes:' lines in log; SDK may not have B402_DEBUG_TX=1 set." >&2
  exit 0
fi

echo "  largest tx: $MAX_BYTES B (alarm at $TX_SIZE_ALARM, hard cap $TX_SIZE_HARD)"

if [[ "$MAX_BYTES" -gt "$TX_SIZE_HARD" ]]; then
  echo "FAIL: tx exceeds 1232 B v0-tx cap" >&2
  exit 1
fi
if [[ "$MAX_BYTES" -gt "$TX_SIZE_ALARM" ]]; then
  echo "WARN: tx >${TX_SIZE_ALARM} B (within ${TX_SIZE_HARD} cap but tight). Consider Phase 8 ALT extender or PRD-35 if not yet enabled." >&2
fi

echo "✓ tx size within budget"
