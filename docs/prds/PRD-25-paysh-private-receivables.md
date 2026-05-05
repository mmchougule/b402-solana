# PRD-25 — pay.sh Private Receivables Bridge

**Status:** Signed Off — Locked (2026-05-05, @mayur).
**Depends on:** PRD-06 (SDK), PRD-22 (bonded relayer — only the hosted-relayer surface, not the bonded variant).
**Spike:** [`PHASE-11-paysh-private-receivables-spike.md`](./PHASE-11-paysh-private-receivables-spike.md). Read first.
**Branch:** `phase-11/paysh-private-receivables`.

## 1. Problem

Today an x402 / pay.sh provider on Solana publishes its receivables address (`payTo`) in clear text. Every payment is graphable: payer wallet → operator wallet, in perpetuity, in a public registry. For any operator with even mild OPSEC needs (revenue privacy, anti-targeting, competitor intelligence) this is a non-starter.

pay.sh has no `scheme: "shielded"` slot in the wire format, no facilitator-plugin API, and no near-term roadmap (per spike) to add one.

## 2. Goal

Ship a **drop-in privacy layer for x402 operators on Solana** that requires **zero changes to pay.sh, no changes to the b402-solana on-chain program, and no changes to existing x402 clients**. The operator gets unlinkable receivables. The payer experience is identical.

This is also the first concrete public showcase of b402-solana's value beyond the existing internal demos. It is the artifact we post about.

## 3. Non-goals

- Payer privacy. The payer's wallet remains on the deposit tx. Out of scope.
- A new x402 scheme. Pursued separately as an upstream RFC, not blocking this PRD.
- Bonded-relayer integration (PRD-22). The hosted relayer is sufficient for v1 of this bridge.
- Multi-operator shared ingress. v1 is one-ingress-per-operator; sharing is a v2.
- A hosted SaaS. v1 is a runnable example + library; operators run their own watcher.

## 4. Users and value

| Actor | Today | After PRD-25 |
|---|---|---|
| Operator (provider) | Wallet exposed in registry; every payment publicly attributable | Stealth ingress in registry; payments shielded; spends unlinkable |
| Payer | Pays USDC to operator's wallet | Pays USDC to operator's stealth ingress — **identical UX, no extra steps** |
| pay.sh gateway | Verifies SPL transfer to `payTo` | Same path; no protocol awareness of shielding required |
| Agent (Claude/Codex via `pay mcp`) | No change | No change; can additionally pair with our existing b402-solana MCP for shield-side ops |

## 5. Architecture

```
                                   ┌──────────────────────────────────┐
                                   │  Operator's HTTP service          │
       pay --sandbox curl ◀──402───│  (Express/Fastify) — returns      │
       <our-service>/api/...       │  accepts:[{network: solana,       │
                                   │  payTo: <stealth-ingress>, ...}]  │
                                   └─────────────┬────────────────────┘
                                                 │
                                       payer SPL transfer USDC
                                                 ▼
                              ┌────────────────────────────────────────┐
                              │  Stealth ingress (Solana keypair)       │
                              │  ATA holds incoming USDC                │
                              └─────────────┬──────────────────────────┘
                                            │
                                  ┌─────────▼──────────┐
                                  │  paysh-bridge      │  (this PRD)
                                  │  watcher service   │
                                  │   • subscribes RPC │
                                  │   • dedupes by sig │
                                  │   • SDK shield()   │
                                  │   • signs as       │
                                  │     ingress        │
                                  └─────────┬──────────┘
                                            │  shield ix
                                            ▼
                              ┌────────────────────────────────────────┐
                              │  b402-solana shielded pool (existing)   │
                              │  Operator's viewing key sees the note   │
                              └─────────────┬──────────────────────────┘
                                            │ unshield (any time, any address)
                                            ▼
                                   Operator's spend wallet
                                   (no link back to payer)
```

### 5.1 Components

1. **`@b402ai/paysh-bridge` (new package, `packages/paysh-bridge/`):**
   - Library + thin CLI.
   - Library API:
     ```ts
     export interface BridgeConfig {
       rpc: string;
       cluster: 'devnet' | 'mainnet';
       ingressKeypair: Keypair;          // stealth address; signs shields
       operatorViewingKey: Uint8Array;    // who the shielded note is for
       mint: PublicKey;                   // USDC mainnet or devnet
       relayerUrl?: string;               // optional hosted relayer
       store: BridgeStore;                // persisted (txSig → shielded?) map
     }
     export class PayshBridge {
       constructor(cfg: BridgeConfig);
       payTo(): string;                   // base58, what the operator puts in 402 accepts[]
       start(): Promise<void>;            // subscribe + reconcile loop
       stop(): Promise<void>;
       on(event: 'shielded' | 'failed' | 'reconciled', cb: (evt: BridgeEvent) => void): void;
     }
     ```
   - CLI: `paysh-bridge run --config bridge.yaml`. Same library under the hood. Used in the e2e harness.

2. **`examples/paysh-private-receivables-e2e.ts` (new):** end-to-end test harness. Spins up:
   - A demo Express provider that 402's on `GET /weather/:city` for 0.01 USDC.
   - The bridge watcher.
   - Either `pay --sandbox curl` if installed, or a hand-rolled x402 client we already have building blocks for.
   - Asserts: payer has -0.01 USDC, ingress has 0 USDC (auto-shielded), operator has +0.01 in shielded balance, then `unshield` to a fresh wallet → fresh wallet has +0.01 USDC, no on-chain edge from payer to fresh wallet.

3. **`docs/site` page (post-build):** a 5-minute walkthrough — "How to accept private USDC payments on pay.sh in 30 lines."

### 5.2 Resolution of spike open questions

| # | Question | Decision |
|---|---|---|
| 1 | Ingress: single long-lived vs rotated per payment? | **v1 single long-lived per operator.** Rotation is a v2 (PRD-25-A) once we know operators want it. Single ingress already wins on the operator-spend side; rotation only gains payer-link unlinkability on the deposit side, which we explicitly punted. |
| 2 | Shielding trigger: WS subs vs polling? | **Both, with WS primary and polling reconciler at 30s interval.** Reconciler catches anything WS missed; idempotency dedupes. |
| 3 | Shielding signer | **v1: ingress keypair stays hot in the watcher process.** Document threat model clearly: an attacker with the ingress key can drain *unshielded* balance (i.e. funds that arrived in the last <30s before being shielded), nothing more. v2 considers a sponsored-shield path that does not require the ingress to sign the SPL transfer. |
| 4 | Operator UX | **Reuse existing `@b402ai/solana-mcp`** for read + unshield. The bridge does not duplicate that surface. |
| 5 | Sandbox harness | **e2e runs in two modes:** (a) "stub" — local Solana validator + a fake gateway that just calls our verifier loop; (b) "real" — against `pay --sandbox` if `pay` is on `$PATH`. CI runs (a); manual demo runs (b). |
| 6 | Failure-mode reconciliation | **Persisted `BridgeStore`** keyed by `(ingress, txSig)` with state `seen | shielding | shielded | failed`. Retries with exponential backoff on `failed`, capped at 5 attempts then alerts. SQLite via `better-sqlite3` for v1; pluggable interface so operators can swap. |

## 6. TDD plan

Per CLAUDE.md and PRD-07, every component lands with tests first.

### 6.1 Unit (Vitest, in `packages/paysh-bridge/src/__tests__`)

| Test | Subject |
|---|---|
| `payTo() returns ingress base58` | trivial sanity |
| `dedupe by txSig — second call to handle() is a no-op` | idempotency |
| `failed shield is retried with backoff` | retry policy |
| `failed >5 times → state = failed and event emitted` | giveup contract |
| `unknown mint transfer ignored` | accepts only configured mint |
| `amount=0 ignored` | edge |
| `multiple instructions in one tx — only USDC-to-ingress counted` | parsing correctness |
| `BridgeStore round-trips state` | store contract |

### 6.2 Property tests (fast-check)

- For any sequence of `(seen, shielding, shielded, failed)` events on the same `txSig`, the final state is one of `{shielded, failed}` and the number of shield calls is bounded.
- For any interleaving of WS and reconciler events, no `txSig` is shielded twice.

### 6.3 Integration (against `solana-test-validator`)

- Bring up local validator with USDC mock mint and the b402 program deployed.
- Fund a payer keypair, fund the ingress for SOL.
- Wire bridge → SDK against the local validator.
- Test: 5 sequential payments → 5 shielded notes → operator unshield → balance correct.
- Test: 3 concurrent payments → exactly 3 shielded notes (not 6, not 2).
- Test: kill bridge mid-shield → restart → reconciler completes the in-flight one.

### 6.4 End-to-end (`examples/paysh-private-receivables-e2e.ts`)

The full demo flow. Runs in CI under stub mode; runs locally against pay.sh sandbox under `--real` flag.

## 7. Acceptance criteria

PRD-25 is "done" when all of the following hold:

1. `apps/paysh-bridge` compiles, all unit + property + integration tests green in CI.
2. e2e example runs end-to-end on `solana-test-validator` in under 60s.
3. e2e example, run against pay.sh sandbox manually, completes a real 402 → payment → shield → unshield round trip and the recorded shielded amount equals the payment minus protocol fee (0).
4. Operator never appears on chain in the deposit-side path. Verified by parsing all txs in the e2e and asserting the operator's main wallet pubkey is not in any account-list.
5. README in `packages/paysh-bridge` documents: install, configure, run, threat model, limitations.
6. Blog-post draft committed under `docs/blog/2026-paysh-private-receivables.md`. Not published from this PR.

## 8. Out-of-scope follow-ups

- **PRD-25-A:** rotated stealth ingress (per-payment).
- **PRD-25-B:** sponsored shield (ingress does not need a keypair; relayer signs).
- **Upstream RFC:** propose a `scheme: "shielded-solana"` to pay.sh, with `extra.shieldedTo` carrying a viewing-key commitment instead of a pubkey. Tracked outside this repo.
- **Operator dashboard:** a small Next.js app reading the `@b402ai/solana-mcp` surface. Bonus, not blocking.

## 9. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| pay.sh sandbox rejects a payTo that isn't a USDC ATA owner with prior history | Low | Verify in spike before implementation; if rejected, pre-create the ingress ATA and prefund SOL |
| Shielding latency > 402 timeout (300s) is irrelevant (verifier checks the deposit, not the shield) but operator-side balance lags | Low | Acceptable; document. The payer is already paid the moment the SPL transfer lands |
| Ingress key compromise drains unshielded float | Medium | Keep float small; reconciler shields aggressively; document; future PRD-25-B removes the key |
| pay.sh adds a real `scheme: "shielded"` next month and obsoletes this | Medium | We propose that RFC ourselves; this bridge is the working proof that motivates it |

## 10. Review process

- @mayur signs off this PRD before code lands.
- Spike doc is the audit trail for assumptions; if any assumption breaks during implementation, update the spike, then update this PRD's Revision History, then continue.
- Per repo convention: this PRD must be **Signed Off → Locked** before merging code into `main`.

## Revision history

- 2026-05-05: Initial draft. Ready for review.
- 2026-05-05: Signed Off — Locked. Package location set to `packages/paysh-bridge`.
