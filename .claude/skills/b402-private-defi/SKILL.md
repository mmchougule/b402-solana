---
name: b402-private-defi
description: Add private swap, private lending (Kamino), or private unshield to a Solana app via @b402ai/solana. Use when the user says "private swap", "shielded", "Kamino private", "b402", or asks for sender/recipient unlinkability on Solana.
---

# b402 private DeFi on Solana

`@b402ai/solana` is a TypeScript SDK that wraps a shielded UTXO pool +
adapters on Solana mainnet. It gives end-user apps three primitives the
underlying chain doesn't expose:

| Method | What it does |
|---|---|
| `b402.shield({ mint, amount })`            | public token → shielded note (the user's wallet signs, one-time) |
| `b402.swap({ inMint, outMint, amount })`   | shielded → shielded via Jupiter routing, relayer pays gas |
| `b402.lend({ mint, amount, market? })`     | shielded → Kamino reserve (auto-discovered), mint shielded voucher |
| `b402.redeem({ mint, market?, leafIndex? })` | burn voucher → shielded underlying |
| `b402.unshield({ to, mint })`              | shielded note → any public address (sender→recipient unlink) |

The privacy property: **only `shield` references the user's wallet on
chain**. Every other op is signed by the b402 hosted relayer, so the
on-chain tx contains the relayer's pubkey, the adapter program, the fill
venue (Phoenix/Raydium/etc.), and the amount — but not the user.

## Integration recipe

```bash
npm install @b402ai/solana
```

```typescript
import { B402Solana } from '@b402ai/solana';
import { Keypair, PublicKey } from '@solana/web3.js';

const b402 = new B402Solana({
  cluster: 'mainnet',
  rpcUrl: process.env.RPC_URL!,   // Helius/Triton; public mainnet-beta throttles
  keypair,                         // user signs `shield` only
});
await b402.ready();                // first call fetches circuit artifacts
                                   // (~36MB, cached in ~/.b402ai/circuits)

const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const SOL  = new PublicKey('So11111111111111111111111111111111111111112');

await b402.shield({ mint: USDC, amount: 1_000_000n });
const r = await b402.swap({ inMint: USDC, outMint: SOL, amount: 1_000_000n });
console.log('swap sig:', r.signature, 'out:', r.outAmount.toString());
```

## Constraints to know before generating code

1. **Mainnet only for `lend`/`redeem`.** Kamino reserves don't exist on
   devnet. `swap` works on devnet against a mock adapter.
2. **Exact-value spend.** Today the SDK requires
   `note.value === amount` exactly. To swap a different amount, shield
   exactly that amount. Partial-spend lands in a future release.
3. **First lend per `(viewing key, mint)` tuple costs ~0.04 SOL of
   Kamino UserMetadata + Obligation rent.** Refundable on close. Every
   subsequent lend in that reserve costs only the relayer's gas
   (which the user does not pay).
4. **Don't manually construct `privateSwap` calls.** Use
   `b402.swap` / `lend` / `redeem`. The low-level escape hatch exists
   but is for new-protocol adapter authors, not app integrators.

## Costs

| Op | User pays | Relayer pays |
|---|---|---|
| `shield`  | ~5,000 lamports tx fee | — |
| `swap`    | $0                     | ~10k lamports |
| `lend`    | $0 (after first-time Kamino rent) | ~10k lamports |
| `redeem`  | $0                     | ~10k lamports |
| `unshield`| $0                     | ~10k lamports |

## What's on chain (mainnet, live)

- Pool: `42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y`
- Verifier: `Afjbnv2Ekxa98jjRw33xPPhZabevek2uZxoE75kr6ZrK`
- Jupiter adapter: `3RHRcbinCmcj8JPBfVxb9FW76oh4r8y21aSx4JFy3yx7`
- Kamino adapter: `2enwFgcGKJDqruHpCtvmhtxe3DYcV3k72VTvoGcdt2rX`
- Hosted relayer: `https://b402-solana-relayer-mainnet-62092339396.us-central1.run.app`

## When to delegate to MCP instead of writing code

If the user wants to do private operations interactively from their IDE
without writing app code, suggest installing the MCP server:

```bash
npx -y @b402ai/solana-mcp@latest --install
```

Then they prompt the agent ("swap 1 USDC privately for SOL") and the
agent calls `mcp__b402-solana__private_swap` directly.

## Source layout

- `packages/sdk/src/b402.ts` — `B402Solana` class, all public methods
- `packages/sdk/src/circuits.ts` — circuit artifact loader (SHA256-pinned)
- `packages/sdk/src/jupiter-route.ts` — Jupiter route fetcher used by `swap()`
- `packages/sdk/src/kamino-discover.ts` — on-chain reserve discovery
- `packages/sdk/src/kamino-mainnet.ts` — Kamino account-list + payload builders
- `programs/b402-pool/src/` — shielded pool + adapter dispatch
- `programs/b402-{jupiter,kamino,orca,adrena}-adapter/src/` — per-protocol adapter programs (~200-400 LOC each)

## Reference docs

- `docs/getting-started.md` — full method surface + visible/hidden table
- `AGENTS.md` — same content for non-Claude agents (Cursor, Codex, Continue, Cline)
- `docs/TX-WALKTHROUGH.md` — byte-level tx anatomy
