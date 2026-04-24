# b402-solana

Private DeFi on Solana — shielded pool + Kamino/Drift/Jupiter/Orca composability, gasless, 0% fee, permissionless. Solana counterpart to the b402 Railgun fork on Base/Arb/BSC.

## Working style for this repo

- **PRD-driven.** Read `docs/prds/` in numeric order. Each PRD gates the next; do not skip ahead.
- **No code until PRD-03 is signed off.** PRD-01 is architecture, PRD-02 is crypto spec, PRD-03 is program spec. Circuits and programs only begin after design lock.
- **No hacks, no shortcuts.** This is security-critical code. Every decision gets justification in the relevant PRD.
- **TDD for every circuit template.** Unit + property + Rust parity + negative tests before integration.

## Locked decisions (from PRD-01)

- Circuits: **Circom 2.x**
- Verifier: **Lightprotocol/groth16-solana**
- Program: **Anchor 0.30+**
- Hash: **Poseidon (BN254)**
- Model: **Railgun-style UTXO notes** + incremental Merkle tree + viewing keys
- Fee: **0% protocol fee** (immutable)
- Compliance: **Permissionless**, optional opt-in disclosure
- Gasless: sponsor signer + Jito bundles

## SDK API parity goal

The Solana adapter must expose the same method surface as `@b402ai/sdk`:
`shield`, `unshield`, `privateSwap`, `privateLend`, `privateRedeem`, `status`, `rebalance`,
plus Solana-native additions once mainnet lands (`privatePerpOpen`/`privatePerpClose` for Drift,
`privateLP` for Orca).

## Toolchain

- Node 20+, pnpm workspace
- Rust stable (latest), Anchor 0.30+
- Circom 2.2+, snarkjs, circom_tester
- Solana CLI 2.0+

## Environment

- RPC: use Helius or Triton for mainnet. Never free public RPC — matches b402 EVM rule.
- Devnet for rehearsal, mainnet for prod.
