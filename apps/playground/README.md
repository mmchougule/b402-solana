# @b402ai/playground

Landing page + (eventually) hosted devnet playground for b402-solana.

## Status

**Tonight (v0):** static landing page that explains what b402 is and points at `create-b402-agent` for local trial. Shippable to Vercel.

**Roadmap (v1):** click-through devnet flow — create ephemeral session keypair, shield USDC, swap, unshield. Requires session isolation, prover artifact hosting, and rate-limiting, all of which are intentionally deferred to a proper sprint.

## Run locally

```bash
pnpm install
pnpm dev
# → http://localhost:3000
```

## Deploy

Vercel deploy not yet wired. When it is, only the landing page is in scope until v1 — the playground itself runs against b402's deployed devnet pool, but the click-through flow needs server-side SDK execution which has its own design constraints (cold starts, circuit wasm size, ephemeral keypair lifecycle) that haven't been resolved.
