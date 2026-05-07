# Getting started

Add private DeFi to your Solana app in three lines.

## Install

```bash
npm install @b402ai/solana
```

## Your first private swap

```typescript
import { Keypair, PublicKey } from '@solana/web3.js';
import { B402Solana } from '@b402ai/solana';

const b402 = new B402Solana({
  cluster: 'mainnet',
  rpcUrl: process.env.RPC_URL!,        // Helius / Triton / your own
  keypair: yourKeypair,                 // user signs the initial shield only
});
await b402.ready();   // first call fetches circuit artifacts (~36MB,
                       // SHA256-verified, cached at ~/.b402ai/circuits)

const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const SOL  = new PublicKey('So11111111111111111111111111111111111111112');

// Move public USDC into the shielded pool (one-time, user signs).
await b402.shield({ mint: USDC, amount: 1_000_000n });

// Private swap — relayer signs + pays gas. Caller wallet stays off-chain.
const { signature, outAmount } = await b402.swap({
  inMint: USDC,
  outMint: SOL,
  amount: 1_000_000n,
});
```

That's the full surface for a private swap.

## What just happened

- `shield`: USDC moves from your wallet into the b402 shielded pool. Your
  wallet signs this single tx, so the deposit amount is linked to your
  address. After this, no further tx references your wallet.
- `swap`: the SDK fetches a Jupiter quote (Phoenix-direct by default),
  builds the adapter ix, and calls the pool's `adapt_execute_v2`. The
  hosted b402 relayer signs and pays gas. The on-chain swap tx contains
  the relayer's pubkey, the adapter program, and the Jupiter route — but
  not your wallet. Sender→recipient unlinkability is the property.

## What's visible on chain

| Visible                                  | Hidden                                    |
| ---------------------------------------- | ----------------------------------------- |
| Amount of the swap                       | Who deposited                             |
| Adapter program (Jupiter)                | Who receives the SOL note                 |
| Fill venue (Phoenix, Raydium, …)         | Linkage between USDC deposit and SOL out |
| Relayer pubkey (paid the gas)            | Your wallet address                       |

## Where this works

- **mainnet**: live. Pool `42a3hsCXt...rt2y`, adapter `2enwFgcGK...t2rX`,
  relayer hosted at `b402-solana-relayer-mainnet.run.app`.
- **devnet**: live. Mock adapter (constant-rate fake swap), useful for
  client wiring tests without real funds.
- **localnet**: works with a `surfpool` mainnet-fork — see
  [`docs/REPRODUCE.md`](REPRODUCE.md).

## The full method surface

| Method | What it does | Cost |
|---|---|---|
| `b402.shield({ mint, amount })` | public → shielded note | user pays ~5k lamports |
| `b402.swap({ inMint, outMint, amount })` | shielded → shielded via Jupiter | $0 (relayer pays) |
| `b402.lend({ mint, amount, market? })` | shielded → Kamino reserve, mint voucher | $0 (relayer pays) + one-time ~$7 Kamino account rent per (viewing key, mint) |
| `b402.redeem({ mint, market?, leafIndex? })` | burn voucher → shielded underlying | $0 (relayer pays) |
| `b402.unshield({ to, mint })` | shielded note → public address | $0 (relayer pays) |
| `b402.balance({ mint? })` | read shielded balance | local-only, no RPC |
| `b402.holdings({ mint? })` | per-deposit list | local-only |
| `b402.status({ refresh? })` | wallet pubkey + balances; pass refresh=true to scan chain | local or 1 RPC scan |

## Examples

A complete runnable script lives at
[`examples/quickstart-private-swap.ts`](../examples/quickstart-private-swap.ts).

```bash
git clone https://github.com/mmchougule/b402-solana
cd b402-solana
pnpm install
B402_RPC_URL='https://mainnet.helius-rpc.com/?api-key=...' \
  pnpm exec node --experimental-strip-types examples/quickstart-private-swap.ts
```

Mainnet sigs from a recent run:
- Shield: `3HaqLAX76Ff2dh...LNXb` Finalized
- Swap:   `4cWaWAY1wd3hM...sXt`  Finalized — 50,000 raw USDC → 564,337 lamports SOL via Jupiter→Raydium

## What needs your wallet to sign

Only `shield`. Every other op (`swap`, `lend`, `redeem`, `unshield`)
goes through the b402 hosted relayer — the relayer signs and pays gas,
your wallet does not appear on those txs.

If you want to self-pay (e.g. for testing without the hosted relayer),
pass `relayer: yourKeypair` to the `B402Solana` constructor. The hosted
relayer is a default convenience, not a requirement.

## Next

- [Lend on Kamino](recipes/private-lend.md) — shielded USDC into any Kamino reserve, multi-market discovered on chain
- [Use from a coding agent (Claude / Cursor)](../AGENTS.md) — let your IDE write the integration for you via `@b402ai/solana-mcp`
- [Architecture overview](../README.md#architecture) — pool, adapter, relayer, Light Protocol
- [Spec docs](prds/) — PRDs for circuit, program, and adapter design

## Help

- Issues: https://github.com/mmchougule/b402-solana/issues
- Source: https://github.com/mmchougule/b402-solana
