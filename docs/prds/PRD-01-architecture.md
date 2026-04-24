# PRD-01 — Protocol Architecture & Design Decisions

| Field | Value |
|---|---|
| **Status** | Draft — awaiting review |
| **Owner** | b402 core |
| **Date** | 2026-04-23 |
| **Version** | 0.1 |
| **Gates** | PRDs 02–08 |

## 0. How to read this document

This PRD locks the non-reversible design decisions for the b402 Solana shielded pool. Every decision is stated together with the alternatives considered and the reason the alternative was rejected. Anything that can be changed post-launch (parameters, fee policy, adapter set) is marked "soft." Anything that cannot be changed post-launch without migrating user funds or breaking UTXOs is marked "hard."

All **hard** decisions are the ones auditors will scrutinize. Change them only with an explicit amendment and fresh audit.

---

## 1. Executive summary

b402-solana is a shielded asset pool + composable private DeFi execution layer on Solana mainnet. It mirrors the design of the b402 Railgun fork deployed on Base, Arbitrum, and BSC, ported to Solana's account model and CPI semantics.

**What users can do:**
1. **Shield** SOL or supported SPL tokens into the pool, receiving a note that hides amount and identity.
2. **Unshield** any subset of notes to any Solana address, with the source notes cryptographically unlinkable from the destination.
3. **Private DeFi:** execute Jupiter swaps, Kamino lending, Drift perps, and Orca LP operations atomically from inside the pool, such that the pool is the only on-chain actor visible to the target protocol. Funds never leave shielded form at any observable point.

**How it differs from existing Solana privacy projects:**
- **Privacy.cash:** transfers only, 0.35% fee, requires CipherOwl screening, no DeFi composability.
- **Umbra/Arcium:** MPC trust model, consumer wallet UX, no SDK for agent execution, alpha mainnet.
- **Token-2022 Confidential Transfer:** ZK ElGamal program disabled pending audit; native but dormant.
- **b402-solana:** UTXO/ZK trust model matching Railgun, 0% fee, permissionless, full DeFi composability, agent-native SDK + MCP surface.

**Why this matters for agents:** autonomous agents accumulate on-chain footprints that identify strategy, holdings, and behavioral patterns. A shielded pool breaks the linkage. Paired with gasless execution, it allows agents to transact without a funded on-chain identity.

---

## 2. Goals and non-goals

### 2.1 Goals (v1)

1. Shielded custody for SOL and native USDC (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`) with production-grade cryptography.
2. Private swaps via Jupiter aggregator.
3. Private lending via Kamino Liquid Vaults.
4. Private perps via Drift V2.
5. Private LP via Orca Whirlpools.
6. Gasless execution — user signs intent, relayer pays SOL.
7. 0% protocol fee. Relayer fees deducted from the unshield amount (market-rate, user-capped).
8. TypeScript SDK (`@b402ai/solana`) with the same API surface as `@b402ai/sdk`.
9. MCP tool coverage for every SDK operation with a `chain` parameter.
10. Permissionless deployment. No KYT screening, no admin allowlist.
11. Optional opt-in disclosure: users can export a viewing key for a specific UTXO or time window to satisfy external compliance obligations without any protocol-level forced disclosure.

### 2.2 Non-goals (v1)

1. Token-2022 Confidential Transfer integration. Revisit once ZK ElGamal program is re-enabled on mainnet.
2. Cross-chain bridging in the pool. Use `@b402ai/sdk` LI.FI integration + external unshield/reshield flow instead.
3. MPC-based novel primitives (Arcium/Umbra). Complementary, addressed in a future PRD.
4. Governance token, DAO, fee switch. 0% fee is immutable in v1 — no fee mechanism exists to govern.
5. Upgradable circuits. Circuit changes require a fresh pool deployment and migration flow, not an in-place upgrade.
6. Retail wallet UX. b402 is SDK-first; wallet integration happens via `@b402ai/kohaku` plugins.

### 2.3 Explicitly deferred

- Additional SPL tokens beyond USDC. Adding a token post-launch is a parameter decision, not a protocol change.
- Additional DeFi adapters (MarginFi, Raydium, Zeta). Same.
- Multi-asset notes (one note holding multiple token types). v1 uses one token per note for simplicity.

---

## 3. Threat model

### 3.1 Assets protected

| Asset | Confidentiality | Integrity | Authentication |
|---|---|---|---|
| Transfer amount | Protected | Protected | Protected |
| Sender identity | Protected | Protected | Protected |
| Recipient identity | Protected | Protected | Protected |
| Note ownership | Protected | Protected | Protected |
| Unshielded destination | **Public** (by design) | Protected | Protected |
| Aggregate pool TVL | **Public** (by design) | Protected | — |
| Protocol parameters | **Public** (by design) | Protected | — |

### 3.2 Adversaries

1. **Chain observer.** Reads all public on-chain state. Cannot learn note contents, sender, recipient, or amount. Can observe deposit/withdraw aggregate volume and timing.
2. **Relayer.** Sees user IP (absent Tor) and proof bytes. Cannot forge a transaction, cannot front-run in a way that invalidates user intent (proof binds recipient + amount). Can censor by refusing to submit. Countered by multi-relayer design and self-submission fallback.
3. **Malicious solver / MEV searcher.** Can attempt to sandwich unshield → swap → reshield flows. Countered by Jito bundles with tip and private mempool submission.
4. **Compromised admin key.** Admin has no ability to freeze, steal, or modify user notes. See § 7 for admin scope.
5. **Compromised viewing key.** Exposes the corresponding note set to the key holder. No impact on spend authority (spend keys are independent).
6. **Compromised spending key.** Full spend authority over notes owned by that key. Users responsible for key custody. Spend keys are never sent to any relayer or service.
7. **Compromised trusted setup.** A participant in the trusted-setup ceremony retaining toxic waste could forge proofs. Mitigated by reusing the Perpetual Powers of Tau (PPoT) Phase-1 ceremony and running a multi-party Phase-2 ceremony with ≥3 independent contributors, at least one held by a publicly-known organization outside b402.
8. **Faulty Solana runtime / verifier bug.** Out of scope; mitigated by using `Lightprotocol/groth16-solana` which is itself audited and widely deployed.

### 3.3 Known limits (not mitigated)

1. **Timing / volume correlation.** If a user deposits X and withdraws X within minutes, the pool's anonymity set collapses to `{that user}`. Standard limit of all pool-based designs. SDK surfaces guidance ("wait for N more deposits of this denomination") but does not enforce.
2. **Network-layer deanonymization.** Relayer sees user IP. Users wanting network privacy must use Tor or a VPN. Out of scope for v1.
3. **Traffic analysis against Jupiter/Kamino/Drift.** When the pool CPI-calls a DeFi protocol, the *protocol* sees a transaction; the *caller* is the pool. Aggregate pool volume is linkable to the target protocol's trades. Mitigated by batching and decoy operations only if/when the anonymity set is large enough to matter. Not solved in v1.
4. **Compliance sanctioning.** If a sanctioned address deposits, mixing with honest users is an inherent property of pool privacy. v1 posture is the Railgun posture — optional viewing-key disclosure gives users compliance tooling without enforcing it.

### 3.4 Trust assumptions

- **BN254 curve security.** ~100 bits of classical security. Sufficient for v1. Post-quantum migration path noted for future PRD.
- **Poseidon hash soundness.** We use the parameter set formally analyzed in the Poseidon paper. No custom parameters.
- **Groth16 soundness.** With honest setup, breaking soundness is equivalent to discrete log on BN254.
- **Trusted setup non-collusion.** Groth16 requires that at least one ceremony participant discarded their toxic waste.
- **Solana consensus.** Same as any Solana program.
- **alt_bn128 syscalls.** Trust Solana's implementation of pairing / scalar multiplication. These syscalls are in Solana 1.18+ mainnet since 2024.

---

## 4. Trust model & admin scope

### 4.1 What admin can do

Admin = a 3-of-5 multisig held by b402 core contributors, published on-chain.

Admin can:
- Pause new shields during an emergency. Cannot pause unshields — users can always exit.
- Whitelist additional SPL token mints (parameter; each new token gets its own sub-pool).
- Whitelist additional composability adapters (Jupiter, Kamino, Drift, Orca addresses). Adding an adapter is governance; the adapter itself is code, not a flag.
- Update the relayer allowlist (if we use one — see § 9) OR remove the allowlist to go fully permissionless.
- Rotate admin keys.

### 4.2 What admin cannot do

- Forge, modify, or invalidate any existing note.
- Change the verifier key. (Hard — would invalidate all notes.)
- Change Poseidon parameters or merkle tree depth. (Hard — same reason.)
- Unshield user funds to an address the user did not specify.
- Read note contents or viewing keys.
- Change the 0% protocol fee. (Hard — locked in v1.)
- Censor specific users. Pause is all-or-nothing.

### 4.3 Upgrade authority

- **Program:** Anchor upgrade authority = admin multisig for the first 12 months post-mainnet, then permanently revoked (authority set to `None`). Critical bug fixes during the 12-month window require a public 72-hour timelock.
- **Verifier program:** Immutable at deploy. No upgrade authority.
- **Pool state:** No admin read/write access. All mutations happen via validated instructions.

### 4.4 Migration policy

Circuit or cryptographic changes cannot be applied in place. If we ever need to change the circuit, the process is:
1. Deploy new pool (new program ID, new verifier).
2. Provide a "migration unshield" path: user proves ownership in the old pool, unshields to a new shield in the new pool atomically.
3. Leave old pool operational indefinitely for users who do not migrate.

This guarantees users can always exit and are never force-migrated.

---

## 5. Cryptographic choices (hard decisions)

### 5.1 Proof system — Groth16

**Decision:** Groth16 over BN254.

**Rejected alternatives:**
- **Plonk / Halo2 / Nova.** Larger proofs, higher Solana compute units, immature on-chain verifier story. Groth16 is the only ZK system with production-grade sub-200k-CU verifier on Solana today (`Lightprotocol/groth16-solana`).
- **STARK.** Proofs 10–50 KB. Does not fit Solana's transaction size limits without compression. No production STARK verifier on Solana mainnet.

**Consequences:**
- Trusted setup required.
- Proof size 256 bytes, verification ~180k CU — fits easily in one Solana transaction.

### 5.2 Curve — BN254 (alt_bn128)

**Decision:** BN254.

**Rejected:** BLS12-381. Faster pairing but Solana's syscalls are alt_bn128-only.

**Consequences:** ~100 bits of security. Adequate for v1. PQ-migration path left open for v2.

### 5.3 Hash — Poseidon

**Decision:** Poseidon over BN254 scalar field, parameters from the Poseidon paper, width-3 and width-5 variants.

**Rejected:**
- **Pedersen hash.** Larger circuit footprint for the same domain separation — ~100x more constraints.
- **SHA256 / Keccak.** ~20k constraints per block — prohibitive for in-circuit use.
- **MiMC.** Smaller ecosystem, less audit history.

**Parameters (exact values in PRD-02):** Poseidon with x^5 S-box, 8 full rounds + partial rounds per width, domain separators for each usage (commitment, nullifier, merkle node, note encryption key derivation).

### 5.4 Merkle tree — incremental, append-only, depth 26

**Decision:** Incremental Merkle Tree using Poseidon, depth 26, leaves stored off-chain (client rebuilds from log).

**Why 26:** 2^26 = ~67M leaves. At 100k shields/day that's ~1,800 years. At 10M shields/day (unlikely) that's ~18 years. Safe for protocol lifetime.

**Rejected depths:**
- 20: Fills in months at target volume. No.
- 32: 6 extra levels = 6 extra Poseidon hashes per proof = ~2000 extra R1CS constraints, materially slower proving. Unnecessary.

**Leaf storage:** On-chain pool stores only (a) current Merkle root history ring buffer of the last 64 roots, (b) nullifier set. Leaves reconstructed off-chain from Solana transaction logs. Client-side indexer recovers full state from RPC replay.

**Root history ring buffer:** Proofs reference a Merkle root. Between proof generation and on-chain verification, the root may advance. We accept any root in the last 64 roots to avoid user races. Older than 64 → user must regenerate.

### 5.5 Trusted setup

**Decision:** Phase-1 from Perpetual Powers of Tau (PPoT), Phase-2 run by b402 with external contributors.

**Phase-1:** PPoT is a reusable universal ceremony with 75+ contributors including public, named participants. We verify and use a specific transcript (pinned hash in PRD-02). No new Phase-1 work.

**Phase-2 ceremony plan:**
- Minimum 3 contributors. At least 1 held by an entity with no formal relationship to b402.
- Public contribution transcript with hash chain.
- Final attestation published on-chain with the verifier program.
- Ceremony coordinator: separate from any contributor.
- Toxic-waste handling: each contributor uses a fresh machine with network disabled, destroys it post-contribution. Evidence posted publicly.

Operational plan for Phase-2 ceremony is in PRD-08.

### 5.6 UTXO / note model

**Decision:** Railgun-style notes.

Each note is a tuple:
```
Note = { token: Pubkey, value: u64, random: Field, spendingPubKey: Field }
Commitment = Poseidon(token, value, random, spendingPubKey)
```

Nullifier for spending:
```
Nullifier = Poseidon(spendingPrivKey, leafIndex)
```

Note encryption for delivery:
```
ephemeralKey  ← random scalar
sharedSecret  ← DH(ephemeralKey, viewingPubKey)
encryptKey    ← Poseidon("b402/note-enc", sharedSecret)
ciphertext    ← ChaCha20-Poly1305(encryptKey, Note)
```

**Why spending vs viewing separation:** lets users disclose viewing keys (show auditor "these are my transactions") without disclosing spend authority. Parity with Railgun and privacy-pools model.

**Token-per-note:** v1 notes hold exactly one token mint. Multi-asset notes (one note → multiple tokens) deferred to future PRD; would complicate the commitment encoding without a clear v1 benefit.

**Denomination:** Free — notes can hold any `u64` value. No fixed denominations like Tornado. Larger anonymity set because all users share the same pool regardless of amount. Timing/volume correlation is a user-side concern per § 3.3.

### 5.7 Nullifier set storage

**Decision:** On-chain nullifier set stored as a sharded set of PDA accounts, one shard per 16-bit nullifier prefix. Each shard is a packed list of nullifier hashes.

**Rationale:** Solana accounts have a 10 MB size limit. Expected nullifier count = 2x commitment count (each user typically ends with half the notes they created, others spent). At 67M max commitments, up to ~130M nullifiers. Sharding into 65,536 accounts gives ~2k nullifiers per shard at saturation → ~64 KB per account → well under limits.

**Alternative considered — Sparse Merkle Tree nullifier set with on-chain root:** allows O(log n) inclusion/exclusion proofs in-circuit but requires an SMT-exclusion proof per spend, roughly doubling circuit constraint count. Not worth the complexity when account-sharding suffices.

**Alternative considered — ZK Compression for nullifiers:** compressed accounts via Light Protocol. Delays finality, ties us to Light's infra, and doesn't obviously win on cost once we shard. Defer.

### 5.8 Viewing-key disclosure (optional compliance)

A user can, at their discretion, export:
- A viewing key for a specific note. Discloses that note only.
- A viewing key for a spending-key scope. Discloses all notes derived from that scope.
- A time-bounded disclosure proof: "these commitments belong to me, timestamped within range [T1, T2]." Uses a separate disclosure circuit (PRD-02).

**This is client-side only.** The protocol has no on-chain disclosure mechanism, no KYT oracle, no sanction list, no geo-blocking. User sovereignty over disclosure is the core compliance stance.

---

## 6. Program architecture overview

### 6.1 Programs deployed

1. **`b402_verifier`** — Groth16 verifier wrapping `groth16-solana`. Immutable. One per circuit variant.
2. **`b402_pool`** — main shielded-pool program. Holds state PDAs, processes instructions, CPI's into verifier and into adapters.
3. **`b402_adapters`** — one program per DeFi integration (Jupiter, Kamino, Drift, Orca). Each exposes a limited CPI interface that the pool can call with unshielded funds and immediately reshield the output. Adapters live in separate programs to limit blast radius of adapter bugs.

### 6.2 Core instructions (pool)

Full specs in PRD-03. High-level:

- `init_pool` — one-time, admin-gated.
- `add_token_config` — admin-gated, whitelists a new SPL token mint as a pool asset.
- `shield` — user deposits token, commits new note. Proof type: `shield_circuit`.
- `transact` — spend N notes, create M notes. Supports internal transfer and is the base primitive for composability. Proof type: `transact_circuit`.
- `unshield` — spend notes, withdraw to clear address. Proof type: `transact_circuit` (same as transact, different output layout).
- `adapt_execute` — unshield to an adapter, the adapter performs a DeFi call, proceeds reshield. Uses a single atomic transaction + an atomic-proof circuit. Proof type: `adapt_circuit`.
- `pause` / `unpause` — admin emergency.
- `set_relayer_allowlist` — admin (optional; can be null-set for fully permissionless).
- `rotate_admin` — admin multisig rotation.

### 6.3 PDA layout (summary; exact in PRD-03)

- `PoolConfig` PDA — seeds `["config"]`
- `TokenConfig[mint]` PDA — seeds `["token", mint]`
- `TreeState` PDA — seeds `["tree"]` (holds root ring buffer, leaf count, edge nodes)
- `NullifierShard[prefix]` PDA — seeds `["null", prefix]`, 65,536 shards
- `Vault[mint]` PDA — token account holding pool's custody of `mint`
- `AdapterRegistry` PDA — seeds `["adapters"]`

### 6.4 Cross-program invocation (RelayAdapt analog)

EVM RelayAdapt works by having the privacy contract `delegatecall` into an adapter. Solana has no delegatecall; instead CPI re-enters a program with its own signer. Our model:

1. User generates an `adapt_proof` that says: "I spend N shielded notes of token A, I want `action_hash` to be executed with `X` of token A sent to adapter `P`, and the resulting token B should land back as a new shielded note of value `Y` at commitment `C`, or the whole transaction reverts."
2. Pool program: validates proof, burns input notes (nullifiers), transfers X of A from vault to adapter's token account, CPIs into adapter with `action_hash`, asserts adapter returns Y of B to pool vault, appends new commitment C.
3. Atomicity is guaranteed by Solana transaction semantics — if any step fails, the whole transaction reverts, including the nullifier writes and token movements.

Key invariant: **the adapter is never trusted with more than `X` of A and must return at least `Y` of B.** The proof binds both.

Adapters live in their own programs. Each adapter's CPI interface is narrow and typed (PRD-05).

### 6.5 Gasless execution

Solana's fee payer is distinct from transaction signers. A relayer signs as the fee payer and pays SOL; the user signs the intent (proof + instruction payload) with a hot key that never needs SOL.

For operations that require SOL rent for new accounts (e.g., commitment storage), the pool uses pre-funded reserve accounts or charges the relayer (relayer recoups from user's unshield proceeds in-kind per § 8).

No ERC-4337 equivalent is needed. The relayer is a regular Solana keypair that b402 or third parties can run.

---

## 7. Relayer model

### 7.1 Architecture

- Users submit `(proof, instruction)` to a relayer HTTP endpoint.
- Relayer constructs the Solana transaction with itself as fee payer, signs, submits (optionally via Jito bundle with tip).
- Relayer returns tx signature to user.
- Relayer receives its fee in-kind: proof binds "X of token T unshielded, of which F goes to relayer address R, rest to user-specified recipient." Proof-enforced.

### 7.2 Fee mechanism

- **Protocol fee: 0%.** Hard-locked.
- **Relayer fee: market-rate.** User chooses a relayer and fee (quoted on an out-of-band market). Fee is baked into the proof's public inputs so the relayer cannot forge a higher fee.
- **SOL rent reimbursement:** for operations creating new accounts (shields fund commitments), the tx includes rent; paid by user at shield-time, paid by relayer at unshield-time and recouped from fee.

### 7.3 Relayer allowlist?

**Decision: none in v1.** Any Solana keypair can act as a relayer. The SDK ships with a default b402-operated relayer for convenience; users can point at any other.

**Rationale:** Privacy.cash runs a centralized CipherOwl-screened relayer. We do not. Anyone can run a relayer, anyone can submit self-relayed transactions (paying their own SOL). Permissionlessness is a hard stance.

**Open question for PRD-02:** whether the proof should bind the relayer address (prevents relayer swap mid-transit but also prevents fallback self-submission). Tentative answer: proof binds a *relayer fee recipient address*, but anyone can submit the tx. User can self-submit by setting recipient = their own address with fee 0.

---

## 8. Anonymity set design

**Single unified pool per token mint.** All users share one commitment tree, one nullifier set, one vault per token. Maximizes anonymity set.

**No fixed denominations.** Notes hold arbitrary `u64` values. Tornado-style fixed denominations are rejected because they fragment the anonymity set and don't add privacy if users can only afford one denomination.

**Agentic implication:** agents operating at micro-amounts and humans operating at larger amounts share the same pool. An agent's 0.10 USDC shield is cryptographically indistinguishable from a human's 10,000 USDC shield in the note set. The anonymity set is the number of commitments, period.

**Ramp-up concern:** early days, TVL is low. Mitigations:
1. Docs + SDK ship with "current anonymity set size" warnings so users shield into thicker pools when possible.
2. Pool seed: b402 treasury commits a structured set of decoy-like notes to bootstrap set size. (Not forced; opt-in donation by b402.)
3. No "pool tiers" or KYC fast lanes that would split users.

---

## 9. Token scope (v1)

**Shieldable:**
- Native SOL (wrapped to wSOL `So11111111111111111111111111111111111111112` inside the pool)
- Native USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`

**Composable via adapters:**
- Jupiter: whatever Jupiter routes to (hundreds of tokens, but only the inputs/outputs of the shielded transaction are SOL/USDC).
- Kamino: supply USDC to Kamino vaults. Yield accrues inside pool via reshielded position tokens.
- Drift: USDC margin; perps on BTC/ETH/SOL.
- Orca Whirlpools: SOL/USDC LP. Position NFT custody in pool; fees reshielded on claim.

**Adding tokens:** admin instruction `add_token_config` deploys a new `TokenConfig` PDA and `Vault` token account. No protocol change, no circuit change — tokens share the pool-level circuit because the circuit treats `token_mint` as a variable input.

**Token-2022 support:** deferred until ZK ElGamal is re-enabled on mainnet, at which point we consider a Confidential-Transfer-aware mode.

---

## 10. Compliance posture

**Default: fully permissionless.** No KYT, no sanctions screening, no geo-blocking. Matches Railgun.

**User-sovereign disclosure tools (v1):**
- Viewing key export per note / per scope.
- Time-bounded disclosure proofs ("I owned these commitments during [T1, T2]") as a standalone disclosure circuit.
- Audit reports generable client-side.

**No CipherOwl / Chainalysis integration.** Users who want an allowlisted relayer can run or use one; not opinionated at protocol level.

**Legal posture:** matches Railgun's current operating stance. Protocol is neutral infrastructure; users are responsible for their own regulatory position. Disclaimers in SDK docs.

---

## 11. Fee model (hard)

- **Protocol fee: 0%** on every operation in v1. Immutable.
- **No fee switch.** The program has no fee-collection code path for protocol fees. Adding one later requires a new program.
- **Relayer fee:** market-determined, user-specified per transaction, proof-bound.
- **Solana network fees:** ~5000 lamports per signature; paid by relayer in gasless mode, recouped from relayer fee.
- **Future revenue:** b402 monetizes via premium relayer infra, MCP-hosted services, and enterprise support. Not via the pool.

**Why this matters for agents:** every protocol fee is dead weight for high-frequency agents. 0% + only network fees means an agent can transact profitably at amounts where 35 bps would crush margins.

---

## 12. Upgradeability (hard)

| Component | Upgrade policy |
|---|---|
| Pool program | Upgrade authority = 3-of-5 multisig for 12 months, then revoked permanently. 72-hour timelock on any upgrade. |
| Verifier program | Immutable. No upgrade authority. |
| Circuit / verifying key | Immutable per deployment. Circuit changes require fresh pool deployment + user-initiated migration. |
| Poseidon parameters | Immutable. Locked at circuit-compile time. |
| Merkle tree depth | Immutable per deployment. |
| Token whitelist | Admin (governance action, no user impact on existing notes). |
| Adapter whitelist | Admin (governance action). |
| Relayer allowlist | Admin (expected to be null = permissionless). |
| Fee policy | Immutable at 0% protocol fee. |
| Admin multisig | Self-rotation only. |

---

## 13. Agent-native considerations

1. **Deterministic key derivation.** Agent spawns with a seed; spending key + viewing key derived via HKDF-Poseidon from the seed. Reproducible across restarts, no wallet file needed.
2. **Stateless proof generation.** Proof generation needs: (a) the note being spent, (b) its merkle path, (c) recent root. All recoverable from Solana RPC replay — agent does not need persistent storage.
3. **Proof latency budget.** Target <2s wall-clock for `transact` proof on a modern CPU (8-core). Client WASM prover must hit this. Measured in PRD-07.
4. **MCP surfacing.** Every SDK method maps to one MCP tool. Errors are structured (`ProofFailed`, `NullifierSpent`, `InsufficientNotes`, etc.) so agents can reason about retries.
5. **Anonymity-set hints.** SDK exposes `status.anonymitySet` per token so agents can decide whether to shield now or wait.
6. **Batch operations.** v2 consideration: agent can shield many small deposits into one note to save proof cost. Designed into the `transact` circuit (N-in, M-out) from day one.

---

## 14. Comparison matrix (concrete differentiation)

| Capability | b402-solana v1 | Privacy.cash | Umbra (Arcium) | Token-2022 CT |
|---|---|---|---|---|
| SOL shielding | Yes | Yes | Yes | No (SOL not an SPL token) |
| USDC shielding | Yes | Planned | Yes | Disabled |
| Other SPL tokens | Admin-whitelist | Planned | Partial | Disabled |
| Private swap | Jupiter CPI in-pool | Jupiter via unshield+reshield wrapper | Encrypted, MPC | N/A |
| Private lending | Kamino CPI | No | No | N/A |
| Private perps | Drift CPI | No | No | N/A |
| Private LP | Orca CPI | No | No | N/A |
| Atomic composability (unshield→act→reshield) | Yes (adapt_execute) | No | No | N/A |
| Protocol fee | 0% | 0.35% | TBD | 0 |
| Gasless | Yes (sponsor + Jito) | Yes (relayer) | Yes | Yes |
| Compliance stance | User-sovereign, opt-in disclosure | Mandatory CipherOwl screening | Viewing keys + risk screening + geo-block | N/A |
| Trust model | ZK (Groth16) | ZK (Groth16) | MPC | ZK (ElGamal) |
| Agent SDK / MCP | Yes | No | SDK, no MCP | N/A |
| Open source | Yes (planned) | Yes | Partial | Yes |
| Audits | Planned (2+ firms + formal verification) | 18 audits + Veridise FV | Alpha, in progress | Pending |

---

## 15. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Circuit bug allowing double-spend | Catastrophic (pool drainable) | Two independent firm audits, Veridise formal verification, public bug bounty ≥$500k, staged deposit caps during ramp |
| Verifier bug | Catastrophic | Use audited `groth16-solana` unchanged; do not roll our own |
| Trusted-setup collusion | Catastrophic | 3+ Phase-2 contributors including external org; public transcript |
| Relayer centralization | Censorship | No allowlist; self-submission always allowed; multiple relayers encouraged |
| Anonymity-set too small at launch | Privacy degraded | Warn in SDK; b402 bootstraps with decoy-like shields; watch TVL/commit count on launch dash |
| Adapter compromise | Bounded to that adapter's flow | Adapters in separate programs; pool proof binds exact in/out amounts; adapter can never take more than X |
| Solana runtime change breaks CPI | Pool unavailable | Keep up with Solana version compat; tested on Firedancer pre-launch |
| MEV sandwich on unshield→swap | Swap at bad price | Jito bundles with tip; slippage bound in proof |
| Admin key compromise | Pause abuse, token/adapter whitelist abuse | 3-of-5 multisig; 12-month sunset; 72-hour timelock |
| PQ attack on BN254 | Long-term privacy broken | Document; plan v2 migration to PQ-safe proof system post-NIST standardization |
| Regulatory action | Protocol constrained | Permissionless design; disclosure tools; legal review pre-launch |

---

## 16. Success criteria

**Launch gate (mainnet alpha, deposit-capped):**
- Two independent security audits complete, all high/medium findings resolved.
- Veridise (or equivalent) formal verification of the transact circuit complete.
- Phase-2 trusted-setup ceremony complete with public attestation.
- End-to-end tests: 100% pass on devnet for all v1 operations.
- Deposit cap: $100k/day per user, $1M total TVL, first 30 days.
- Incident runbook + on-call rotation active.
- Public bug bounty ≥$500k live.

**Mainnet full launch:**
- 30 days no P0/P1 incidents post alpha.
- Deposit caps removed.
- Second b402-operated relayer region live.
- ≥3 third-party relayers running.

**Adoption milestones (informational):**
- 1,000 unique commitments in first 90 days.
- 10+ partner integrations (wallets, agents, apps) consuming the SDK.

---

## 17. Out-of-scope / future PRDs

1. **Cross-chain shielded bridge.** Today's path: unshield on Base → LI.FI → shield on Solana. Direct shielded bridge is v2.
2. **Token-2022 Confidential Transfer hybrid mode.** Await ZK ElGamal re-enable.
3. **Arcium/Umbra composability.** For Solana-native sealed-bid or confidential-NAV primitives. Would sit alongside the ZK pool, not replace it.
4. **PQ migration.** Post-NIST standardization.
5. **Multi-asset notes.** Single-token notes in v1.
6. **Decentralized relayer market.** v1 permissionless relayers; v2 reputation/bonded market.
7. **Governance / fee switch.** Not planned. Hard stance: 0% forever.

---

## 18. Open questions to resolve before PRD-02 sign-off

1. **Phase-2 ceremony contributors.** Shortlist of external orgs willing to participate. b402 core + who else?
2. **Relayer-address binding in proof.** Bind fee *recipient* only (permits self-submission) vs bind submitter (stronger but less flexible). Tentative: bind recipient only.
3. **Wallet derivation compatibility.** Do we align with Kohaku key derivation spec (which is EVM-Railgun-based) or adopt a Solana-native BIP-44 path + Poseidon-HKDF? Tentative: Solana-native, documented.
4. **Decoy note policy.** If b402 seeds decoy-like shields to bootstrap anonymity, what's the redeem path? Tentative: structured, publicly-attested burns with attestations.
5. **Admin multisig members.** 5 named signers. TBD pre-launch.

---

## 19. Revision history

| Version | Date | Author | Changes |
|---|---|---|---|
| 0.1 | 2026-04-23 | b402 core | Initial draft |

---

## 20. Sign-off

| Role | Name | Date | Status |
|---|---|---|---|
| Protocol lead | | | |
| Cryptography review | | | |
| Solana program review | | | |
| Legal / compliance review | | | |
| Final approval | | | |

Once this document is signed off, PRD-02 (Cryptographic Spec) begins. No circuit or program code before PRD-03 sign-off.
