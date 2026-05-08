# @b402ai/solana

Composable Confidential DeFi on Solana. Shielded balances + per-protocol adapters + agent-callable surface.

```bash
npm install @b402ai/solana
```

## What it does

- **Shield** SPL tokens into a private balance
- **Unshield** to any public address
- **Private swap** through registered adapters (Jupiter on mainnet, mock on devnet)
- **Private lend** USDC into Kamino V2 from a shielded note (per-user obligation, mainnet)
- **Private redeem** a kUSDC voucher back into a shielded USDC note (mainnet)
- **Read** your private balance / per-deposit holdings without leaking ZK plumbing
- **Watch** for new private deposits via cursor-based polling
- **Quote** swaps via Jupiter Lite API before executing

## Quick start

Three-line private swap on mainnet:

```ts
import { B402Solana } from '@b402ai/solana';
import { Keypair, PublicKey } from '@solana/web3.js';

const b402 = new B402Solana({ cluster: 'mainnet', rpcUrl, keypair });
await b402.ready();

const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const SOL  = new PublicKey('So11111111111111111111111111111111111111112');

// Move public USDC into the shielded pool (user signs, one-time).
await b402.shield({ mint: USDC, amount: 1_000_000n });

// Private swap. Hosted relayer signs + pays gas; user wallet stays off-chain.
const { signature, outAmount } = await b402.swap({
  inMint: USDC, outMint: SOL, amount: 1_000_000n,
});
```

Full walkthrough: [`docs/getting-started.md`](https://github.com/mmchougule/b402-solana/blob/main/docs/getting-started.md).
Runnable example: [`examples/quickstart-private-swap.ts`](https://github.com/mmchougule/b402-solana/blob/main/examples/quickstart-private-swap.ts).

### Lend privately on Kamino

`b402.lend()` auto-discovers the deepest Kamino reserve for the mint
across all 182 LendingMarkets — no static reserve list. Pass `market`
to pin a specific one.

```ts
const lend = await b402.lend({ mint: USDC, amount: 1_000_000n });
const redeem = await b402.redeem({ mint: USDC });
```

### Withdraw to a different recipient

```ts
// The SOL note from `swap` can land at ANY public address — breaking
// the on-chain edge between depositor and recipient.
await b402.unshield({ to: someOtherWallet, mint: SOL });
```

For a working scaffold:

```bash
npx @b402ai/create-agent my-agent
```

## Agent loop

```ts
let cursor: string | undefined;
while (running) {
  const r = await b402.watchIncoming({ cursor });
  cursor = r.cursor;
  for (const d of r.incoming) console.log('new deposit:', d.amount, d.mint);
  await sleep(2_000);
}
```

## MCP

Same surface is exposed as agent-callable MCP tools via [`@b402ai/solana-mcp`](https://www.npmjs.com/package/@b402ai/solana-mcp) — works with Claude Code, Cursor and any MCP runtime.

## License

Apache-2.0. See [LICENSE](https://github.com/mmchougule/b402-solana/blob/main/LICENSE).
