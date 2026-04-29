# @b402ai/solana

Private DeFi on Solana. Shielded balances + composable adapters + agent-callable surface.

```bash
npm install @b402ai/solana
```

## What it does

- **Shield** SPL tokens into a private balance
- **Unshield** to any public address
- **Private swap** through registered adapters (Jupiter on mainnet, mock on devnet)
- **Read** your private balance / per-deposit holdings without leaking ZK plumbing
- **Watch** for new private deposits via cursor-based polling
- **Quote** swaps via Jupiter Lite API before executing

## Quick start

```ts
import { Keypair, PublicKey } from '@solana/web3.js';
import { B402Solana } from '@b402ai/solana';

const b402 = new B402Solana({
  cluster: 'devnet',
  keypair: Keypair.fromSecretKey(/* ... */),
  proverArtifacts: {
    wasmPath: '/abs/path/to/circuits/build/transact_js/transact.wasm',
    zkeyPath: '/abs/path/to/circuits/build/ceremony/transact_final.zkey',
  },
});
await b402.ready();

const usdc = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const { signature } = await b402.shield({ mint: usdc, amount: 1_000_000n });
console.log('shielded:', signature);

const { balances } = await b402.balance({ mint: usdc });
console.log('private balance:', balances);

await b402.unshield({ to: keypair.publicKey });
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
