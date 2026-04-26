import type { FastifyInstance } from 'fastify';
import { registerRelayRoute, type RelayRouteDeps } from './relay.js';

export function registerAdapt(fastify: FastifyInstance, deps: RelayRouteDeps): void {
  registerRelayRoute(fastify, {
    path: '/relay/adapt',
    label: 'adapt',
    // adapt_execute carries 23 PIs + adapter ix data + action_payload — bigger floor.
    minIxDataLen: 540,
    maxIxDataLen: 2000,
    requiresAdapterAllowlist: true,
  }, deps);
}
