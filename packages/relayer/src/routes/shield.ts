import type { FastifyInstance } from 'fastify';
import { registerRelayRoute, type RelayRouteDeps } from './relay.js';

export function registerShield(fastify: FastifyInstance, deps: RelayRouteDeps): void {
  registerRelayRoute(fastify, {
    path: '/relay/shield',
    label: 'shield',
    minIxDataLen: 480,
    maxIxDataLen: 1500,
    requiresAdapterAllowlist: false,
  }, deps);
}
