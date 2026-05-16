# Token-2022 deploy — b402-solana

Mainnet upgrade procedure for the Token-2022 (Token Extensions) migration on
the `feat/token-2022` branch.

## Scope

What ships with this upgrade:

- Pool program (`42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y`) accepts
  Token-2022 mints in `add_token_config`, with an extension allowlist.
- Pool's `shield` / `unshield` work end-to-end against Token-2022 vaults.
- Jupiter adapter (`3RHRcbinCmcj8JPBfVxb9FW76oh4r8y21aSx4JFy3yx7`) reads
  Token-2022 vaults (via `InterfaceAccount` slots). OUT-side transfer still
  uses legacy `Transfer` — see "Known limitations" below.
- SDK 0.0.28 publishes the new wire shape (added `mint` slot on shield /
  unshield, added `mint_in` slot on `adapt_execute`).

What does NOT ship in this upgrade:

- Cross-token-program swap (e.g. pump.fun → USDC via Jupiter adapter)
  is rejected pre-flight by the SDK. The pump.fun privacy story works
  through shield + unshield: a depositor shields pump tokens, the link
  is broken by the mix, a different wallet unshields.
- Mock / Kamino adapters: still pinned to legacy `anchor_spl::token`.
  Not used for Token-2022 mints today.

## Pre-deploy build

```
# Branch: feat/token-2022 (HEAD)
git checkout feat/token-2022
anchor build -p b402-pool
anchor build -p b402-jupiter-adapter

# Compare .so size deltas vs mainnet to confirm under the redeploy buffer.
ls -la target/deploy/b402_pool.so target/deploy/b402_jupiter_adapter.so
solana program show 42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y -u mainnet
solana program show 3RHRcbinCmcj8JPBfVxb9FW76oh4r8y21aSx4JFy3yx7 -u mainnet
```

If new .so > deployed program's `Data length`, extend first:

```
solana program extend 42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y <bytes> -u mainnet
solana program extend 3RHRcbinCmcj8JPBfVxb9FW76oh4r8y21aSx4JFy3yx7 <bytes> -u mainnet
```

## Upgrade sequence

The SDK + pool MUST be deployed together. The SDK 0.0.28 wire shape adds
slots the old pool doesn't expect (Anchor rejects with `AccountNotEnoughKeys`),
and the new pool expects slots the SDK 0.0.27 doesn't send.

Order:

1. Upgrade pool program (atomic — new wire shape goes live).
2. Upgrade Jupiter adapter (matches the pool's new `InterfaceAccount` slot types).
3. `pnpm publish` SDK 0.0.28.
4. Trader bot deploys with `@b402ai/solana@0.0.28`.

### 1. Pool program

```
solana program deploy \
  --program-id 42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y \
  --keypair ~/.config/solana/id.json \
  --url mainnet \
  --upgrade-authority ~/.config/solana/admin.json \
  target/deploy/b402_pool.so
```

### 2. Jupiter adapter

```
solana program deploy \
  --program-id 3RHRcbinCmcj8JPBfVxb9FW76oh4r8y21aSx4JFy3yx7 \
  --keypair ~/.config/solana/id.json \
  --url mainnet \
  --upgrade-authority ~/.config/solana/admin.json \
  target/deploy/b402_jupiter_adapter.so
```

### 3. SDK publish

```
cd packages/sdk
pnpm test
pnpm build
# Verify the tarball includes programs/token-program.{js,d.ts}:
pnpm pack && tar tzf b402ai-solana-0.0.28.tgz | grep token-program
pnpm publish --access public
```

### 4. Trader bot

In `/Users/mayurchougule/development/b402-pl/b402-trader/`:

- `package.json`: bump `@b402ai/solana` from `0.0.27` to `0.0.28`.
- `src/b402-client.ts:226-237` — the `shield` call site. No code changes
  required as long as the trader passes `mint` through unchanged; SDK
  derives the token program internally via `tokenProgramOf`. Verify the
  trader's `_requireRelayer` path still injects the local keypair correctly.

```
pnpm add @b402ai/solana@0.0.28
pnpm typecheck
pnpm test
pnpm deploy   # whatever the trader's deploy command is
```

## Smoke tests post-deploy

Run from the b402-solana repo root, mainnet:

```
# 1. Existing flows still work — shield + unshield a stable mint (USDC).
node examples/indexer-smoke.mjs   # or the equivalent E2E script
B402_CLUSTER=mainnet \
  node -e "
const { B402Solana } = await import('@b402ai/solana');
const c = new B402Solana({ ... });
await c.shield({ mint: USDC, amount: 1_000_000n });
await c.unshield({ to: NEW_WALLET });
"

# 2. Token-2022 shield smoke. Use any pump.fun graduated mint:
# e.g. SLERFf... (replace with a real Token-2022 mint with non-zero balance).
B402_CLUSTER=mainnet \
  node -e "
const { B402Solana } = await import('@b402ai/solana');
const c = new B402Solana({ ... });
const PUMP = new PublicKey('...');  // Token-2022 mint
// Admin must `add_token_config` for the mint first:
//   anchor run add-token-config --mint <PUMP> --max-tvl <CAP>
await c.shield({ mint: PUMP, amount: 1000n });
"

# 3. Unshield the pump token to verify the OUT path.
await c.unshield({ to: ANOTHER_WALLET, mint: PUMP });
```

## Rollback

The pool program is upgradeable. To roll back:

```
# Build the previous .so from the parent of feat/token-2022:
git checkout feat/arcium-sealed-bid
anchor build -p b402-pool
solana program deploy \
  --program-id 42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y \
  --upgrade-authority ~/.config/solana/admin.json \
  --url mainnet \
  target/deploy/b402_pool.so

# SDK rollback: republish 0.0.27 OR have callers pin to 0.0.27 in their lockfiles.
```

The wire format is backward-incompatible — once the pool is on the new
version, the OLD SDK 0.0.27 will fail because the pool expects `mint`
slots that 0.0.27 doesn't send. Rolling back means rolling back both.

## Known limitations

1. **Cross-token-program swap**: `privateSwap(inMint, outMint)` is rejected
   pre-flight when `tokenProgramOf(inMint) != tokenProgramOf(outMint)`. The
   Jupiter adapter's OUT transfer (`adapter_out_ta` → `out_vault`) uses
   legacy `Transfer` against the pool-supplied `token_program` slot, which
   currently carries the IN mint's program. Fix requires a second
   `token_program_out` slot on `AdaptExecute` and the adapter — deferred
   to a follow-up PR.

2. **Same-program Token-2022 swap** (Token-2022 → Token-2022): works as
   long as both mints are Token-2022. Not exercised in production yet —
   smoke before promoting any user-facing flow that relies on it.

3. **Mock + Kamino adapters**: legacy `anchor_spl::token` only. No Token-2022
   support. Track in follow-up PR.

4. **Existing `tests/onchain/tests/unshield.rs`**: was already on the v1
   API (shard PDAs); not in scope to update for v2.1. The slot order in
   `unshield_ix.rs` is updated to include the new `mint` slot.

## Risk callouts

- Wire-format change: any in-flight transaction signed against the old SDK
  + new pool (or vice versa) fails with `AccountNotEnoughKeys` (Anchor 2001).
  Coordinate the SDK publish + pool deploy within minutes of each other.
- The extension allowlist defaults to **reject unknown** — when a new
  Token-2022 extension lands in `spl-token-2022` (e.g. `Pausable`), it
  routes through the catch-all `Token2022UnknownExtensionUnsupported`
  error. Allowlist updates require a pool redeploy.
- The new `Mint` account slot must be address-checked. Without that an
  attacker could swap a different mint's header into the slot to spoof
  decimals. The handler `address = token_config.mint` constraint enforces
  this; verify the constraint survives any future copy-paste refactor.

## Estimated time (user-side)

- 10 min: build + size-check
- 5 min: pool deploy
- 5 min: adapter deploy
- 10 min: SDK publish + npm propagation
- 10 min: trader bot redeploy
- 15 min: mainnet smoke (shield + unshield USDC, then a pump.fun mint)

Total: ~55 minutes happy-path.
