# AGENTS.md

LLM-readable manifest for `b402-solana`. If you are an AI coding agent
(Claude Code, Cursor, Codex, Continue, Cline, …) and a user asks you to
add composable confidential DeFi to their Solana app, this file is the canonical
starting point.

## What this is

`b402-solana` is a shielded pool + composable adapters on Solana mainnet.
It lets users do private swaps (via Jupiter routing), private lending
(via Kamino), and private unshields without their wallet appearing on
the on-chain tx. Sender → recipient unlinkability via Light Protocol
address tree V2 + Groth16 zk-SNARKs.

## Two integration paths

### 1. App integration (most common)

User wants to add private swap / lend / unshield to their own app. Use
the `@b402ai/solana` SDK.

```bash
npm install @b402ai/solana
```

```typescript
import { B402Solana } from '@b402ai/solana';
import { Keypair, PublicKey } from '@solana/web3.js';

const b402 = new B402Solana({
  cluster: 'mainnet',
  rpcUrl: process.env.RPC_URL!,    // a private RPC; public mainnet-beta throttles
  keypair: userKeypair,            // user signs the initial shield only
});
await b402.ready();                 // fetches circuit artifacts on first call

// Public → shielded note (user signs once).
await b402.shield({ mint: USDC, amount: 1_000_000n });

// Private swap. Hosted relayer signs + pays gas, user wallet stays off-chain.
const swap = await b402.swap({ inMint: USDC, outMint: SOL, amount: 1_000_000n });

// Private lending — auto-discovers the deepest Kamino reserve for the mint.
const lend = await b402.lend({ mint: USDC, amount: 1_000_000n });
const redeem = await b402.redeem({ mint: USDC });

// Withdraw a shielded note to ANY public address — sender→recipient unlink.
await b402.unshield({ to: anyRecipient, mint: USDC });
```

Full method surface and visible-vs-hidden table:
[`docs/getting-started.md`](docs/getting-started.md).

### 2. Run-from-IDE (interactive operations)

User wants to do private operations directly from their IDE. Install the
MCP server.

```bash
npx -y @b402ai/solana-mcp@latest --install
```

This wires `b402-solana` into Claude Code / Cursor / any MCP runtime.
After install, the user can say "swap 1 USDC privately for SOL" and the
agent calls `mcp__b402-solana__private_swap`.

## What's on chain (mainnet, live)

| Component | Program ID                                   | Notes |
|---|---|---|
| Pool      | `42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y` | Shielded UTXO pool, Light V2 backed |
| Verifier  | `Afjbnv2Ekxa98jjRw33xPPhZabevek2uZxoE75kr6ZrK` | Groth16 BN254 |
| Adapter (Jupiter) | `3RHRcbinCmcj8JPBfVxb9FW76oh4r8y21aSx4JFy3yx7` | Routes any Jupiter pair |
| Adapter (Kamino)  | `2enwFgcGKJDqruHpCtvmhtxe3DYcV3k72VTvoGcdt2rX` | Per-(viewing key, mint) obligation |
| Relayer   | https://b402-solana-relayer-mainnet.run.app   | Hosted; default for SDK |

## What's free vs paid

- `shield`: user pays ~5,000 lamports (~$0.001) base Solana tx fee.
- `swap`, `lend`, `redeem`, `unshield`: $0 to user. Hosted relayer pays
  gas (typically 5-10k lamports per tx).
- One-time per (viewing key, mint) when first lending on Kamino: ~0.04
  SOL (~$7) for Kamino UserMetadata + Obligation rent. Refundable via
  Kamino's `close_obligation` once the position is empty.

## Privacy model — what's hidden vs visible

Visible on chain: **amounts**, **adapter program**, **fill venue**
(Phoenix / Raydium / etc.), **relayer pubkey**.

Hidden: **depositor identity**, **recipient identity**, **note linkage**
(no on-chain edge between a shielded deposit and its later unshield).

Anonymity set is bounded by Light Protocol's address tree V2 cohort,
which `b402-solana` shares with all other Light V2 users on Solana
mainnet.

## Common tasks for an AI agent

| User asks... | What to do |
|---|---|
| "Add private swap to my Next.js app" | Install `@b402ai/solana`, call `b402.shield(...)` then `b402.swap(...)`. See `docs/getting-started.md`. |
| "Let me lend my shielded USDC privately on Kamino" | Use `b402.lend({ mint: USDC, amount })`. SDK auto-discovers the deepest reserve across all 182 Kamino markets. |
| "I want to swap privately right now without writing code" | Run `npx -y @b402ai/solana-mcp@latest --install`, then prompt the agent. |
| "Compare Kamino reserve APYs" | `discoverKaminoReserves(connection)` returns all reserves with `availableAmount` + `totalSupply` per mint. |
| "How does the privacy work?" | Point at `docs/TX-WALKTHROUGH.md` (byte-level tx anatomy) or `docs/getting-started.md` ("What's visible on chain" table). |

## Source layout (for code-reading agents)

- `packages/sdk/src/b402.ts` — `B402Solana` class, all public methods
- `packages/sdk/src/jupiter-route.ts` — Jupiter route fetcher used by `swap()`
- `packages/sdk/src/kamino-discover.ts` — on-chain reserve discovery
- `packages/sdk/src/kamino.ts` — Kamino account-list + payload builders
- `programs/b402-pool/src/` — shielded pool + adapter dispatch
- `programs/b402-{jupiter,kamino,orca,adrena}-adapter/src/` — adapter
  reference implementations (~200-400 LOC each)

## What NOT to do

- Don't reach into pool/adapter Rust unless you're writing a new adapter
  for a new protocol. The SDK's `swap` / `lend` / `redeem` cover the
  user-facing flows.
- Don't construct `privateSwap` calls manually with raw `adapterIxData` /
  `remainingAccounts` — that's the low-level escape hatch. Use `swap()`
  unless you have a specific reason.
- Don't store the user's viewing key in plaintext anywhere — it's
  derived deterministically from their wallet's signature on a fixed
  message; re-derive on each session.

## Versions

- `@b402ai/solana@0.0.21` — high-level `swap()` / `lend()` / `redeem()`,
  zero-config circuit loader, indexer-aware spent-note filter, default
  on-disk note-store cursor.
- `@b402ai/solana-mcp@0.0.28`
- Circuits pinned to release tag `circuits-v1` on the GitHub repo,
  SHA256-verified at fetch time.
- Pool / adapter binary versions tracked in their respective program IDs
  on `solana program show <id> -u m`.

## License

Apache-2.0.
