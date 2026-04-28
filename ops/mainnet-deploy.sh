#!/bin/bash
# Mainnet alpha deploy. Deploys the 5 programs needed for the full alpha
# (shield/unshield via pool + verifiers; private_swap via Jupiter adapter;
# private_lend via Kamino adapter).
#
# Pre-conditions:
#   - solana CLI configured to mainnet ($ solana config set --url mainnet-beta)
#   - admin wallet at ~/.config/solana/id.json with sufficient SOL (see dry run)
#   - program keypairs at ops/keypairs/ (gitignored — never commit these)
#   - all .so files built: ./scripts/build-all.sh
#
# Usage:
#   ./ops/mainnet-deploy.sh                                      # dry run, all 5
#   ./ops/mainnet-deploy.sh --execute                            # deploy all 5
#   ./ops/mainnet-deploy.sh --only b402_pool,b402_verifier_transact,b402_verifier_adapt
#                                                                # dry run subset
#   ./ops/mainnet-deploy.sh --only ... --execute                 # deploy subset
#
# Each `solana program deploy` is rent-paid upfront; close-program returns
# ~95% of rent if you decommission. Tight --max-len keeps cost bounded.

set -euo pipefail
cd "$(dirname "$0")/.."

EXECUTE=""
ONLY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --execute) EXECUTE="--execute" ;;
    --only)    ONLY="$2"; shift ;;
    *)         echo "unknown flag: $1"; exit 1 ;;
  esac
  shift
done

# Programs we deploy in alpha. Order matters — pool depends on the verifier
# IDs being knowable at init time, so we deploy verifiers first.
ALL_PROGRAMS=(
  "b402_verifier_transact:Afjbnv2Ekxa98jjRw33xPPhZabevek2uZxoE75kr6ZrK"
  "b402_verifier_adapt:3Y2tyhNSaUiW5AcZcmFGRyTMdnroxHxc5GqFQPcMTZae"
  "b402_jupiter_adapter:3RHRcbinCmcj8JPBfVxb9FW76oh4r8y21aSx4JFy3yx7"
  "b402_kamino_adapter:2enwFgcGKJDqruHpCtvmhtxe3DYcV3k72VTvoGcdt2rX"
  "b402_pool:42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y"
)

# Apply --only filter while preserving order from ALL_PROGRAMS.
if [[ -n "$ONLY" ]]; then
  PROGRAMS=()
  IFS=',' read -ra WANT <<< "$ONLY"
  for entry in "${ALL_PROGRAMS[@]}"; do
    name="${entry%:*}"
    for w in "${WANT[@]}"; do
      if [[ "$name" == "$w" ]]; then
        PROGRAMS+=("$entry")
        break
      fi
    done
  done
  if [[ ${#PROGRAMS[@]} -ne ${#WANT[@]} ]]; then
    echo "✗ --only contains unknown program names. Known:"
    for entry in "${ALL_PROGRAMS[@]}"; do echo "    ${entry%:*}"; done
    exit 1
  fi
  echo "== deploying subset (${#PROGRAMS[@]} of ${#ALL_PROGRAMS[@]} programs) =="
else
  PROGRAMS=("${ALL_PROGRAMS[@]}")
fi

# Tight max-len overhead: 5 KB headroom on top of binary size lets us upgrade
# without needing to extend-program in the common case.
MAX_LEN_HEADROOM=5120

echo "== mainnet alpha deploy plan =="
echo ""
TOTAL_LAMPORTS=0
for entry in "${PROGRAMS[@]}"; do
  name="${entry%:*}"
  pid="${entry#*:}"
  so="target/deploy/${name}.so"

  if [[ ! -f "$so" ]]; then
    echo "✗ missing $so. build first: cargo build-sbf --tools-version v1.54 --manifest-path programs/${name//_/-}/Cargo.toml"
    exit 1
  fi
  size=$(wc -c < "$so")
  max_len=$(( size + MAX_LEN_HEADROOM ))
  # Solana rent-exempt: roughly 6960 lamports per byte for upgradeable programdata
  # (45-byte programdata header + max_len * 1 byte). Approximation good to ±5%.
  programdata_size=$(( 45 + max_len ))
  rent_lamports=$(( programdata_size * 6960 ))
  TOTAL_LAMPORTS=$(( TOTAL_LAMPORTS + rent_lamports ))

  printf "  %-25s id %s  size %6d B  max-len %6d B  rent %6.3f SOL\n" \
    "$name" "${pid:0:12}…" "$size" "$max_len" \
    "$(echo "scale=3; $rent_lamports / 1000000000" | bc)"
done
echo ""
echo "== total estimated rent: $(echo "scale=3; $TOTAL_LAMPORTS / 1000000000" | bc) SOL (recoverable via 'solana program close') =="
echo ""

if [[ -z "$EXECUTE" ]]; then
  echo "(dry run — pass --execute to actually deploy)"
  echo ""
  echo "next steps after deploy:"
  echo "  1. ./ops/mainnet-init.sh   — init pool, add token configs, register adapter"
  echo "  2. cd examples && pnpm tsx mainnet-private-swap.ts   — run a real \$1 USDC private swap"
  exit 0
fi

# Real deploy.
BAL=$(solana balance --output json | jq -r '.lamports // (.value | sub("[^0-9.]"; "") | tonumber * 1000000000)' 2>/dev/null || solana balance | awk '{print $1*1000000000}')
echo "wallet balance: $(echo "scale=3; $BAL / 1000000000" | bc) SOL"
if (( BAL < TOTAL_LAMPORTS + 100000000 )); then
  echo "✗ insufficient balance — need ~$(echo "scale=3; ($TOTAL_LAMPORTS + 100000000) / 1000000000" | bc) SOL"
  exit 1
fi

for entry in "${PROGRAMS[@]}"; do
  name="${entry%:*}"
  pid="${entry#*:}"
  so="target/deploy/${name}.so"
  size=$(wc -c < "$so")
  max_len=$(( size + MAX_LEN_HEADROOM ))
  keypair="ops/keypairs/${name}-keypair.json"

  if [[ ! -f "$keypair" ]]; then
    echo "✗ missing $keypair — program ID $pid won't match"
    exit 1
  fi
  derived_id=$(solana-keygen pubkey "$keypair")
  if [[ "$derived_id" != "$pid" ]]; then
    echo "✗ keypair $keypair derives $derived_id, not $pid"
    exit 1
  fi

  echo ""
  echo "== deploying $name → $pid =="
  if solana program show "$pid" >/dev/null 2>&1; then
    echo "  $pid already exists; running upgrade..."
    solana program deploy --program-id "$keypair" "$so"
  else
    echo "  fresh deploy with --max-len $max_len..."
    solana program deploy --program-id "$keypair" --max-len "$max_len" "$so"
  fi
done

echo ""
echo "== deploys complete =="
solana balance
echo ""
echo "next: ./ops/mainnet-init.sh"
