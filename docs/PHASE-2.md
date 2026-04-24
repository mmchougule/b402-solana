# Phase 2 — what closes the real `adapt_execute`

The current `adapt_execute_devnet` handler exists to validate pool + SDK +
ALT plumbing against a real adapter CPI. It is **feature-gated** behind
`--features adapt-devnet` and explicitly claims **no security property**.
A default build (which is what a mainnet deploy would produce) rejects the
instruction at the runtime `cfg!` gate.

This doc explains what Phase 2 adds and why it's required for mainnet.

---

## The concrete hole in `adapt_execute_devnet`

The handler does:

1. Registry check — adapter program ID + instruction discriminator must
   be allowlisted.
2. Pool-signed transfer of `in_amount` from `in_vault` → `adapter_in_ta`.
3. CPI the adapter with caller-supplied raw instruction data.
4. Post-CPI invariant: `out_vault.amount` delta ≥ `min_out_amount`.
5. Append caller-supplied `output_commitment` (32 bytes) to the tree.

Step 5 is the hole. The caller hands the pool an opaque 32-byte
commitment. The pool doesn't verify that the commitment is
`Poseidon(expected_out_mint, actual_delta, random, caller_spendingPub)`
— it just appends the bytes.

### Example attack (requires the feature flag to be on)

- Alice: shields 50 USDC. Vault: 50.
- Carol: shields 100 USDC. Vault: 150.
- Alice calls `adapt_execute_devnet` with `in_mint=USDC`, `out_mint=wSOL`,
  `in_amount=10`. Adapter delivers 0.01 wSOL. Delta check passes.
- Alice's output commitment field is her choice. She constructs
  `Poseidon(USDC_mint, 1000, random, alice_spendingPub)` — a 1,000-USDC
  commitment.
- Pool appends it. USDC vault still has 140 (10 went through the adapter).
- Later, Alice unshields the note with a real Groth16 proof claiming
  `mint=USDC, value=1000, owner=alice`. The proof verifies (the commitment
  IS in the tree) and the pool pays out from the USDC vault — draining up
  to its current balance.

Alice burned 10 USDC to extract 140 USDC (her 50 + Carol's 100 − 10
sent through adapter). Net +80 USDC stolen from Carol.

### Why this doesn't reach mainnet today

1. The handler is only compiled when `--features adapt-devnet` is passed
   to `cargo build-sbf`. Mainnet builds omit the feature.
2. Even if someone accidentally deployed with the feature on, the
   runtime `cfg!` check in `lib.rs` returns `InvalidInstructionData`
   unless the feature is enabled at compile time (which it would be in
   that accidental build — so this is belt-and-suspenders, not the
   primary defense).
3. The one chain where the feature is compiled in (b402's own devnet
   deploy) uses ephemeral test mints — there's no persistent Carol-
   equivalent pool balance to drain. Each `pnpm e2e` run creates a fresh
   mint.

The feature flag is the primary defense; the test-mint convention on
devnet is a secondary safety net.

---

## What Phase 2 adds

### 1. Adapt circuit (`circuits/adapt.circom`)

Extends the transact circuit with 4 additional public inputs:

| Public input | Role |
|---|---|
| `adapter_id` | keccak256(adapter_program_id), identifies which adapter is allowed |
| `action_hash` | `Poseidon_2(adaptBindTag, keccak256(action_payload), expected_out_mint_Fr)` |
| `expected_out_value` | Minimum output the caller proved they expect |
| `expected_out_mint` | Fr-reduced mint pubkey of the output token |

And 2 additional in-circuit constraints:

- **Output commitment mint binding**: the `tokenMint` field embedded in
  each output commitment must equal `expected_out_mint`.
- **Action-hash consistency**: the circuit recomputes `action_hash` from
  `expected_out_mint`, proves the caller committed to this payload before
  proof generation. A relayer tampering with `action_payload` between
  proof gen and submission breaks the on-chain check.

Circuit size: ~500-800 extra R1CS constraints vs transact's 17,259.
Proof size unchanged (Groth16 is succinct). Ceremony output is a new
`.zkey` plus `verification_key.json` independent from the transact VK.

### 2. Fresh trusted-setup ceremony

Separate from the transact ceremony. Must have 3+ contributors and an
attestation chain per PRD-08 §2. Timeline dominated by contributor
coordination, not compute (Powers-of-Tau drawdown + circuit-specific
phase is ~hours on a laptop).

### 3. `b402_verifier_adapt` program

Structural clone of `b402_verifier_transact`. Bakes the adapt circuit's
VK into source at build time via `circuits/scripts/vk-to-rust.mjs` (same
tooling). ~150 lines of Rust, near-identical to the existing verifier.

### 4. Real `adapt_execute` handler

Replaces `adapt_execute_devnet` in
`programs/b402-pool/src/instructions/adapt_execute.rs`. New steps:

1. Verify adapt proof via `b402_verifier_adapt` CPI.
2. Parse the 22 public inputs (18 from transact + 4 new).
3. Bind pool-side state: `adapter_id` matches keccak of
   `adapter_program.key`, `expected_out_mint` matches
   `token_config_out.mint`, `action_hash` matches keccak of the forwarded
   `action_payload`.
4. **Burn input nullifiers** (not present in the devnet stub — the devnet
   stub moves tokens directly from `in_vault`, but the real path spends
   shielded UTXOs).
5. Transfer `in_amount` from `in_vault` to `adapter_in_ta` (pool-signed).
6. CPI adapter with `action_payload`.
7. Post-CPI delta check (unchanged from devnet stub; this is invariant I4).
8. Append the circuit-proven output commitment.
9. Pay relayer fee per PRD-04 §3.1.
10. Emit `AdaptExecuted` event with all the binding values.

Steps 1-3 are what the devnet stub skips. With them in place, the caller
can no longer choose an arbitrary commitment — the circuit forces the
commitment to encode the actual output mint + at-least the expected
value, and the pool binds the expected mint to the registered output
token config.

### 5. Delete `adapt_execute_devnet`

Once the real path ships, the devnet-gated handler + its cargo feature
are removed. Migration: existing devnet state continues to work because
the pool's tree + nullifier set are compatible.

---

## Timeline estimate

Realistic, not aggressive:

| Item | Effort |
|---|---|
| `adapt.circom` + unit tests + parity tests | 3-5 days |
| Ceremony coordination + run | 1-2 weeks (gated by contributor schedules) |
| `b402_verifier_adapt` + VK baking | 1-2 days |
| Real `adapt_execute` handler + integration tests | 3-5 days |
| End-to-end against mainnet-fork with real Jupiter | 1 day (infra already exists) |
| **Total focused** | **~2-3 weeks** |

Audit engagements (Veridise / Accretion / Zellic per PRD-08) can start
in parallel with the circuit work — the transact circuit is already
stable and represents the bulk of the cryptographic surface.

---

## What can land before Phase 2 on mainnet

**Not much, honestly.** The full value proposition of b402-solana is
private composability — shield + unshield alone is a strictly narrower
offering than Privacy Cash. So a "shield/unshield only" mainnet launch
doesn't differentiate.

What *can* land before Phase 2:
- Devnet campaigns with agents / partner integrations, using
  `adapt_execute_devnet` on devnet only — acceptable because devnet
  value is zero.
- Security review engagements for the transact circuit + pool's
  shield/unshield paths. These are audit-ready today; the adapt layer
  isn't.
- Relayer HTTP + Jito bundle service for shield/unshield — matches our
  EVM relayer pattern.
- Stealth-address bech32 encoding + SDK `sendToAddress(addr)`.
- Scanner persistence layer (IndexedDB / SQLite backing for `NoteStore`
  so wallets don't lose state across sessions).

Everything above is non-blocking parallel work while Phase 2 circuit +
ceremony land.
