#!/usr/bin/env bash
# Copy throwaway-devnet circuit artifacts from the monorepo into the
# package directory at pack/publish time. Source-of-truth lives at
# circuits/build/; this script reproduces the layout @b402ai/solana-mcp
# expects (see packages/mcp-server/src/context.ts → bundledCircuitsRoot).
#
# Run automatically via `prepublishOnly`. Manual invocation:
#   bash packages/mcp-server/scripts/copy-circuits.sh
set -euo pipefail

cd "$(dirname "$0")/.."

REPO_CIRCUITS="../../circuits/build"
PKG_CIRCUITS="circuits"

if [ ! -d "$REPO_CIRCUITS" ]; then
  echo "ERROR: $REPO_CIRCUITS not found — run from inside the b402-solana monorepo" >&2
  exit 1
fi

rm -rf "$PKG_CIRCUITS"
mkdir -p "$PKG_CIRCUITS/transact_js" "$PKG_CIRCUITS/adapt_js" "$PKG_CIRCUITS/ceremony"

cp "$REPO_CIRCUITS/transact_js/transact.wasm"        "$PKG_CIRCUITS/transact_js/"
cp "$REPO_CIRCUITS/adapt_js/adapt.wasm"              "$PKG_CIRCUITS/adapt_js/"
cp "$REPO_CIRCUITS/ceremony/transact_final.zkey"     "$PKG_CIRCUITS/ceremony/"
cp "$REPO_CIRCUITS/ceremony/adapt_final.zkey"        "$PKG_CIRCUITS/ceremony/"

du -sh "$PKG_CIRCUITS"
