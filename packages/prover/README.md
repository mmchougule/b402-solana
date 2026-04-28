# @b402ai/solana-prover

Groth16 proof generation for the b402 Solana shielded pool — `transact` and `adapt` circuits.

Used internally by `@b402ai/solana`. Most consumers don't depend on this directly.

## What's in here

- `TransactProver` — generates proofs for shield/unshield/transfer flows
- `AdaptProver` — generates proofs for `adapt_execute` (private swap / lend)
- `WitnessBuilder` — compiles witness inputs from spendable notes + actions
- `Groth16Proof` type re-export

## Circuit artifacts

The prover loads `wasm` + `zkey` files at runtime. Pass them via `proverArtifacts`:

```ts
new TransactProver({
  wasmPath: '/abs/path/to/transact.wasm',
  zkeyPath: '/abs/path/to/transact_final.zkey',
});
```

Throwaway-devnet artifacts ship with the b402-solana repo under `circuits/build/`. Mainnet ceremony output is the production zkey — see [PRD-08](https://github.com/mmchougule/b402-solana/blob/main/docs/prds/PRD-08-ceremony.md).

## License

Apache-2.0. See [LICENSE](https://github.com/mmchougule/b402-solana/blob/main/LICENSE).
