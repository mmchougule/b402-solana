# @b402ai/paysh-bridge

Auto-shielding watcher for x402 / [pay.sh](https://pay.sh) providers on Solana.

An x402 provider declares a `payTo` wallet in every 402 challenge it serves. With this package, that `payTo` is an ingress address that the bridge subscribes to over RPC; each incoming USDC transfer is converted into a shielded note in the b402-solana pool. The provider unshields to whatever address it wants, whenever it wants — there is no on-chain edge from the receivable to the spend.

Designed to drop in next to an existing x402 server. No protocol changes, no payer-side changes.

## What it does

```
  payer ──USDC SPL transfer──▶ ingress ATA  (visible — same as today's x402)
                                    │
                            paysh-bridge watcher
                                    │ B402Solana.shield()
                                    ▼
                             shielded note in pool
                                    │
                                    │ provider unshield(), anytime, any address
                                    ▼
                              fresh recipient wallet
                              (no on-chain link to payer)
```

## What it hides

- Link from `ingress → spend wallets`. ZK-enforced break in the deposit→withdraw graph.
- Amounts of subsequent shielded operations (private swap, second unshield).
- Owner spending key (Poseidon-committed inside the note).

## What it does not hide

- The `payer → ingress` SPL transfer. Plaintext, on-chain, attributable to the payer.
- The shield instruction's `publicAmountIn` field — equal to the deposit amount and visible on chain. Amount privacy applies only to operations after the shield.
- The `payTo` itself, which is published in every 402 challenge and the pay-skills catalog. Long-term observers can graph all incoming volume.
- Without the b402 hosted relayer wired, the unshield tx is fee-paid by the operator's wallet; the recipient is still unlinkable to the payer, but the operator pubkey appears as fee payer. With the hosted relayer (`B402_RELAYER_HTTP_URL`) configured on the SDK, the operator does not appear on the unshield tx.

## Install

```bash
pnpm add @b402ai/paysh-bridge @b402ai/solana @solana/web3.js
```

## Library API

```ts
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { B402Solana } from '@b402ai/solana';
import { PayshBridge, makeSdkShieldFn } from '@b402ai/paysh-bridge';

const operator = /* operator Keypair */;
const mint = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'); // USDC
const conn = new Connection(process.env.RPC_URL!, 'confirmed');

const b402 = new B402Solana({
  cluster: 'mainnet',
  rpcUrl: process.env.RPC_URL!,
  keypair: operator,
  proverArtifacts: { wasmPath: '...', zkeyPath: '...' },
});

const bridge = new PayshBridge({
  connection: conn,
  ingressOwner: operator.publicKey,
  ingressAta: getAssociatedTokenAddressSync(mint, operator.publicKey),
  shield: makeSdkShieldFn(b402, mint),
});

bridge.on((evt) => {
  if (evt.name === 'shielded') console.log('shielded', evt.txSig, evt.commitment);
  if (evt.name === 'failed')   console.error('shield failed', evt.txSig, evt.error);
});

await bridge.start();
// In your x402 server, declare payTo = bridge.payTo()
```

### x402 helpers

```ts
import {
  buildPaymentRequired,
  decodePaymentHeader,
  verifyPayment,
  SOLANA_NETWORKS,
} from '@b402ai/paysh-bridge';

// In your 402 handler:
res.statusCode = 402;
res.end(JSON.stringify(buildPaymentRequired([{
  scheme: 'exact',
  network: SOLANA_NETWORKS.mainnet,
  asset: 'usdc',
  payTo: bridge.payTo(),
  amount: '1000', // smallest units
}])));

// On retry with X-PAYMENT:
const result = await verifyPayment(decodePaymentHeader(req.headers['x-payment']!), {
  connection: conn, mint, payTo: operator.publicKey, expectedAmount: 1000n,
});
if (!result.ok) { res.statusCode = result.status; res.end(result.error); return; }
// settle the resource
```

## Threat model

| Threat | Status |
|---|---|
| Bridge process compromise | Operator's keypair is held in process memory to sign shield instructions (the SPL transfer authority must be the depositor — a Solana-level constraint). An attacker with that key can drain unshielded float (USDC sitting in the operator's ATA between settlement and shield) and forge spend proofs for any shielded note. Mitigation: keep the float interval small (default reconciler heartbeat is 30s), run the bridge under standard hot-key hygiene (memory-scoped, no swap), or wait for the sponsored-shield path that removes the in-process key. |
| RPC provider observability | The bridge subscribes to its ingress ATA via `Connection.onLogs`. The RPC provider sees every payment as it arrives — same surface as any wallet using a third-party RPC. Choose a provider you'd trust to host an active wallet. |
| Replay / double-shield | Reconciler dedupes by `txSig`. The pluggable `BridgeStore` interface persists state across restarts; the in-memory store is for tests only — supply a SQLite or Postgres impl in production. |
| Failure during shield | Reconciler retries with exponential backoff (1s, 2s, 4s … capped at `maxDelayMs`), gives up at `maxAttempts` (default 5) and emits a `failed` event for operator alerting. Receivable USDC is unaffected — it stays in the ingress ATA awaiting manual recovery. |
| Public ingress correlation | The ingress wallet pubkey is published in the provider's PAY.md and in every 402 challenge. Anyone watching the chain can attribute all incoming volume to that operator. The bridge does not address payer-side or amount-on-deposit privacy. |

## Limitations

- v1 ships a single long-lived ingress per operator. Per-payment rotated stealth addresses are tracked as a follow-up.
- Shield latency is on the order of 1–3 seconds (proof gen + Merkle append). Resource serving in the x402 handler does not wait for shield — it returns 200 as soon as the SPL transfer confirms; shielding happens asynchronously.
- The persisted `BridgeStore` ships only in-memory in this release. SQLite is on the roadmap.
- Only `scheme: "exact"` and `asset: "usdc"` are handled. Other x402 schemes / assets are not parsed.

## Examples

- `examples/paysh-private-receivables-e2e.ts` — end-to-end on devnet with a fresh test SPL token. Demonstrates the bridge lifecycle without an HTTP layer.
- `examples/paysh-x402-real-usdc-e2e.ts` — end-to-end with USDC over an x402 HTTP server in-process.
- `examples/paysh-x402-server-only.ts` — long-running server for conformance testing against external clients (curl, the `pay` CLI).

## License

Apache-2.0.
