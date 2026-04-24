#!/usr/bin/env bash
# Spin up a local solana-test-validator with all b402 programs pre-deployed.
#
# Usage:
#   ./ops/local-validator.sh          # starts validator in foreground
#   ./ops/local-validator.sh --reset  # wipe ledger before starting
#
# After it's running, in another shell:
#   solana -u localhost balance                          # sanity check
#   solana -u localhost program show <program_id>        # confirm deploy

set -euo pipefail

cd "$(dirname "$0")/.."

RESET=""
if [[ "${1:-}" == "--reset" ]]; then
    RESET="--reset"
    echo "→ ledger will be wiped"
fi

# Ensure .so files are built.
for so in b402_verifier_transact b402_pool b402_jupiter_adapter b402_mock_adapter; do
    if [[ ! -f "target/deploy/${so}.so" ]]; then
        echo "✗ missing target/deploy/${so}.so"
        echo "  run: cargo build-sbf --tools-version v1.54 --manifest-path programs/${so//_/-}/Cargo.toml"
        exit 1
    fi
done

# Program IDs — must match `declare_id!` in each program source.
POOL_ID=2vMTGvSCobE7HfVvdSHsmVNzCFmbYdc3TsQwekUwcusy
VERIFIER_ID=G6AycE529UPg1hib72A5A7Yf8eZRx9uFmDZQYMSYhEC7
ADAPTER_ID=2FLQngd2Z1cqN7q4BU8vxDm2WNxXLwGDT3FYubQrFncg
MOCK_ADAPTER_ID=9RsayAuGPpxBrbuDdT5tnxKMKnsL8CSpGKwcrGjKvfHx

echo "→ starting solana-test-validator"
echo "  pool     = $POOL_ID"
echo "  verifier = $VERIFIER_ID"
echo "  jupiter  = $ADAPTER_ID"
echo "  mock     = $MOCK_ADAPTER_ID"
echo ""

exec solana-test-validator \
    $RESET \
    --bpf-program "$VERIFIER_ID" target/deploy/b402_verifier_transact.so \
    --bpf-program "$POOL_ID" target/deploy/b402_pool.so \
    --bpf-program "$ADAPTER_ID" target/deploy/b402_jupiter_adapter.so \
    --bpf-program "$MOCK_ADAPTER_ID" target/deploy/b402_mock_adapter.so \
    --log
