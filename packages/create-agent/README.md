# @b402ai/create-agent

Scaffold a private-DeFi agent on Solana in one command.

```bash
npx @b402ai/create-agent my-agent
cd my-agent
cp .env.example .env  # edit B402_KEYPAIR_PATH
pnpm install
pnpm dev
```

Generates a working template that runs `shield → tail_notes → unshield` against b402's devnet pool — three real transactions printed with Solana Explorer URLs.

## Status

Spike. Not yet published to npm — clone the repo and run `node dist/index.js <name>` to test.
