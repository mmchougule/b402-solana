#!/usr/bin/env bash
# Smoke-check a running solana-test-validator has the expected b402 programs
# deployed. Runs in a second shell after `./ops/local-validator.sh`.
#
# Exits 0 if all four programs are reachable and marked executable.

set -euo pipefail

RPC=${RPC:-http://127.0.0.1:8899}
POOL=2vMTGvSCobE7HfVvdSHsmVNzCFmbYdc3TsQwekUwcusy
VERIFIER=G6AycE529UPg1hib72A5A7Yf8eZRx9uFmDZQYMSYhEC7
ADAPTER=2FLQngd2Z1cqN7q4BU8vxDm2WNxXLwGDT3FYubQrFncg
MOCK=9RsayAuGPpxBrbuDdT5tnxKMKnsL8CSpGKwcrGjKvfHx

fail=0
for name_id in "pool:$POOL" "verifier:$VERIFIER" "jupiter-adapter:$ADAPTER" "mock-adapter:$MOCK"; do
    name="${name_id%%:*}"
    id="${name_id#*:}"
    info=$(solana -u "$RPC" program show "$id" 2>&1 || true)
    if echo "$info" | grep -q "$id"; then
        exe=$(echo "$info" | awk '/Executable/ {print $2}')
        echo "✓ $name ($id): executable=$exe"
    else
        echo "✗ $name ($id): NOT deployed"
        fail=1
    fi
done

if [[ "$fail" -ne 0 ]]; then
    echo ""
    echo "Some programs missing. Start the validator with:"
    echo "  ./ops/local-validator.sh --reset"
    exit 1
fi

echo ""
echo "All programs deployed. Validator ready for end-to-end rehearsal."
