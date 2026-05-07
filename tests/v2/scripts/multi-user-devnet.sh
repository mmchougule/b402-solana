#!/usr/bin/env bash
# Run T4+T5 once per user against devnet, with backoff between users.
# Lands one privatePerpOpen tx per user; persists each tx hash into
# /tmp/percolator-market.json under the user's name.
#
# Usage:
#   HELIUS=https://devnet.helius-rpc.com/?api-key=... \
#     tests/v2/scripts/multi-user-devnet.sh bob carol dave
#
#   HELIUS=... tests/v2/scripts/multi-user-devnet.sh   # default 5-user list
#   HELIUS_API_KEY=... tests/v2/scripts/multi-user-devnet.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
if [[ -n "${HELIUS:-}" ]]; then
  RPC_URL="$HELIUS"
elif [[ -n "${HELIUS_API_KEY:-}" ]]; then
  RPC_URL="https://devnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}"
else
  RPC_URL="https://api.devnet.solana.com"
fi

USERS=("$@")
if [ ${#USERS[@]} -eq 0 ]; then
  USERS=(bob carol dave eve frank)
fi

cd "$ROOT"

echo "── multi-user devnet run: ${USERS[*]} ──"
for U in "${USERS[@]}"; do
  echo
  echo "▶ ${U}"
  USER_NAME="$U" RPC="$RPC_URL" PHOTON_RPC="$RPC_URL" \
    pnpm exec vitest run tests/v2/e2e/v2_fork_percolator.test.ts -t "T4|T5" 2>&1 \
    | tail -20 || {
      echo "  ${U}: FAILED — continuing to next user"
      sleep 30
      continue
    }
  echo "  ${U}: done"
  # Backoff: let the engine clock breathe + give Helius a break.
  sleep 15
done

echo
echo "── results ──"
cat /tmp/percolator-market.json
