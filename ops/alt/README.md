# b402 Address Lookup Table

Compresses stable, high-frequency accounts from 32 B to 1 B in every
`adapt_execute` tx. Without it, Jupiter routes overflow Solana's 1,232 B
tx-size cap. See PRD-04 §5.2.

## Current deployments

| Cluster | ALT address |
|---|---|
| devnet  | `9FPYufa1KDkrn1VgfjkR7R667hbnTA7CNtmy38QcsuNj` |
| mainnet | (not yet deployed) |

## What's in the ALT

Mint-agnostic seed set (16 accounts as of 2026-04-25):

- **Programs (9):** Jupiter V6, b402_pool, b402_verifier_transact,
  b402_verifier_adapt, b402_jupiter_adapter, b402_mock_adapter,
  Token, ATA, System.
- **b402 PDAs (3):** PoolConfig, TreeState, Jupiter adapter authority.
- **Common mints (2):** wSOL, USDC (mainnet addr — harmless dead weight
  on devnet, zero cost).
- **Adapter scratch ATAs (2):** `getAssociatedTokenAddress(mint, adapter_authority)`
  for wSOL and USDC.

Per-mint accounts (`Vault`, `TokenConfig`, adapter scratch ATA) are added
on demand via `add-mint` once a new mint is whitelisted.

## Commands

Run from `examples/` so workspace deps resolve:

```
pnpm --filter=@b402ai/solana-examples alt create --cluster devnet
pnpm --filter=@b402ai/solana-examples alt add-mint    --alt <ALT> --mint <MINT> [--adapter <ADAPTER>] --cluster devnet
pnpm --filter=@b402ai/solana-examples alt add-adapter --alt <ALT> --adapter <ADAPTER> [--mints <M1,M2>] --cluster devnet
pnpm --filter=@b402ai/solana-examples alt show       --alt <ALT> --cluster devnet
```

**Extending to new protocols.** The pool + verifier + adapter ABI are
action-agnostic — private swap, lend, perp, LP all use the same
`adapt_execute` path. To add Kamino/Drift/Orca:

1. Build + deploy the new adapter program (implements the common
   `execute(in_amount, min_out_amount, action_payload)` ABI).
2. Register it in `AdapterRegistry` with its allowed ix discriminators.
3. `alt add-adapter --adapter <NEW_ADAPTER> --mints <wSOL,USDC,...>` —
   seeds the new adapter's program + authority PDA + scratch ATAs into
   the same ALT. No pool redeploy, no circuit change.

Env overrides:

- `RPC_URL` — takes precedence over `--cluster`
- `ADMIN_KEYPAIR` — path to signer keypair (default `~/.config/solana/id.json`)

## Rotation

ALTs are authority-owned. To rotate:

1. `create` a new ALT (new pubkey).
2. Update `B402_ALT_DEVNET` in `packages/shared/src/constants.ts`.
3. Redeploy SDK consumers.
4. Optionally `deactivateLookupTable` on the old ALT after ~8 epochs so
   rent can be reclaimed. Old txs that referenced it still validate as
   long as it's still active.

Never revoke while in-flight txs could still arrive.

## Cost

- Create: ~0.0015 SOL rent-exempt for the table account.
- Extend: one signature + ~0 extra rent (table grows in place up to 256 entries).
- Total seed run ≈ 2 txs, ~0.002 SOL.
