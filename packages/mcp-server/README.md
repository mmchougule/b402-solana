# @b402ai/solana-mcp

Model Context Protocol server exposing the b402-solana SDK as agent-callable tools. Compatible with Claude Code, Cursor, and any other MCP runtime that speaks the protocol over stdio.

## Tools

| Tool | What it does |
|---|---|
| `shield` | Shield SPL tokens into the b402 pool |
| `unshield` | Unshield the most-recently-shielded note to a recipient |
| `private_swap` | Atomic shielded swap via a registered adapter (`adapt_execute`) |
| `status` | Public wallet pubkey + b402 spending/viewing pubkeys + spendable-note balances |

`private_lend` and `redeem` are not yet wired — they ship with the v2 ABI work tracked in PR #16.

## Install

```bash
pnpm install
pnpm --filter '@b402ai/solana-mcp' build
```

## Configure as an MCP server

```bash
claude mcp add b402-solana node /abs/path/to/packages/mcp-server/dist/index.js \
  --env B402_RPC_URL=https://api.devnet.solana.com \
  --env B402_CLUSTER=devnet \
  --env B402_CIRCUITS_ROOT=/abs/path/to/b402-solana/circuits/build
```

## Env contract

| Variable | Required | Default |
|---|---|---|
| `B402_RPC_URL` | yes | — |
| `B402_CLUSTER` | no | `devnet` (one of `mainnet` / `devnet` / `localnet`) |
| `B402_KEYPAIR_PATH` | no | `~/.config/solana/id.json` |
| `B402_CIRCUITS_ROOT` | yes | — (must contain `transact_js/transact.wasm`, `ceremony/transact_final.zkey`; adapt artifacts optional but required for `private_swap`) |

## Security

- Keypair loaded once from disk; never logged, never returned in tool responses.
- Tool responses include only public values: signatures, pubkeys, commitment hashes, public mints, balances.
- All input pubkeys validated as base58, amounts validated as u64 strings (no floats).
- Stdout is the MCP transport; status messages go to stderr only.

## Test

```bash
pnpm --filter '@b402ai/solana-mcp' test
```

Schema validation tests run in vitest. End-to-end agent-driven tests are documented in `docs/AGENT-DEMO.md` once that lands.
