#!/usr/bin/env node
/**
 * b402-solana MCP server.
 *
 * Exposes the B402Solana SDK as agent-callable tools over stdio. Compatible
 * with Claude Code, Cursor, and any other MCP runtime that speaks the
 * Model Context Protocol.
 *
 * Usage:
 *   claude mcp add b402-solana node /abs/path/to/dist/index.js \
 *     --env B402_RPC_URL=https://api.devnet.solana.com \
 *     --env B402_CLUSTER=devnet \
 *     --env B402_CIRCUITS_ROOT=/abs/path/to/circuits/build
 *
 * Tools:
 *   - shield        — move SPL tokens into a private balance
 *   - unshield      — withdraw a private deposit to a public address
 *   - private_swap  — atomic private swap through a registered adapter
 *   - status        — wallet pubkey + private balances by mint
 *   - holdings      — per-deposit private holdings (id, mint, amount)
 *   - balance       — aggregate private balance per mint
 *   - quote_swap    — Jupiter quote: expected OUT, slippage, price impact
 *   - watch_incoming — cursor-based poll for newly-arrived private deposits
 *
 * Security:
 *   - Keypair loaded once from disk (B402_KEYPAIR_PATH) and held in memory.
 *   - Tool responses include only public values (signatures, mint pubkeys,
 *     opaque deposit IDs). Never returns secret keys or anything spendable.
 *   - All input pubkeys validated as base58; amounts validated as u64-string
 *     to prevent floating-point precision loss.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { loadContext, type B402Context } from './context.js';
import {
  shieldInput,
  unshieldInput,
  privateSwapInput,
  statusInput,
  walletBalanceInput,
  holdingsInput,
  balanceInput,
  quoteSwapInput,
  watchIncomingInput,
} from './schemas.js';
import { handleShield } from './tools/shield.js';
import { handleUnshield } from './tools/unshield.js';
import { handlePrivateSwap } from './tools/private_swap.js';
import { handleStatus } from './tools/status.js';
import { handleWalletBalance } from './tools/wallet_balance.js';
import { handleHoldings } from './tools/holdings.js';
import { handleBalance } from './tools/balance.js';
import { handleQuoteSwap } from './tools/quote_swap.js';
import { handleWatchIncoming } from './tools/watch_incoming.js';
import { createLogger, type Logger } from './logger.js';

import { zodToJsonSchema } from 'zod-to-json-schema';

const logger: Logger = createLogger();

const server = new Server(
  {
    name: 'b402-solana',
    version: '0.0.7',
  },
  {
    capabilities: {
      tools: {},
    },
    instructions: [
      'b402-solana lets you move SPL tokens between PUBLIC and PRIVATE balances on Solana, and swap privately through registered adapters.',
      '',
      'Two balance worlds:',
      '  PUBLIC  — normal Solana wallet (visible on-chain). Use `wallet_balance`.',
      '  PRIVATE — shielded pool deposits (hidden amounts/owner). Use `balance` (totals) or `holdings` (per-deposit).',
      '',
      'Typical agent flow:',
      '  1. Read state: `wallet_balance` + `balance` to see both worlds.',
      '  2. Move in: `shield` (public → private). User signs SPL transfer.',
      '  3. Move privately: `private_swap` (in mint → out mint, via Jupiter on mainnet / mock adapter on devnet). Use `quote_swap` first to predict.',
      '  4. Move out: `unshield` (private → any public address). The recipient need not be the depositor — that is the privacy win.',
      '',
      'Privacy property: `unshield` and `private_swap` are signed/paid by b402\'s hosted relayer, NOT the user. The user wallet does not appear on those txs. `shield` is unavoidably signed by the user (Anchor requires depositor sig for SPL transfer auth).',
      '',
      'Defaults: cluster=mainnet (alpha live), hosted relayer URL + API key pre-wired. The user\'s Solana CLI keypair at ~/.config/solana/id.json is read for shield (depositor signature). No env vars needed for the demo flow.',
      '',
      'Optional overrides the user can set before launch (mention only when relevant — agents in tight loops or hitting rate limits):',
      '  B402_RPC_URL     — a private RPC endpoint (Helius / Triton / QuickNode / Alchemy). Default is public api.mainnet-beta.solana.com which throttles ~40 RPS per IP.',
      '  B402_CLUSTER     — devnet for risk-free testing, localnet for a local validator. Default mainnet.',
      '  B402_KEYPAIR_PATH — alternate Solana keypair file path. Default ~/.config/solana/id.json.',
      '',
      'When unsure, call `status` first — it returns wallet pubkey + private balances and is the cheapest snapshot.',
    ].join('\n'),
  },
);

let cachedContext: B402Context | null = null;
function ctx(): B402Context {
  if (!cachedContext) cachedContext = loadContext();
  return cachedContext;
}

// --- list tools ---
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // ─── READ (cheap, no on-chain side effect) ─────────────────────────
    {
      name: 'status',
      description:
        'READ. Cheapest overview tool — call this first when unsure. Returns wallet pubkey + private balances grouped by mint. Costs 0 SOL. No args.',
      inputSchema: zodToJsonSchema(statusInput),
    },
    {
      name: 'wallet_balance',
      description:
        'READ public-side. What the user holds in their normal Solana wallet (NOT shielded): SOL + every SPL token account with mint, raw amount, decimals, ATA address. USE WHEN: user asks "what do I have", before sizing a shield, or to verify post-unshield. Pair with `balance` for full picture.',
      inputSchema: zodToJsonSchema(walletBalanceInput),
    },
    {
      name: 'balance',
      description:
        'READ private-side. Aggregate shielded balance grouped by mint. Each entry: { mint (base58 if known), amount (smallest units, string), depositCount }. USE WHEN: user asks about private balance / "what\'s in the pool". Pass `mint` to filter to one mint. Set `refresh: true` to re-scan on-chain history (slow on free RPC; rarely needed since shield/unshield update local state).',
      inputSchema: zodToJsonSchema(balanceInput),
    },
    {
      name: 'holdings',
      description:
        'READ private-side. Per-deposit list — each row is one private deposit: { id, mint, amount }. USE WHEN: user wants to reason about individual deposits (partial unshield strategy, rebalancing across deposits). For totals, prefer `balance`.',
      inputSchema: zodToJsonSchema(holdingsInput),
    },
    {
      name: 'watch_incoming',
      description:
        'READ private-side, cursor-paginated. Returns new private deposits since `cursor`, plus the new cursor to use next. USE WHEN: building agentic loops that react to incoming deposits. Omit cursor on first call. Sleep ~2-3s between calls. The SDK already updates state on `shield` — only useful when deposits arrive from elsewhere.',
      inputSchema: zodToJsonSchema(watchIncomingInput),
    },
    {
      name: 'quote_swap',
      description:
        'READ via Jupiter Lite API (mainnet routes only — devnet returns no-route). Returns expected out amount, slippage, price impact, route hops for an inMint→outMint swap. USE WHEN: before `private_swap` to predict outcome and bound slippage. Quote may differ from on-chain execution by up to slippageBps.',
      inputSchema: zodToJsonSchema(quoteSwapInput),
    },
    // ─── WRITE (on-chain tx, costs SOL or relayer SOL) ────────────────
    {
      name: 'shield',
      description:
        'WRITE: public → private. Move SPL tokens from the user\'s wallet into a shielded deposit. USE WHEN: user wants to start using private balances, or top up private side. INPUT: { mint (base58), amount (smallest units, u64 string) }. RETURNS: { signature, commitment (deposit id), leafIndex }. PRIVACY: depositor wallet IS visible on this tx — they sign the SPL transfer. Cost: ~5000 lamports (user pays).',
      inputSchema: zodToJsonSchema(shieldInput),
    },
    {
      name: 'unshield',
      description:
        'WRITE: private → public. Withdraw a private deposit to ANY public address (need not be the depositor — that is the privacy win). INPUT: { to (recipient pubkey), mint }. CONSTRAINT: spends the WHOLE deposit (most-recent for that mint). To withdraw a partial amount, first split the deposit by unshielding + reshielding the desired chunk. AUTO-CREATES recipient token account if missing. RETURNS: { signature }. PRIVACY: the b402 hosted relayer signs and pays gas; user wallet does NOT appear on this tx.',
      inputSchema: zodToJsonSchema(unshieldInput),
    },
    {
      name: 'private_swap',
      description:
        'WRITE: private → private (atomic). Swap one shielded mint for another via a registered adapter. INPUT: { inMint, outMint, amount }. CRITICAL CONSTRAINT: amount must EXACTLY match a deposit value — privateSwap spends the whole deposit, partial spends are not supported in v1. Call `holdings { mint: inMint }` first to read available deposit sizes, then pass one of them as amount. Adapter, ALT, scratch ATAs, expectedOut auto-resolved from cluster (Jupiter mainnet; mock devnet). RETURNS: { signature, outAmount, outDepositId }. CALL `quote_swap` FIRST on mainnet to bound slippage. PRIVACY: relayer signs/pays; user wallet absent from tx.',
      inputSchema: zodToJsonSchema(privateSwapInput),
    },
  ],
}));

// --- call tool ---
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: rawArgs } = req.params;
  const args = rawArgs ?? {};
  const t0 = Date.now();

  // Boundary-only telemetry: log the tool call shape (which mint, which
  // amount) but never the recipient pubkey or a memo. mint + amount tell
  // us what's being moved; the depositor signs the tx so it's already
  // public; the recipient is the one piece we treat as private.
  logger.info('tool.start', {
    tool: name,
    ...(typeof args === 'object' && args !== null
      ? Object.fromEntries(
          Object.entries(args as Record<string, unknown>).filter(([k]) =>
            k === 'mint' || k === 'inMint' || k === 'outMint' ||
            k === 'amount' || k === 'slippageBps',
          ),
        )
      : {}),
  });

  try {
    let result: unknown;
    switch (name) {
      case 'shield':
        result = await handleShield(ctx(), shieldInput.parse(args));
        break;
      case 'unshield':
        result = await handleUnshield(ctx(), unshieldInput.parse(args));
        break;
      case 'private_swap':
        result = await handlePrivateSwap(ctx(), privateSwapInput.parse(args));
        break;
      case 'status':
        result = await handleStatus(ctx());
        break;
      case 'wallet_balance':
        result = await handleWalletBalance(ctx());
        break;
      case 'holdings':
        result = await handleHoldings(ctx(), holdingsInput.parse(args));
        break;
      case 'balance':
        result = await handleBalance(ctx(), balanceInput.parse(args));
        break;
      case 'quote_swap':
        result = await handleQuoteSwap(ctx(), quoteSwapInput.parse(args));
        break;
      case 'watch_incoming':
        result = await handleWatchIncoming(ctx(), watchIncomingInput.parse(args));
        break;
      default:
        throw new Error(`unknown tool: ${name}`);
    }
    // Surface tx-shaped fields from the response so the log is self-narrating
    // (sig + commitment for shield → explorer link + Poseidon commitment in
    // the right pane). The result shape varies per tool; we just sniff for
    // known fields and only emit the ones present.
    const r = result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
    const extras: Record<string, string> = {};
    if (typeof r.signature === 'string') extras.sig = r.signature;
    if (typeof r.commitment === 'string') extras.commitment = r.commitment;
    if (typeof r.leafIndex === 'string') extras.leafIndex = r.leafIndex;
    logger.info('tool.ok', {
      tool: name,
      ms: Date.now() - t0,
      ...extras,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Classify the error without logging its payload — error messages from
    // RPC / Anchor / on-chain often embed pubkeys (recipient ATAs, mint
    // accounts) that we treat as private metadata. Caller still gets the
    // full message in the tool response; the file log only records the
    // category so an admin can see frequency without leakage.
    const kind = classifyError(msg);
    logger.error('tool.err', { tool: name, ms: Date.now() - t0, kind });
    return {
      isError: true,
      content: [{ type: 'text', text: msg }],
    };
  }
});

function classifyError(msg: string): string {
  if (/no.*deposit|spendable|NO_SPENDABLE/i.test(msg)) return 'no_spendable_notes';
  if (/amount.*range|out of u64|amount must/i.test(msg)) return 'amount_out_of_range';
  if (/AccountNotInitialized/i.test(msg)) return 'token_config_not_registered';
  if (/Transaction simulation failed/i.test(msg)) return 'tx_simulation_failed';
  if (/Transaction was not confirmed/i.test(msg)) return 'tx_not_confirmed';
  if (/insufficient lamports/i.test(msg)) return 'insufficient_lamports';
  if (/relayer.*\/relay/i.test(msg)) return 'relayer_http_error';
  if (/InvalidConfig|missing/i.test(msg)) return 'invalid_config';
  return 'other';
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is the MCP transport.
  process.stderr.write('b402-solana MCP server listening on stdio\n');
  logger.info('boot', {
    cluster: process.env.B402_CLUSTER ?? 'devnet',
    rpc: (process.env.B402_RPC_URL ?? '').replace(/api-key=[^&]*/, 'api-key=***'),
    relayer: process.env.B402_RELAYER_HTTP_URL ?? '(default)',
    pid: process.pid,
  });
}

const shutdown = (signal: string) => {
  logger.info('shutdown', { signal });
  logger.close();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  logger.error('fatal', { msg });
  logger.close();
  process.stderr.write(`fatal: ${msg}\n`);
  process.exit(1);
});
