#!/usr/bin/env bash
# Phase 9 trusted setup ceremony for the ADAPT circuit (dual-note minting).
#
# What this script does (in order):
#   1. Recompiles adapt.circom with the current Phase 9 source (adds outSpendingPubA
#      to the public inputs).
#   2. Verifies the recompiled R1CS has the expected 24 public inputs.
#   3. Reuses the existing Phase 1 Powers of Tau (universal, written once).
#   4. Runs Phase 2 (circuit-specific): groth16 setup → zkey contribute → export VK.
#   5. Converts the new VK to Rust and writes programs/b402-verifier-adapt/src/vk.rs.
#   6. Sanity check: nr_pubinputs in vk.rs equals 24, VK_IC array length equals 25.
#   7. Generates a test proof against the new artifacts and verifies it locally.
#
# What this script does NOT do (you do these by hand after reviewing):
#   - Build the .so files (run `cargo build-sbf --features phase_9_dual_note` after).
#   - Deploy to mainnet (run `solana program write-buffer` + `upgrade` after).
#   - Publish npm packages (do that after smoke testing on mainnet).
#
# Usage:
#   bash circuits/scripts/phase9-ceremony.sh
#
# Wall time: ~15-25 minutes depending on machine. The slowest step is
# `snarkjs zkey contribute` which is single-threaded CPU bound.

set -euo pipefail

# ── locate repo root regardless of where this is invoked from ──────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT/circuits"

# ── colors for the human ──────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; NC='\033[0m'
say()  { echo -e "${GREEN}→${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC}  $*"; }
die()  { echo -e "${RED}✗${NC} $*"; exit 1; }

# ── pre-flight ────────────────────────────────────────────────────────────
say "Phase 9 ADAPT ceremony — re-runs Phase 2 with the new R1CS shape"
echo "    Phase 1 (Powers of Tau) is reused from disk — written once, valid forever"
echo

command -v circom   >/dev/null || die "circom not in PATH (install: cargo install --git https://github.com/iden3/circom)"
command -v pnpm     >/dev/null || die "pnpm not in PATH"
command -v sha256sum >/dev/null || die "sha256sum not in PATH (mac: brew install coreutils OR replace with shasum -a 256)"

# ── archive previous artifacts before overwriting ─────────────────────────
TS=$(date +%Y%m%d-%H%M%S)
ARCHIVE="build/ceremony/archive-$TS"
mkdir -p "$ARCHIVE"
for f in adapt_final.zkey adapt_verification_key.json adapt_0000.zkey; do
  if [ -f "build/ceremony/$f" ]; then
    cp "build/ceremony/$f" "$ARCHIVE/$f"
  fi
done
say "archived previous artifacts → $ARCHIVE/"

# ── 1. recompile adapt.circom ─────────────────────────────────────────────
say "compiling adapt.circom (Phase 9 source: 24 public inputs)"
mkdir -p build
circom adapt.circom --r1cs --wasm --sym -o build/ -l node_modules

# ── 2. verify public-input count ──────────────────────────────────────────
PUBINPUTS=$(pnpm exec snarkjs r1cs info build/adapt.r1cs 2>&1 | grep "# of Public Inputs" | awk '{print $NF}')
if [ "$PUBINPUTS" != "24" ]; then
  die "expected 24 public inputs, got $PUBINPUTS — check adapt.circom main { public[...] } block"
fi
say "R1CS public input count = 24 ✓"

CONSTRAINTS=$(pnpm exec snarkjs r1cs info build/adapt.r1cs 2>&1 | grep "# of Constraints" | awk '{print $NF}')
say "R1CS constraints = $CONSTRAINTS (must fit in 2^17 = 131072)"
if [ "$CONSTRAINTS" -gt 131072 ]; then
  die "constraints exceed 2^17 — need a larger PoT (2^18 or higher)"
fi

# ── 3. reuse Phase 1 ──────────────────────────────────────────────────────
PTAU=build/ceremony/powersOfTau28_hez_final_17.ptau
if [ ! -f "$PTAU" ]; then
  say "downloading Phase 1 PoT (2^17, ~70 MB) — only happens once"
  mkdir -p build/ceremony
  curl -L -o "$PTAU" \
    "https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_17.ptau"
fi
PTAU_HASH=$(sha256sum "$PTAU" | awk '{print $1}')
say "Phase 1 PoT sha256 = $PTAU_HASH"

# ── 4. Phase 2 ────────────────────────────────────────────────────────────
ZKEY0=build/ceremony/adapt_0000.zkey
ZKEY1=build/ceremony/adapt_final.zkey

say "Phase 2 init (groth16 setup) — ~2-5 min"
pnpm exec snarkjs groth16 setup build/adapt.r1cs "$PTAU" "$ZKEY0"

# Audit-friendly: caller may pass entropy via PHASE9_CEREMONY_ENTROPY env var.
# If unset, fall back to /dev/urandom but loudly warn — anyone planning to
# use this ceremony for a real audit should pass an explicit value derived
# from a multi-party random beacon (drand, hash of recent BTC block, etc.)
ENTROPY="${PHASE9_CEREMONY_ENTROPY:-}"
if [ -z "$ENTROPY" ]; then
  warn "PHASE9_CEREMONY_ENTROPY not set — using /dev/urandom (fine for a"
  warn "single-contributor ceremony, but for a real audit you want multi-party"
  warn "entropy. See PRD-08 §2 for the protocol.)"
  ENTROPY=$(head -c 32 /dev/urandom | xxd -p | tr -d '\n')
fi

say "Phase 2 contribute (zkey contribute) — ~5-15 min CPU bound"
pnpm exec snarkjs zkey contribute "$ZKEY0" "$ZKEY1" \
  --name="b402-phase-9-dual-note-$TS" \
  -e="$ENTROPY"

say "exporting verification key"
VK_JSON=build/ceremony/adapt_verification_key.json
pnpm exec snarkjs zkey export verificationkey "$ZKEY1" "$VK_JSON"

VK_HASH=$(sha256sum "$VK_JSON" | awk '{print $1}')
say "VK sha256 = $VK_HASH (record this in the deploy commit)"

# ── 5. convert to Rust ────────────────────────────────────────────────────
# vk-to-rust now requires explicit --in/--out/--const flags to prevent the
# silent-clobber bug where omitted args defaulted to the transact paths and
# overwrote programs/b402-verifier-transact/src/vk.rs with the new adapt VK.
RS_OUT="$REPO_ROOT/programs/b402-verifier-adapt/src/vk.rs"
say "converting VK → Rust ($RS_OUT)"
node "$REPO_ROOT/circuits/scripts/vk-to-rust.mjs" \
  --in "$VK_JSON" \
  --out "$RS_OUT" \
  --const ADAPT_VK

# ── 6. sanity-check vk.rs ─────────────────────────────────────────────────
NR_PUBINPUTS_LINE=$(grep "nr_pubinputs:" "$RS_OUT" | head -1)
VK_IC_LINE=$(grep "VK_IC: \[\[u8; 64\];" "$RS_OUT" | head -1)
say "vk.rs: $NR_PUBINPUTS_LINE"
say "vk.rs: $VK_IC_LINE"

if ! grep -q "nr_pubinputs: 24," "$RS_OUT"; then
  die "vk.rs nr_pubinputs is not 24 — vk-to-rust.mjs output unexpected"
fi
if ! grep -q "VK_IC: \[\[u8; 64\]; 25\]" "$RS_OUT"; then
  die "vk.rs VK_IC length is not 25 (= 24 public inputs + 1) — bad VK"
fi
say "vk.rs sanity: nr_pubinputs=24, VK_IC[25] ✓"

# ── 7. test-proof round-trip ──────────────────────────────────────────────
say "generating test proof against new artifacts"
node "$REPO_ROOT/circuits/scripts/gen-test-proof-adapt.mjs" \
  || warn "test proof generation failed — inspect gen-test-proof-adapt.mjs and re-run manually"

# ── done ──────────────────────────────────────────────────────────────────
echo
echo "════════════════════════════════════════════════════════════════"
echo " Phase 9 ceremony complete."
echo "════════════════════════════════════════════════════════════════"
echo
echo " Artifacts:"
echo "   $ZKEY1"
echo "   $VK_JSON"
echo "   $RS_OUT"
echo
echo " Recorded entropy commitment (for audit log):"
echo "   PoT sha256:    $PTAU_HASH"
echo "   VK  sha256:    $VK_HASH"
echo "   contribute ts: $TS"
echo
echo " Next steps (do these by hand, in order):"
echo
echo "   1. Inspect the diff in vk.rs:"
echo "      git diff programs/b402-verifier-adapt/src/vk.rs"
echo
echo "   2. Build with the Phase 9 feature on:"
echo "      cd programs/b402-verifier-adapt && cargo build-sbf --features phase_9_dual_note"
echo "      cd programs/b402-pool && cargo build-sbf --features inline_cpi_nullifier,phase_9_dual_note"
echo
echo "   3. Vector parity (pinning EXPECTED_COMMITMENT_B_HEX):"
echo "      pnpm --filter @b402ai/solana-v2-tests test tests/v2/integration/dual_note_vector.test.ts"
echo "      # First run prints the actual hex; pin it in BOTH:"
echo "      #   tests/v2/integration/dual_note_vector.test.ts"
echo "      #   programs/b402-pool/tests/excess_commitment_parity.rs"
echo "      # Then flip .skip → it and re-run."
echo
echo "   4. Deploy verifier first, then pool (NEVER pool first — would brick mid-deploy):"
echo "      solana program write-buffer target/deploy/b402_verifier_adapt.so"
echo "      solana program upgrade <buffer> 3Y2tyhNSaUiW5AcZcmFGRyTMdnroxHxc5GqFQPcMTZae"
echo "      solana program write-buffer target/deploy/b402_pool.so"
echo "      solana program upgrade <buffer> 42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y"
echo
echo "   5. Smoke on mainnet (USDC → wSOL via Jupiter):"
echo "      Run the demo flow; verify result.excessNote is set when slippage > 0."
echo
echo "   6. Republish:"
echo "      pnpm -F @b402ai/solana publish    # bumps to 0.0.12"
echo "      pnpm -F @b402ai/solana-mcp publish # bumps to 0.0.18"
echo
echo "   7. Tag:"
echo "      git tag v0.0.8-mainnet-phase9 && git push origin v0.0.8-mainnet-phase9"
echo
