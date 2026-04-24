# Reproduce everything locally

Every flow in the README is reproducible. No build required to verify the
devnet claims.

## Confirm devnet transactions

```bash
solana -u devnet confirm -v 5XLaccuw6tv6AWowMDKLK24zTSxD4Ej2nuRwSnpbLWZSHU19SPb7n8mNpx8G4fHEHxBMRo5GiYPyPj6G4pmsLyZB
solana -u devnet confirm -v 38mKQXBPuwtYhM5JvbyJA2se9cehMvw1mUbevhERAkZdni7a6VTYdYNx66nZ5KqzbgUng1SsbCiQEJX2F3XG77PD
```

First is a shield tx. Second is unshield — runs merkle inclusion proof,
nullifier derivation, recipient-ATA binding, vault-signed transfer.

Both hit pool `42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y` and verifier
`Afjbnv2Ekxa98jjRw33xPPhZabevek2uZxoE75kr6ZrK`.

## Run the devnet e2e yourself

```bash
pnpm install
RPC_URL=https://api.devnet.solana.com pnpm --filter=@b402ai/solana-examples e2e
```

Uses your `~/.config/solana/id.json` wallet. Needs ~1 devnet SOL (tx fees only).
Creates a fresh test mint per run, so it's idempotent.

## Run the real-Jupiter flow on a mainnet fork

Fetch a live mainnet quote:

```bash
cd examples && pnpm tsx ../ops/jup-quote.ts \
  --in So11111111111111111111111111111111111111112 \
  --out EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
  --amount 100000000 \
  --caller CzTpaTvU4YDVFQQC2ct6smu4XMR96iE6rPHBJy5xuQAe \
  --out-file /tmp/jup-route.json
```

Boot a test-validator with Jupiter V6 + AMM programs cloned from mainnet:

```bash
./ops/mainnet-fork-validator.sh --route /tmp/jup-route.json --reset
```

Run shield → Jupiter V6 swap → unshield:

```bash
cd examples && pnpm swap-e2e-jupiter
```

Output includes the swap tx signature, actual wSOL → USDC delta, and
confirmation that the post-CPI balance-delta invariant held against a
real aggregator CPI.

## Scanner auto-discovery (Alice → Bob → Charlie)

```bash
./ops/local-validator.sh --reset
cd examples && pnpm scanner-e2e
```

Three independent keypairs. Bob's wallet subscribes to pool logs, runs
a viewing-tag Poseidon pre-filter on every event, ECDH-decrypts matches
with his X25519 viewing key, pushes discovered notes to his NoteStore.
Bob then unshields to Charlie with a real Groth16 proof.

## Run the test suites

```bash
# Rust crypto + verifier
cargo test -p b402-crypto
cargo test -p b402-verifier-transact

# Circuit parity + witness + prove-verify (snarkjs)
cd circuits && RUN_PARITY=1 RUN_CIRCUIT_TESTS=1 pnpm vitest run

# Prover → Rust verifier
cd packages/prover && RUN_PROVER=1 RUN_VERIFIER=1 pnpm vitest run

# On-chain litesvm (same .so bytecode that ships)
cd tests/onchain && cargo test

# SDK tx-size regression
pnpm --filter=@b402ai/solana test
```

71 tests, all green. Numbers match `reports/` in the assurance repo.
