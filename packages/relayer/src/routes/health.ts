/**
 * GET /health — readiness probe.
 *
 * Returns relayer pubkey, RPC slot, and the relayer wallet's lamport balance.
 * Returns 503 if RPC is unreachable so an LB can rotate the instance out.
 */

import type { FastifyInstance } from 'fastify';
import type { Connection, Keypair } from '@solana/web3.js';

export interface HealthDeps {
  connection: Connection;
  relayer: Keypair;
  poolProgramId: string;
  startedAt: number;
}

export function registerHealth(fastify: FastifyInstance, deps: HealthDeps): void {
  fastify.get('/health', async (_req, reply) => {
    try {
      const [slot, balance] = await Promise.all([
        deps.connection.getSlot('confirmed'),
        deps.connection.getBalance(deps.relayer.publicKey, 'confirmed'),
      ]);
      return reply.send({
        ok: true,
        relayerPubkey: deps.relayer.publicKey.toBase58(),
        relayerLamports: balance,
        rpcSlot: slot,
        poolProgramId: deps.poolProgramId,
        uptimeSec: Math.floor((Date.now() - deps.startedAt) / 1000),
      });
    } catch (e) {
      return reply.code(503).send({
        ok: false,
        error: 'rpc_unreachable',
        message: (e as Error).message,
      });
    }
  });
}
