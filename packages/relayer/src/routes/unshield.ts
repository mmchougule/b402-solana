import type { FastifyInstance } from 'fastify';
import { registerRelayRoute, type RelayRouteDeps } from './relay.js';

export function registerUnshield(fastify: FastifyInstance, deps: RelayRouteDeps): void {
  registerRelayRoute(fastify, {
    path: '/relay/unshield',
    label: 'unshield',
    minIxDataLen: 480,
    maxIxDataLen: 1500,
    requiresAdapterAllowlist: false,
  }, deps);
}
