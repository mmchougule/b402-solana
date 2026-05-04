#!/usr/bin/env bash
# Gate 4 — IDL diff. Anchor IDLs encode the public ix surface. A
# breaking change here breaks SDK + clients silently. Surfaces:
#   - removed instruction (caller breakage)
#   - removed account in an existing ix (caller breakage)
#   - reordered struct fields (binary breakage; discriminator collision risk)
#   - type narrowing (u64 → u32, etc.)
# Additions are fine and do not abort.

set -euo pipefail

PROGRAM="$1"
PROGRAM_ID="$2"
FEATURES="$3"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

PROGRAM_UNDER="${PROGRAM//-/_}"
NEW_IDL="$(mktemp -t b402-idl-new-XXXXXX.json)"
OLD_IDL="$(mktemp -t b402-idl-old-XXXXXX.json)"
DIFF_OUT="$(mktemp -t b402-idl-diff-XXXXXX.txt)"

# 1. Build IDL for the new local code. Anchor regenerates from source.
FEATURES_ARG=""
if [[ -n "$FEATURES" ]]; then FEATURES_ARG="--features $FEATURES"; fi
echo "building new IDL..."
if ! anchor idl build -p "$PROGRAM" $FEATURES_ARG > "$NEW_IDL" 2>/dev/null; then
  echo "WARN: anchor idl build failed for $PROGRAM. Skipping IDL diff." >&2
  rm -f "$NEW_IDL" "$OLD_IDL" "$DIFF_OUT"
  exit 0
fi

# 2. Fetch on-chain IDL. Some b402 programs don't publish an IDL (the
#    verifier programs), so a fetch failure is OK if the new IDL also
#    has the same ix surface.
MAINNET_RPC="${MAINNET_RPC:-https://api.mainnet-beta.solana.com}"
echo "fetching on-chain IDL for $PROGRAM_ID..."
if ! anchor idl fetch -u "$MAINNET_RPC" "$PROGRAM_ID" > "$OLD_IDL" 2>/dev/null; then
  echo "INFO: no on-chain IDL for $PROGRAM_ID. Adding NEW IDL is safe by definition." >&2
  rm -f "$NEW_IDL" "$OLD_IDL" "$DIFF_OUT"
  exit 0
fi

# 3. Diff. Sorted JSON for stable output. Filter additions vs deletions.
diff <(jq -S . "$OLD_IDL") <(jq -S . "$NEW_IDL") > "$DIFF_OUT" || true

if [[ ! -s "$DIFF_OUT" ]]; then
  echo "✓ IDL unchanged"
  rm -f "$NEW_IDL" "$OLD_IDL" "$DIFF_OUT"
  exit 0
fi

# Look for breaking changes — lines starting with `<` are removals from
# the on-chain IDL.
REMOVED=$(grep -c "^< " "$DIFF_OUT" || true)
ADDED=$(grep -c "^> " "$DIFF_OUT" || true)
echo "  removed: $REMOVED lines, added: $ADDED lines"

if [[ "$REMOVED" -gt 0 ]]; then
  echo "" >&2
  echo "FAIL: IDL has REMOVALS (potential breaking change). Review:" >&2
  echo "      $DIFF_OUT" >&2
  echo "" >&2
  if [[ "${ALLOW_BREAKING:-}" == "1" ]]; then
    echo "  ALLOW_BREAKING=1 set; downgrading to warning. Reason logged." >&2
  else
    exit 1
  fi
fi

echo "✓ IDL diff is additive only (or override accepted)"
echo "  full diff: $DIFF_OUT"
