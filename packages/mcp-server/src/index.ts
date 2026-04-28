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
 *   - shield        — shield SPL tokens into the b402 pool
 *   - unshield      — unshield a note to a destination address
 *   - private_swap  — adapt_execute swap (shield → swap → reshield)
 *   - status        — anonymized wallet + spendable-note state
 *
 * Security:
 *   - Keypair loaded once from disk (B402_KEYPAIR_PATH) and held in memory.
 *   - Tool responses contain only public values (signatures, mint pubkeys,
 *     commitments, public keys). Never returns secret keys, viewing keys
 *     or note randomness.
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
} from './schemas.js';
import { handleShield } from './tools/shield.js';
import { handleUnshield } from './tools/unshield.js';
import { handlePrivateSwap } from './tools/private_swap.js';
import { handleStatus } from './tools/status.js';

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
        'Shield SPL tokens into the b402 pool. The caller signs the deposit; the resulting commitment hides the amount and ownership. Returns a transaction signature, commitment hash, and tree leaf index.',
      inputSchema: zodToJsonSchema(shieldInput),
    },
    {
      name: 'unshield',
      description:
        'Unshield the most-recently-shielded note for the given mint to a recipient address. Auto-creates the recipient ATA if missing. Returns the unshield transaction signature.',
      inputSchema: zodToJsonSchema(unshieldInput),
    },
    {
      name: 'private_swap',
      description:
        'Atomic shielded swap: burn an input shielded note, CPI a registered adapter, reshield the output. Requires a pre-existing shielded note in the IN mint. Returns the swap signature and the output amount.',
      inputSchema: zodToJsonSchema(privateSwapInput),
    },
    {
      name: 'status',
      description:
        'Report this client\'s public wallet pubkey, b402 spending/viewing pubkeys, and current spendable-note balances grouped by mint.',
      inputSchema: zodToJsonSchema(statusInput),
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
