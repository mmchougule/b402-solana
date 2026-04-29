#!/usr/bin/env bash
# Boot a mainnet-fork harness for v2 testing.
#
# What this loads:
#   - Light Protocol programs (bundled with the Light CLI; fresh trees,
#     no mainnet compressed-account state needed for our tests).
#   - Our 4 core programs at their declare_id! addresses, loaded from
#     target/deploy/*.so. These are NOT on mainnet yet, so we deploy
#     them locally at the canonical IDs the SDK + tests already use.
#   - Jupiter v6 program cloned from mainnet (for swap tests)
#   - Kamino lending program cloned from mainnet (for lend tests)
#   - USDC mainnet mint cloned (for swap input/output token)
#
# Photon indexer + Light prover are launched alongside by `light test-validator`.
#
# Note: --mainnet flag would try to clone Light's existing compressed-account
# state via getProgramAccounts, which the public mainnet RPC rejects. Our
# tests don't need that state — they create fresh nullifiers/notes — so we
# use the default (local Light infra + fresh trees) and clone only the
# external programs we need via --validator-args.
#
# Usage:
#   tests/v2/scripts/start-mainnet-fork.sh
#
# Stop:
#   light test-validator --stop

set -euo pipefail

# Repo root resolves regardless of cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# --- Our programs (declare_id! values, must match SDK constants) ---
POOL_ID="42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y"
NULLIFIER_ID="2AnRZwWu6CTurZs1yQpqrcJWo4yRYL1xpeV78b2siweq"
VERIFIER_TRANSACT_ID="Afjbnv2Ekxa98jjRw33xPPhZabevek2uZxoE75kr6ZrK"
VERIFIER_ADAPT_ID="3Y2tyhNSaUiW5AcZcmFGRyTMdnroxHxc5GqFQPcMTZae"
MOCK_ADAPTER_ID="89kw33YDcbXfiayVNauz599LaDm51EuU8amWydpjYKgp"
JUPITER_ADAPTER_ID="3RHRcbinCmcj8JPBfVxb9FW76oh4r8y21aSx4JFy3yx7"
KAMINO_ADAPTER_ID="2enwFgcGKJDqruHpCtvmhtxe3DYcV3k72VTvoGcdt2rX"

# --- External programs to clone from mainnet ---
# Jupiter V6 (swap aggregator)
JUPITER_V6="JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
# Kamino Lending program
KAMINO_LEND="KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"
# Mainnet USDC mint (used as the swap input/output token + test mint)
USDC_MINT="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

# Sanity: all .so files we need.
POOL_SO="$ROOT/target/deploy/b402_pool.so"
NULLIFIER_SO="$ROOT/programs/b402-nullifier/target/deploy/b402_nullifier.so"
VERIFIER_TRANSACT_SO="$ROOT/target/deploy/b402_verifier_transact.so"
VERIFIER_ADAPT_SO="$ROOT/target/deploy/b402_verifier_adapt.so"
MOCK_ADAPTER_SO="$ROOT/target/deploy/b402_mock_adapter.so"
JUPITER_ADAPTER_SO="$ROOT/target/deploy/b402_jupiter_adapter.so"
KAMINO_ADAPTER_SO="$ROOT/target/deploy/b402_kamino_adapter.so"

for f in "$POOL_SO" "$NULLIFIER_SO" "$VERIFIER_TRANSACT_SO" "$VERIFIER_ADAPT_SO" "$MOCK_ADAPTER_SO" "$JUPITER_ADAPTER_SO" "$KAMINO_ADAPTER_SO"; do
  if [[ ! -f "$f" ]]; then
    echo "FAIL: missing $f — run 'anchor build' (and rebuild b402-nullifier separately)." >&2
    exit 1
  fi
done

# Upgrade authority for our programs. Reuse the local CLI default keypair.
UPGRADE_AUTH="$HOME/.config/solana/id.json"
if [[ ! -f "$UPGRADE_AUTH" ]]; then
  echo "FAIL: $UPGRADE_AUTH missing — set up Solana CLI keypair first." >&2
  exit 1
fi

echo "==> stopping any previous test-validator"
light test-validator --stop || true

echo "==> starting mainnet-forked test-validator + Photon"
echo "    pool:               $POOL_ID"
echo "    nullifier:          $NULLIFIER_ID"
echo "    verifier_transact:  $VERIFIER_TRANSACT_ID"
echo "    verifier_adapt:     $VERIFIER_ADAPT_ID"
echo "    mock_adapter:       $MOCK_ADAPTER_ID"
echo "    jupiter_adapter:    $JUPITER_ADAPTER_ID"
echo "    kamino_adapter:     $KAMINO_ADAPTER_ID"
echo "    cloning jupiter v6: $JUPITER_V6"
echo "    cloning kamino:     $KAMINO_LEND"
echo "    cloning USDC:       $USDC_MINT"

# --validator-args is forwarded verbatim. --clone-upgradeable-program clones
# the program AND its program-data account (cheaper than two --clone calls).
# --url mainnet-beta tells the underlying solana-test-validator where to
# clone from (Light Labs's --mainnet flag handles Light's accounts already).
light test-validator \
  --upgradeable-program "$POOL_ID" "$POOL_SO" "$UPGRADE_AUTH" \
  --upgradeable-program "$NULLIFIER_ID" "$NULLIFIER_SO" "$UPGRADE_AUTH" \
  --upgradeable-program "$VERIFIER_TRANSACT_ID" "$VERIFIER_TRANSACT_SO" "$UPGRADE_AUTH" \
  --upgradeable-program "$VERIFIER_ADAPT_ID" "$VERIFIER_ADAPT_SO" "$UPGRADE_AUTH" \
  --upgradeable-program "$MOCK_ADAPTER_ID" "$MOCK_ADAPTER_SO" "$UPGRADE_AUTH" \
  --upgradeable-program "$JUPITER_ADAPTER_ID" "$JUPITER_ADAPTER_SO" "$UPGRADE_AUTH" \
  --upgradeable-program "$KAMINO_ADAPTER_ID" "$KAMINO_ADAPTER_SO" "$UPGRADE_AUTH" \
  --validator-args "--url mainnet-beta --clone-upgradeable-program $JUPITER_V6 --clone-upgradeable-program $KAMINO_LEND --clone $USDC_MINT"
