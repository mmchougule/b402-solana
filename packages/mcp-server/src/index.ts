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
  holdingsInput,
  balanceInput,
} from './schemas.js';
import { handleShield } from './tools/shield.js';
import { handleUnshield } from './tools/unshield.js';
import { handlePrivateSwap } from './tools/private_swap.js';
import { handleStatus } from './tools/status.js';
import { handleHoldings } from './tools/holdings.js';
import { handleBalance } from './tools/balance.js';

import { zodToJsonSchema } from 'zod-to-json-schema';

const server = new Server(
  {
    name: 'b402-solana',
    version: '0.0.1',
  },
  {
    capabilities: {
      tools: {},
    },
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
    {
      name: 'shield',
      description:
        'Move SPL tokens from the caller\'s wallet into a private balance. Returns the transaction signature and an opaque deposit id.',
      inputSchema: zodToJsonSchema(shieldInput),
    },
    {
      name: 'unshield',
      description:
        'Withdraw a private deposit (most-recent for the given mint) to a public address. Auto-creates the recipient token account if missing. Returns the transaction signature.',
      inputSchema: zodToJsonSchema(unshieldInput),
    },
    {
      name: 'private_swap',
      description:
        'Atomic private swap: spend a private deposit in the IN token, route through a registered adapter, deposit the OUT token back into a fresh private balance. Requires a pre-existing private deposit in the IN mint. Returns the swap signature and output amount.',
      inputSchema: zodToJsonSchema(privateSwapInput),
    },
    {
      name: 'status',
      description:
        'Report the caller\'s public wallet pubkey and current private balances grouped by mint.',
      inputSchema: zodToJsonSchema(statusInput),
    },
    {
      name: 'holdings',
      description:
        'Per-deposit view of private holdings (id, mint, amount). Use this when you need to reason about individual deposits — partial unshields, rebalancing, etc. For totals, use balance instead.',
      inputSchema: zodToJsonSchema(holdingsInput),
    },
    {
      name: 'balance',
      description:
        'Aggregate private balance grouped by mint. The default read tool — pass {mint} to filter and resolve its base58 address. By default refreshes from on-chain history before returning.',
      inputSchema: zodToJsonSchema(balanceInput),
    },
  ],
}));

// --- call tool ---
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: rawArgs } = req.params;
  const args = rawArgs ?? {};

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
      case 'holdings':
        result = await handleHoldings(ctx(), holdingsInput.parse(args));
        break;
      case 'balance':
        result = await handleBalance(ctx(), balanceInput.parse(args));
        break;
      default:
        throw new Error(`unknown tool: ${name}`);
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: 'text', text: msg }],
    };
  }
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is the MCP transport.
  process.stderr.write('b402-solana MCP server listening on stdio\n');
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
