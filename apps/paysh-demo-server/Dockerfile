# syntax=docker/dockerfile:1.7
# Multi-stage build: install + build + slim runtime.
# Build context is the monorepo root (set in railway.json / docker-compose).

# ─── builder ─────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder
WORKDIR /repo

# pnpm via corepack
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

# Copy lockfile + workspace declaration first for layer cache
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY packages/prover/package.json packages/prover/
COPY packages/sdk/package.json packages/sdk/
COPY packages/paysh-bridge/package.json packages/paysh-bridge/
COPY apps/paysh-demo-server/package.json apps/paysh-demo-server/
RUN pnpm install --frozen-lockfile \
  --filter @b402ai/solana-shared \
  --filter @b402ai/solana-prover \
  --filter @b402ai/solana \
  --filter @b402ai/paysh-bridge \
  --filter @b402ai/paysh-demo-server

# Source for the workspace deps + the app
COPY packages/shared packages/shared
COPY packages/prover packages/prover
COPY packages/sdk packages/sdk
COPY packages/paysh-bridge packages/paysh-bridge
COPY apps/paysh-demo-server apps/paysh-demo-server

# Build chain — order matters for type resolution
RUN pnpm --filter @b402ai/solana-shared build \
 && pnpm --filter @b402ai/solana-prover build \
 && pnpm --filter @b402ai/solana build \
 && pnpm --filter @b402ai/paysh-bridge build \
 && pnpm --filter @b402ai/paysh-demo-server build

# Prune to runtime-only deps for the deployable
RUN pnpm --filter @b402ai/paysh-demo-server deploy --prod /out

# ─── runtime ─────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# App code + pruned node_modules
COPY --from=builder /out /app

# Circuit artifacts — required by the SDK's Groth16 prover
COPY --from=builder /repo/circuits/build /app/circuits/build
ENV B402_CIRCUITS_ROOT=/app/circuits/build

# Drop privileges
USER node

EXPOSE 8080
CMD ["node", "dist/server.js"]
