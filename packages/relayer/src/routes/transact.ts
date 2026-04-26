import type { FastifyInstance } from 'fastify';
import { registerRelayRoute, type RelayRouteDeps } from './relay.js';

export function registerTransact(fastify: FastifyInstance, deps: RelayRouteDeps): void {
  registerRelayRoute(fastify, {
    path: '/relay/transact',
    label: 'transact',
    minIxDataLen: 480,
    maxIxDataLen: 1500,
    requiresAdapterAllowlist: false,
  }, deps);
}
