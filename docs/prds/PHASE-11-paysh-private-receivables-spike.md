# PHASE-11 Spike — pay.sh Private Receivables

**Status:** Spike notes (pre-PRD).
**Date:** 2026-05-05.
**Branch:** `phase-11/paysh-private-receivables`.
**Author:** Claude (driven by @mayur).
**Goal of spike:** before drafting PRD-25, establish the *actual* x402 wire format pay.sh uses, the provider-registry contract, and where b402-solana's shielded pool can plug in without requiring upstream changes.

---

## 1. What pay.sh actually is

A CLI (`pay`) and gateway/registry built around **HTTP 402** payments. Two protocols are spoken: **x402** (per-call payment proofs) and **MPP** (charge/session proofs). The CLI ships clients (`pay curl`, `pay fetch`, `pay claude`, `pay codex`, `pay mcp`), wallets (`pay account`, including `pay account solana`), and a server runtime (`pay server`).

Recent — appears to be a **Solana Foundation** initiative. The provider registry is the public GitHub repo `solana-foundation/pay-skills`. Catalog is auto-built from there.

## 2. The x402 wire format (verified empirically)

Pulled from a live provider spec (`https://storage.googleapis.com/pay-skills/v1/providers/agentmail/email.json`), the `openapi_doc.accepts[]` array is the canonical x402 challenge body:

```jsonc
"accepts": [
  {
    "amount": "1",                       // smallest-unit string (USDC has 6 dp → "1" = 1 micro-USDC)
    "asset":  "usdc",
    "extra":  {},
    "maxTimeoutSeconds": 300,
    "network": "eip155:8453",            // CAIP-2 chain id
    "payTo":  "0x6e3184C204e596dED89E8A5693B602097F4Ab687",
    "scheme": "exact"
  },
  {
    "amount": "1",
    "asset":  "usdc",
    "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    "payTo":   "7r4e5dwNS68MDaxbw7N8jbzHq7RCMBp9z6smHFH4NXWw",
    "scheme":  "exact"
  }
]
```

Key facts established by the spike:
- `network` is **CAIP-2** style; Solana mainnet appears as `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` (genesis-hash prefix).
- `asset` is `usdc` (lowercase string, not a mint pubkey). The mint is implicit from `(network, asset)`. Solana mainnet USDC ⇒ `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`.
- `payTo` is a **single bare base58 pubkey** on Solana. There is no recipient-set, no facilitator field, no scheme-extension hook visible in this object.
- `scheme: "exact"` is the only string observed in production today.
- The provider may declare multiple `accepts` entries — the client picks one network/asset combo it can pay on.

## 3. The provider-registry contract

- **Source of truth:** GitHub repo `solana-foundation/pay-skills`, path `providers/<operator>/<name>/PAY.md`.
- **PAY.md format:** YAML frontmatter (`name`, `title`, `description`, `category`, `service_url`, `openapi.url`, `use_case`) + free-form markdown body for agent guidance. Verified by fetching `providers/agentmail/email/PAY.md` raw.
- **Catalog publishing:** the registry CI snapshots specs into `https://storage.googleapis.com/pay-skills/v1/providers/<fqn>.json`, which composes the YAML frontmatter with the upstream service's OpenAPI doc (where the actual `accepts[]` per route lives).
- **No `payTo` in the YAML.** That field is served live by the operator's own service in the 402 response. Implication: anyone who wants to set a custom `payTo` must operate the service themselves; the registry only routes to it.

## 4. Where privacy is missing today

In the wire format, every Solana payment exposes:
- `payTo` (operator's USDC token-account owner) — visible in the registry/catalog forever.
- The payer's wallet (signer of the SPL transfer) — visible on-chain.
- The link `(payer → operator)` — trivially graphable from a single tx.

The protocol has **no slot for a shielded scheme**: no `scheme: "shielded"`, no `extra.encryptedTo`, no facilitator that could substitute a ZK proof for a public transfer. Adding one requires upstream work.

## 5. The contribution shape that requires zero upstream changes

We can deliver privacy *for the operator* today, without modifying pay.sh, by treating `payTo` as a **stealth ingress address** controlled by an auto-shielding watcher:

```
  payer ──USDC SPL transfer──▶  ingress (stealth pubkey)
                                    │
                            watcher (off-chain)
                                    │ b402-solana SDK shield()
                                    ▼
                              shielded pool note
                                    │
                                    │ operator unshield() at will, to a fresh address
                                    ▼
                            operator's true wallet
```

Properties this gives us:
- **Operator's main wallet never appears in the registry or on-chain.** Only the ingress does.
- **Per-payer linkage is preserved on the deposit leg** (payer → ingress is public, same as before), but the **operator side is fully unlinkable** — the unshield can land anywhere, anytime, and is signed/paid by the b402 hosted relayer.
- **No protocol changes.** From pay.sh's vantage point this is just a normal x402 `exact` payment to a normal Solana address. Verifier passes. Registry passes.

What this is *not* (called out so we don't oversell):
- Not payer privacy. The payer's wallet is still on the deposit tx.
- Not unobservable to the operator's watcher (it sees every incoming amount). But the shielded pool gives unlinkability *between operator deposits and operator spends*, which is the receivable side.
- Not a substitute for an upstream `scheme: "shielded"` — that remains a separate, larger ask.

## 6. Open design questions (resolve in PRD-25)

1. **Ingress identity:** single long-lived ingress per operator, or per-payment rotated stealth addresses? Single ingress is simpler; rotation would unlink payments from each other in the catalog audit but adds key management.
2. **Shielding trigger:** `WebSocket logsSubscribe` to the ingress ATA, or polling `getSignaturesForAddress`? Subs are tighter; polling tolerates flaky RPC.
3. **Shielding signer:** the ingress needs to *sign the shield instruction* (since shield is the one b402 op that requires the depositor's signature). Either (a) ingress keypair stays hot in the watcher, or (b) we add a "sponsored shield" path where the ingress is the depositor but the relayer pays. (b) is more work and may need program changes — push to v2 in PRD if non-trivial.
4. **Operator UX:** how does the operator see balances and unshield? Likely the existing b402-solana MCP server pointed at the operator's viewing key. A small dashboard is bonus.
5. **Devnet vs mainnet for the e2e demo:** `pay --sandbox` uses pay.sh's hosted sandbox network (not Solana devnet). E2E test path needs to either mock the gateway or run against pay.sh's real sandbox. Spike unresolved — try sandbox first, fall back to a self-hosted gateway-less harness that posts the proof directly to the verifier.
6. **Failure modes:** what if shield fails after the ingress receives USDC? Need a reconciliation queue + retry with idempotency on (sourceTxSig).

## 7. Reusable assets we already have

- `packages/sdk` — `shield()`, `unshield()`, `Scanner`, `NoteStore`. Drop-in for the watcher.
- `packages/relayer` — hosted gasless relayer for unshield. Already mainnet-alpha.
- `packages/mcp-server` — operator-side surface (status, balance, unshield) is already an MCP server.
- Existing `examples/` pattern (`mainnet-smoke.ts`, `swap-e2e-jupiter.ts`) — gives us a template for the e2e harness.

## 8. Recommended next step

Lock the design in **PRD-25 — pay.sh Private Receivables Bridge** (next free number; PRD-24 is the last drafted). PRD-25 should answer the six open questions, define the package layout (likely `apps/paysh-bridge` + `examples/paysh-private-receivables-e2e.ts`), and specify the TDD plan (unit tests on the shield-trigger logic, property tests on idempotency, e2e against pay.sh sandbox).

No code lands until PRD-25 is signed off, per repo convention.

---

## Appendix A — sandbox call surface verified

- Catalog (live): `GET https://pay.sh/api/catalog` → JSON, 75 providers as of spike date.
- Provider spec (live): `GET https://storage.googleapis.com/pay-skills/v1/providers/<fqn>.json`.
- Source provider markdown: `https://github.com/solana-foundation/pay-skills/blob/main/providers/<fqn>/PAY.md`.
- Install path (per docs): `brew install pay`. Not installed locally during spike — verified docs only.

## Appendix B — what we did NOT verify in this spike

- The exact 402 response body served live by an x402 provider (we read the catalog snapshot, not a real 402 over the wire).
- The exact proof header format the gateway expects on retry (docs reference "machine-readable payment requirements" and "payment proof headers" but don't quote field names; will be observed during PRD-25 implementation by running `pay --sandbox curl` against agentmail or a self-hosted endpoint).
- Whether `extra: {}` accepts free-form fields a custom scheme could use. Observed empty in all current providers.
