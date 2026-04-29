# @b402ai/solana-mcp

Model Context Protocol server exposing the b402 Solana SDK as agent-callable tools. Compatible with Claude Code, Cursor, and any other MCP runtime that speaks the protocol over stdio.

## One-line install

```bash
claude mcp add b402-solana -- npx -y @b402ai/solana-mcp
```

That's it. Defaults to mainnet using your existing Solana CLI keypair (`~/.config/solana/id.json`) — circuit artifacts are bundled in the package, no separate clone needed. Set `B402_CLUSTER=devnet` for risk-free testing.

Then in any Claude Code session: `"What's my private balance on b402?"` → tools fire.

## Tools

| Tool | What it does |
|---|---|
| `shield` | Move SPL tokens from the wallet into a private balance |
| `unshield` | Withdraw a private deposit to a public address |
| `private_swap` | Atomic private swap through a registered adapter (Jupiter on mainnet, mock on devnet) |
| `status` | Wallet pubkey + private balances by mint |
| `holdings` | Per-deposit private holdings (id, mint, amount) |
| `balance` | Aggregate private balance per mint |
| `quote_swap` | Jupiter quote (mainnet routes only): expected OUT, slippage, price impact |
| `watch_incoming` | Cursor-based poll for newly-arrived private deposits |

## Optional env overrides

All four are optional — set only when you need to override a default.

| Variable | Default |
|---|---|
| `B402_CLUSTER` | `devnet` (one of `mainnet` / `devnet` / `localnet`) |
| `B402_RPC_URL` | public RPC for the cluster (use Helius / Triton in production) |
| `B402_KEYPAIR_PATH` | `~/.config/solana/id.json` |
| `B402_CIRCUITS_ROOT` | bundled artifacts shipped inside this package |

Example with overrides:

```bash
claude mcp add b402-solana \
  --env B402_CLUSTER=mainnet \
  --env B402_RPC_URL=https://your-helius-rpc \
  -- npx -y @b402ai/solana-mcp
```

## Security

- Keypair loaded once from disk; never logged, never returned in tool responses.
- Tool responses include only public values: signatures, pubkeys, opaque deposit IDs, mints, amounts.
- Input pubkeys validated as base58; amounts validated as u64 strings (no floats).
- Stdout is the MCP transport; status messages go to stderr only.

## Caveats

- Circuit artifacts shipped here are throwaway-devnet ceremony output. Mainnet-grade ceremony zkey ships separately when the b402 mainnet ceremony completes.
- Jupiter quote works only on mainnet — devnet calls return `RouteNotFound` because Jupiter doesn't index devnet liquidity.
- `private_swap` on devnet uses the mock adapter (constant 2x echo) since devnet has no AMM liquidity. Mainnet routes through Jupiter.

## License

Apache-2.0. Source: https://github.com/mmchougule/b402-solana
