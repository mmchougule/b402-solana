# b402-agent

Private-DeFi agent on Solana. Generated from `@b402ai/create-agent`.

## Quick start

```bash
# 1. clone the b402-solana repo somewhere alongside this directory so the
#    template can find the prover artifacts
git clone https://github.com/mmchougule/b402-solana ../b402-solana

# 2. configure
cp .env.example .env
# edit .env — at minimum, point B402_KEYPAIR_PATH at your Solana CLI keypair

# 3. fund the keypair
solana airdrop 1 -u devnet

# 4. run
pnpm install
pnpm dev
```

You should see three real devnet transaction URLs printed.

## What this does

Runs `shield → tail_notes loop → unshield` against the b402 devnet pool. Each step is a real on-chain transaction — no mocks. Customise `src/index.ts` to drop in your own private-DeFi logic between the shield and unshield calls.

## Going further

- **Adapters** — wrap any Solana program (Kamino, Drift, Jupiter, Bags) into the b402 adapter ABI to compose privately. See [`programs/`](https://github.com/mmchougule/b402-solana/tree/main/programs) and [issues labelled `adapter`](https://github.com/mmchougule/b402-solana/labels/adapter).
- **MCP** — expose this agent as an MCP server for Claude Code / Cursor. See [`packages/mcp-server`](https://github.com/mmchougule/b402-solana/tree/main/packages/mcp-server).
- **Mainnet** — devnet artifacts are throwaway-only. Mainnet ceremony is tracked in [PRD-08](https://github.com/mmchougule/b402-solana/blob/main/docs/prds/PRD-08-ceremony.md).

## Caveats

- Devnet only out of the box. Setting `B402_CLUSTER=mainnet` is wired but not yet recommended — the ceremony is dev-only.
- Throwaway ceremony — do not use this for real value.
- The example uses devnet USDC mint by default. Override `B402_TOKEN_MINT` for other tokens.
