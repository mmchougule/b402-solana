# @b402ai/solana-shared

Shared protocol constants, types and encoding helpers for the b402 Solana shielded-pool SDK.

Used by `@b402ai/solana` and `@b402ai/solana-prover`. Most consumers don't depend on this directly — install `@b402ai/solana` instead.

## What's in here

- `FR_MODULUS` — BN254 scalar field modulus
- `DomainTags` — domain separators for Poseidon hashes
- `PROGRAM_IDS` — deployed b402 program IDs (devnet currently; mainnet on launch)
- `PDA_SEEDS` — canonical seed prefixes
- `TRANSACT_PUBLIC_INPUT_ORDER` — source-of-truth public input enumeration for the transact circuit
- `SpendableNote`, `Note`, `Intent`, `TransactPublicInputs` — types
- `leToFrReduced`, `frToLe`, `frFromLe` — Fr-element encoding

## License

Apache-2.0. See [LICENSE](https://github.com/mmchougule/b402-solana/blob/main/LICENSE).
