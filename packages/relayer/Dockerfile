# Single-stage Node 20-alpine image. Build runs against the workspace root so
# the relayer's workspace deps (@b402ai/solana, @b402ai/solana-shared) resolve.
#
# Build context expects to be the repo root, NOT packages/relayer:
#   docker build -f packages/relayer/Dockerfile -t b402-solana-relayer .

FROM node:20-alpine

ENV NODE_ENV=production
ENV NODE_OPTIONS="--enable-source-maps --dns-result-order=ipv4first"

RUN apk add --no-cache tini && corepack enable

WORKDIR /app

# Install all workspace deps so the relayer can resolve workspace:* links.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/prover/package.json packages/prover/
COPY packages/sdk/package.json packages/sdk/
COPY packages/relayer/package.json packages/relayer/

# pnpm v9 honours the workspace and only fetches what's needed.
RUN pnpm install --frozen-lockfile --prod=false

# Copy sources and build everything the relayer transitively needs.
COPY packages/shared packages/shared
COPY packages/prover packages/prover
COPY packages/sdk packages/sdk
COPY packages/relayer packages/relayer

RUN pnpm --filter=@b402ai/solana-shared build \
 && pnpm --filter=@b402ai/solana-prover build \
 && pnpm --filter=@b402ai/solana build \
 && pnpm --filter=@b402ai/solana-relayer build

# Drop dev deps for a leaner runtime layer.
RUN pnpm install --frozen-lockfile --prod

EXPOSE 8080

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "packages/relayer/dist/index.js"]
