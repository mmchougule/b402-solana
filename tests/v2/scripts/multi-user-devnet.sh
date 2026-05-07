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

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
HELIUS="${HELIUS:-https://devnet.helius-rpc.com/?api-key=4b0d45e2-1a54-4083-a1f0-da7fe1e1886e}"

USERS=("$@")
if [ ${#USERS[@]} -eq 0 ]; then
  USERS=(bob carol dave eve frank)
fi

cd "$ROOT"

echo "── multi-user devnet run: ${USERS[*]} ──"
for U in "${USERS[@]}"; do
  echo
  echo "▶ ${U}"
  USER_NAME="$U" RPC="$HELIUS" PHOTON_RPC="$HELIUS" \
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
