# paysh-demo-server

Deployable demo — single Node process running an x402-gated `/weather/{city}` endpoint backed by `@b402ai/paysh-shield`. Every USDC payment that lands at the operator's USDC ATA is auto-shielded into a b402 note.

## Architecture

- HTTP server (Node `http`): `/weather/{city}` (402-gated), `/openapi.json`, `/healthz`.
- Long-lived `PayshShield`: `Connection.onLogs` on the operator's USDC ATA → SDK `shield()`.
- Single `Connection` shared by the HTTP path and the shield.

## Deploy on Railway

From the monorepo root:

```bash
# 1. Fund the demo operator wallet on mainnet (~0.05 SOL one-time + ongoing
#    ~5000 lamports per shielded payment). Operator pubkey is the address
#    of the keypair you'll bind to B402_OPERATOR_KEYPAIR_BASE64.

# 2. Create the Railway project (run from monorepo root)
railway init

# 3. Set secrets
railway variables --set "RPC_URL=https://mainnet.helius-rpc.com/?api-key=<key>"
railway variables --set "B402_OPERATOR_KEYPAIR_BASE64=$(cat /path/to/operator.json | base64)"
railway variables --set "CLUSTER=mainnet"

# 4. Deploy
railway up
```

Railway routes traffic on `PORT` (auto-injected). The Dockerfile listens on `0.0.0.0:${PORT:-8080}`.

## Required env

| Var | Required | Default | Notes |
|---|---|---|---|
| `RPC_URL` | yes | — | Photon-enabled (Helius / Triton). Used for both `Connection` and the SDK's nullifier validity proofs. |
| `B402_OPERATOR_KEYPAIR_BASE64` | yes | — | base64 of the keypair JSON array (output of `solana-keygen new`). |
| `CLUSTER` | no | `mainnet` | `mainnet` or `devnet`. |
| `B402_USDC_MINT` | no | per-cluster default | Override only for testing. |
| `PORT` | no | `8080` | Railway sets this automatically. |
| `B402_CIRCUITS_ROOT` | no | `/app/circuits/build` | Don't override unless mounting circuits at a different path. |

## Smoke test (deployed)

```bash
# 1. 402 challenge
curl -i https://<deploy-host>/weather/Tokyo

# 2. Pay + retry (uses the official pay CLI)
pay --mainnet curl https://<deploy-host>/weather/Tokyo

# 3. Shield logs in Railway should show:
#    [shield] shielded <txSig>… → <commitment>…
```

## Threat model on a public deploy

- The operator keypair is in container env. Treat as a hot key. Keep float small (the shield shields with ~30s latency on the worst path; SOL fees per shield ~5000 lamports).
- Helius RPC sees every payment; same trust assumption as any wallet behind a hosted RPC.
- No rate limit on `/weather/{city}` — the 402 already gates spam (each request requires a paid USDC tx). Adding rate limit is reasonable if cost spikes become an issue.
- The container's CPU usage spikes ~2s per shield (Groth16 proof generation). Memory peak ~500MB. A standard Railway plan is sufficient.
