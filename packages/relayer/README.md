# @b402ai/solana-relayer

HTTP relayer for the b402-solana shielded pool. The user constructs and proves a
shield/unshield/transact/adapt instruction client-side, then POSTs the
ix-data + account list to this service. The relayer becomes the fee payer +
signer, breaking the link between the on-chain transaction's payer and the
user's identity wallet.

## What this does NOT do

- **No proof generation server-side.** All ZK proofs are produced by the client
  with `@b402ai/solana-prover`. The relayer only forwards bytes.
- **No note custody.** The relayer never sees note randomness, viewing keys,
  or spending keys.
- **No MEV extraction.** The relayer signs and submits exactly what the
  client asked for, after policy checks. There is no reordering, sandwiching,
  or selective censorship.

## Quick start

```bash
# from repo root
pnpm install
pnpm --filter=@b402ai/solana-relayer build

export RPC_URL=https://api.devnet.solana.com
export RELAYER_KEYPAIR=$HOME/.config/solana/relayer.json
export POOL_PROGRAM_ID=42a3hsCXt8WvpLB...
export PORT=8080

pnpm --filter=@b402ai/solana-relayer dev
# or:  node packages/relayer/dist/index.js
```

```bash
curl -s http://localhost:8080/health | jq
# { "ok": true, "relayerPubkey": "...", "relayerLamports": 1234567890, "rpcSlot": 308912233, ... }
```

## Configuration

| env | required | default | meaning |
|---|---|---|---|
| `RPC_URL` | yes | — | Solana JSON-RPC. Use Helius/Triton for mainnet. |
| `RELAYER_KEYPAIR` | yes | — | Path to a Solana JSON keypair (64-byte array). |
| `POOL_PROGRAM_ID` | yes | — | Whitelisted pool program (`b402-pool`). |
| `JUPITER_ADAPTER_ID` | no | — | Allowed adapter for `/relay/adapt`. |
| `MOCK_ADAPTER_ID` | no | — | Devnet test adapter. |
| `EXTRA_ADAPTER_IDS` | no | — | Comma-sep extra adapter pubkeys. |
| `JITO_BUNDLE_URL` | no | plain RPC | Switches submit to Jito sendBundle. |
| `MIN_FEE_LAMPORTS` | no | `0` | Reject txs whose proof-bound `relayer_fee` is below this. |
| `API_KEY_FILE` | no | `""` (auth off) | Path to JSON `{ "<keyId>": { rateLimitPerMin, tokenAllowlist? } }`. |
| `PORT` | no | `8080` | Listen port. |
| `HOST` | no | `0.0.0.0` | Bind addr. |
| `LOG_LEVEL` | no | `info` | pino level. |

### API-key file

```json
{
  "kp_3f9b1a2c0d4e6f78": { "rateLimitPerMin": 30, "label": "client-a" },
  "kp_a1b2c3d4e5f60718": {
    "rateLimitPerMin": 5,
    "tokenAllowlist": ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"]
  }
}
```

Pass via `Authorization: Bearer kp_3f9b1a2c0d4e6f78` or `x-api-key: ...`.

## Endpoints

All relay endpoints share one body shape and one response shape.

### Request

```ts
POST /relay/{shield|unshield|transact|adapt}
Content-Type: application/json
Authorization: Bearer <api-key>

{
  "ixData": "<base64 of full Anchor ix data — discriminator + Borsh args>",
  "accountKeys": [
    { "pubkey": "<base58>", "isSigner": true,  "isWritable": true  },
    { "pubkey": "<base58>", "isSigner": false, "isWritable": false }
  ],
  "altAddresses": ["<base58>"],
  "computeUnitLimit": 1400000,
  "userSignature": "<optional base64 64-byte ed25519 sig>",
  "userPubkey":    "<optional base58>"
}
```

The first `accountKeys` entry **must** be marked `isSigner=true, isWritable=true`
— that's the pool's `relayer: Signer` slot. The relayer overwrites the pubkey
in that slot with its own, regardless of what the client sent.

### Response (200)

```json
{
  "signature": "5VkKL...",
  "slot": 308912240,
  "confirmedAt": "2026-04-24T12:34:56.000Z"
}
```

### Errors (RFC 7807)

```http
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json

{
  "type": "https://b402.ai/errors/fee_too_low",
  "title": "fee_too_low",
  "status": 400,
  "detail": "relayer_fee 5000 below floor 10000",
  "got": "5000",
  "min": "10000"
}
```

## Trust model

The relayer enforces these checks before signing:

1. **Pool program whitelist.** All forwarded ix data is for `POOL_PROGRAM_ID`.
2. **Adapter allowlist** for `/relay/adapt` — at least one adapter pubkey from
   `JUPITER_ADAPTER_ID` / `MOCK_ADAPTER_ID` / `EXTRA_ADAPTER_IDS` must be in
   `accountKeys`.
3. **Fee floor.** Reads `relayer_fee: u64` at offset 476 in the ix data (the
   value the proof binds via `relayer_fee_bind`) and rejects below
   `MIN_FEE_LAMPORTS`.
4. **Tx size cap.** Serialised v0 tx ≤ 1232 bytes (Solana's hard limit).
5. **Per-API-key rate limit.** Sliding 60-second window, default 10/min.
6. **No PII in logs.** `Authorization`/`x-api-key` headers are redacted by pino.

The relayer trusts the client's `accountKeys` list otherwise — Anchor account
constraints in the pool catch any malformed assembly.

## Production

### Docker

```bash
docker build -f packages/relayer/Dockerfile -t b402-solana-relayer .
docker run --rm \
  -e RPC_URL=$RPC_URL \
  -e POOL_PROGRAM_ID=$POOL_PROGRAM_ID \
  -e RELAYER_KEYPAIR=/secrets/relayer.json \
  -e API_KEY_FILE=/secrets/api-keys.json \
  -v $HOME/.config/solana:/secrets:ro \
  -p 8080:8080 \
  b402-solana-relayer
```

### Cloud Run

Set:
- `--no-cpu-throttling --cpu-boost` (RPC/SSE flows hate throttling)
- `NODE_OPTIONS=--dns-result-order=ipv4first` (Helius/Triton sometimes resolve to v6 first, breaking outbound)
- `--min-instances=1` (cold starts cost ~3s for web3.js + fastify)

## Curl recipes

### Shield (devnet)

The exact `ixData` payload is produced by `@b402ai/solana` — you don't hand-build it.
See `examples/swap-e2e.ts` for the full flow, but the relayer-side call looks like:

```bash
curl -s -X POST http://localhost:8080/relay/shield \
  -H "authorization: Bearer kp_3f9b1a2c0d4e6f78" \
  -H "content-type: application/json" \
  -d @shield-payload.json | jq
```

`shield-payload.json` is the JSON body shown above; produce it from your
client by base64-encoding the `ixData` Buffer the SDK builds and serialising
the `keys` array of the `TransactionInstruction`.

## Tests

```bash
pnpm --filter=@b402ai/solana-relayer test
```

Tests cover auth + rate limiting, request validation + fee extraction, and
tx assembly with a stubbed Connection. The optional integration test against
`solana-test-validator` is gated behind `RELAYER_INT=1` and is not part of
the default run.
