/**
 * b402-solana relayer — HTTP fee-payer + tx submitter.
 *
 * Boot sequence:
 *   1. Load + validate env (config.ts).
 *   2. Open RPC connection.
 *   3. Construct Authenticator (loads API-key map if present).
 *   4. Construct RpcSubmitter.
 *   5. Register routes on Fastify.
 *   6. Listen.
 *
 * Signals: SIGINT/SIGTERM trigger graceful shutdown — stop accepting new
 * requests, wait for in-flight relays to drain, close RPC sockets.
 */

import Fastify from 'fastify';
import { Connection } from '@solana/web3.js';
import { loadConfig } from './config.js';
import { Authenticator } from './auth.js';
import { RpcSubmitter } from './submit.js';
import { registerHealth } from './routes/health.js';
import { registerShield } from './routes/shield.js';
import { registerUnshield } from './routes/unshield.js';
import { registerTransact } from './routes/transact.js';
import { registerAdapt } from './routes/adapt.js';

export async function buildServer() {
  const cfg = loadConfig();

  const fastify = Fastify({
    logger: {
      level: cfg.logLevel,
      // pino redact list: never emit auth headers or anything that smells of keys.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers["x-api-key"]',
          'req.headers.cookie',
        ],
        remove: true,
      },
    },
    bodyLimit: 256 * 1024, // 256 KB; ix data + base64 < 4 KB even for /relay/adapt
    disableRequestLogging: false,
    trustProxy: true,
  });

  const connection = new Connection(cfg.rpcUrl, 'confirmed');
  const auth = new Authenticator(cfg);
  const submitter = new RpcSubmitter({
    connection,
    relayer: cfg.keypair,
    maxTxSize: cfg.maxTxSize,
    jitoBundleUrl: cfg.jitoBundleUrl,
  });

  const startedAt = Date.now();
  registerHealth(fastify, {
    connection,
    relayer: cfg.keypair,
    poolProgramId: cfg.poolProgramId.toBase58(),
    startedAt,
  });
  registerShield(fastify, { cfg, auth, submitter });
  registerUnshield(fastify, { cfg, auth, submitter });
  registerTransact(fastify, { cfg, auth, submitter });
  registerAdapt(fastify, { cfg, auth, submitter });

  fastify.log.info(
    {
      relayerPubkey: cfg.keypair.publicKey.toBase58(),
      poolProgramId: cfg.poolProgramId.toBase58(),
      adapterCount: cfg.adapterAllowlist.length,
      jito: !!cfg.jitoBundleUrl,
      authEnabled: cfg.authEnabled,
    },
    'relayer initialised',
  );

  return { fastify, cfg };
}

async function main(): Promise<void> {
  const { fastify, cfg } = await buildServer();

  const shutdown = async (signal: string): Promise<void> => {
    fastify.log.info({ signal }, 'shutdown requested');
    try {
      await fastify.close();
    } catch (e) {
      fastify.log.error({ err: (e as Error).message }, 'shutdown error');
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await fastify.listen({ port: cfg.port, host: cfg.host });
  } catch (err) {
    fastify.log.error({ err: (err as Error).message }, 'listen failed');
    process.exit(1);
  }
}

const argv1 = process.argv[1] ?? '';
const isEntry =
  // direct invocation: `node dist/index.js` or `tsx src/index.ts`
  import.meta.url === `file://${argv1}` ||
  argv1.endsWith('/relayer/src/index.ts') ||
  argv1.endsWith('/relayer/dist/index.js');

if (isEntry) {
  void main();
}
