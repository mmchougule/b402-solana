# PRD-30 — v2 Nullifier Set on Light Protocol's Indexed Merkle Tree

| Field | Value |
|---|---|
| **Status** | Draft — awaiting review |
| **Owner** | b402 core |
| **Date** | 2026-04-29 |
| **Version** | 0.1 |
| **Depends on** | PRD-01 (architecture), PRD-02 (crypto spec), PRD-03 (program spec) |
| **Gates** | v2 mainnet launch; deprecation of v1 nullifier-shard architecture |
| **Supersedes** | The 65,536-shard nullifier set defined in PRD-03 §4.2 |
| **Spike** | `docs/spikes/SPIKE-v2-nullifier-imt.md` |
| **Branch** | `feat/v2-nullifier-imt` |

---

## §1. Goal

Replace the v1 sharded-PDA nullifier set with Light Protocol's address-tree IMT, delivered via a forked-and-thinned `Lightprotocol/nullifier-program`. Per-unshield gas drops from ~$22.60 (alpha-period measured) to ~$0.003 (gas-only, excluding one-time ATA rent). Pre-allocation cost goes from ~$836k impractical to $0. All other v1 properties — privacy guarantees, circuit shape minus the shard prefix, adapter ABI, relayer flow, viewing-key separation — preserved.

This is the architectural fix that makes b402-solana's economics competitive with L2-deployed shielded pools. Without it, v1 is uneconomic at scale; with it, b402-solana ships at Solana-native costs.

## §2. Non-goals

Out of scope for PRD-30, deferred to follow-on PRDs:

- Compressing the **commitments tree** onto Light's state tree (PRD-31, future).
- Bonded relayer market (PRD-22, independent).
- Multi-mint v2 ABI extensions (PRD-11, PRD-12, independent).
- Phase-2 ceremony coordination (treated as adjacent workstream; same artifact deploy gate).
- Any change to adapter ABI or adapter execution model. v2 is nullifier-set-only.

## §3. Architecture

### §3.1 v1 → v2 surface change

```
v1 unshield tx accounts (subset relevant to nullifier write):
  - nullifier_shard_0  PDA at [VERSION_PREFIX, "null", prefix_0_le]   (created or extended)
  - nullifier_shard_1  PDA at [VERSION_PREFIX, "null", prefix_1_le]   (created or extended)
  - signer            relayer (fee payer)
  - system_program

v2 unshield tx accounts (subset relevant to nullifier write):
  - light_address_tree         Light Protocol's V2 address tree (mainnet, fixed pubkey)
  - light_output_state_tree    Light Protocol's V2 output state tree (mainnet, fixed pubkey)
  - light_system_program       LightSystemProgram (fixed program ID)
  - light_account_compression  account-compression program (fixed program ID)
  - light_registry             light-registry program (fixed program ID)
  - light_noop                 SPL noop program (for log emission)
  - cpi_authority              Light's CPI signer PDA, derived from caller program
  - signer                     relayer (fee payer)
  - system_program
```

The v1 PDA shard accounts disappear. Light's accounts replace them. Account count stays in the same ballpark; ALT compression still applies.

### §3.2 The forked nullifier program: `b402_nullifier`

A thin Anchor program at `programs/b402-nullifier/`. ~70 LoC, modeled directly on `Lightprotocol/nullifier-program`. Differences from upstream:

1. `declare_id!` is a fresh program ID held in `ops/keypairs/b402_nullifier-keypair.json`.
2. Address-derivation seed is `[b"b402/v1/null", id]` (not `[b"nullifier", id]`). Domain-separated from any other Light-built nullifier program in the same address tree.
3. Caller is restricted to our `b402_pool` program: a single CPI-signer check on `ctx.accounts.signer` matches the pool's `adapter_authority` PDA. This is a defense-in-depth check; even without it, only a caller knowing the right `id` value (= our circuit's nullifier output) could create the address, which is already infeasible without a valid proof.
4. Bound to a specific Light V2 program version (recorded in `Cargo.toml`); we lock against silent-upgrade risk.

The single instruction: `create_nullifier(proof, address_tree_info, output_state_tree_index, id)`.

- Verifies the validity proof against the current address tree root.
- Derives the address from `(b"b402/v1/null", id, address_tree_pubkey, b402_nullifier_program_id)`.
- Calls `LightSystemProgramCpi::new_cpi(...).with_light_account(...).with_new_addresses(...).invoke(...)`.
- Returns an error if the address already exists (= double-spend).

### §3.3 Pool-side change

`programs/b402-pool/src/instructions/transact.rs` and `adapt_execute.rs`:

- Drop `nullifier_shard_prefix: [u16; 2]` from instruction args.
- Drop `nullifier_shard_0`, `nullifier_shard_1` accounts.
- Add the Light account list per §3.1.
- After the verifier CPI succeeds, for each non-dummy nullifier in the proof's public inputs, perform a CPI into `b402_nullifier::create_nullifier` with the nullifier value as `id`.
- Validity proofs and address-tree-info come from the SDK; the pool just plumbs them through.

`programs/b402-pool/src/state.rs`: delete `NullifierShard`, `MAX_NULLIFIERS_PER_SHARD`, `NULLIFIER_BYTES_PER_SHARD`, related state.

`programs/b402-pool/src/util.rs`: delete `shard_prefix`, `add_nullifier_to_shard`, `nullifier_already_in_shard` and tests.

### §3.4 Circuit change

`circuits/transact.circom` and `circuits/adapt.circom`:

- Drop `nullifier_shard_prefix` from public-input list.
- Nullifier value itself remains a public input (used by the on-chain Light CPI to derive the address).
- Domain tags unchanged; `b402/v1/null` remains the nullifier hash domain.
- `TRANSACT_PUBLIC_INPUT_COUNT` decreases (was 18; new value is determined by exactly which inputs we drop — see §3.5). `TRANSACT_PUBLIC_INPUT_ORDER` in `packages/shared/src/constants.ts` updated accordingly.
- R1CS constraint count expected to drop slightly (byte-extraction logic for the prefix is removed).

This circuit change is small but **requires a new ceremony** because the circuit's R1CS hash changes. Phase-2 ceremony coordination is adjacent workstream; ceremony output gates v2 mainnet deploy but not earlier phases.

### §3.5 Public-input list (frozen for PRD-30)

v1 public inputs (`packages/shared/src/constants.ts:TRANSACT_PUBLIC_INPUT_ORDER`):
```
0  merkleRoot
1  nullifier0
2  nullifier1
3  commitmentOut0
4  commitmentOut1
5  publicAmountIn
6  publicAmountOut
7  publicTokenMint
8  relayerFee
9  relayerFeeBind
10 rootBind
11 recipientBind
12 commitTag
13 nullTag
14 mkNodeTag
15 spendKeyPubTag
16 feeBindTag
17 recipientBindTag
```

v2 public inputs (frozen):
```
0  merkleRoot
1  nullifier0
2  nullifier1
3  commitmentOut0
4  commitmentOut1
5  publicAmountIn
6  publicAmountOut
7  publicTokenMint
8  relayerFee
9  relayerFeeBind
10 rootBind
11 recipientBind
12 commitTag
13 nullTag
14 mkNodeTag
15 spendKeyPubTag
16 feeBindTag
17 recipientBindTag
```

Identical list. The `nullifier_shard_prefix` was an **instruction argument**, not a circuit public input — re-checked against `transact.rs:23`. So **the circuit doesn't change at the public-input level**. Only the instruction-argument shape and the pool's account-list change. **No new ceremony is required.**

This is a meaningful simplification of the spike's plan. PRD-30 supersedes the spike's "Phase 3: circuit cleanup" — phase 3 becomes "verify that the circuit is unchanged, only the instruction wrapper around it shifts." This collapses the timeline by ~1 week and eliminates one of the riskiest steps (re-running ceremony).

The circuit on-disk artifact (`circuits/build/transact_final.zkey`) is **bit-for-bit identical** between v1 and v2. The verifier programs are unchanged. The change is purely in the Anchor pool program's instruction wrapper and the SDK.

### §3.6 Trust model

v2 introduces three new trust dependencies, each documented:

1. **Light Protocol's `light-system-program` and `account-compression`**. Both are upgradeable. Light Labs holds upgrade authority on mainnet. A malicious Light upgrade could in principle break our non-inclusion property. Mitigation: monitor upgrade events on those programs; lock to a specific Light version at deploy and revisit on each Light release. Document in user-facing security model.

2. **Photon indexer**. Read-only dependency for fetching validity proofs. Self-hostable; Helius runs a hosted instance; we default to Helius and document self-host as the production option for high-trust users.

3. **Forester service**. Empties Light's insertion queue and rolls over trees when full. Permissionless — anyone can run one. Light Labs runs default. If all Foresters disappear, our v2 inserts start failing with `QueueFull` and we'd need to spin up our own. No financial centralization, but liveness depends on at least one Forester running.

These are documented in the user-facing trust-model section of the README. Compared to v1's "trust the relayer for liveness only," v2 adds two more liveness dependencies; the security model (no party can spend a user's note without their spending key) is preserved.

### §3.7 Design semantics — what v2 actually models in Light terminology

External reviewers reading Light's docs sometimes assume v2 is using compressed-account *update* semantics (prove an account exists, nullify the old hash, write a new hash). That is not what we do. v2 uses Light's **address tree** primitive:

- A nullifier is modelled as a **32-byte address** in Light's address-tree namespace, derived from `Poseidon2(b"b402/v1/null", nullifier_value)`.
- The proof we fetch from Photon is a **non-inclusion proof**: "no leaf with this address currently exists in the address tree."
- The CPI we issue against `light-system-program` is `create_address` (allocate-on-insert). Light's on-chain code rejects the insertion if the address already exists. **That rejection is the anti-double-spend property** — not custom membership logic in our program, not a compressed-account update.

What that gives us:
- **Uniqueness** is enforced by Light, cryptographically, on-chain, in a single CPI.
- **Pool program ownership is unchanged.** The pool's PDAs (Config, NoteStore, MerkleQueue, RootHistory) remain pool-owned. Light owns only the address-tree leaves we created.
- **No bespoke membership logic** lives in `b402_pool`. The pool's only obligation is to verify (via the instructions sysvar) that the corresponding `b402_nullifier::create_nullifier` instruction is present in the same transaction with the expected nullifier bytes.

This is also why the pool keeps its existing UTXO note Merkle tree, root history, and circuit semantics: the nullifier set is the only piece moved into Light. The protocol's privacy guarantees are still rooted in our own circuit + our own note tree; Light is the uniqueness store, nothing more.

## §4. Migration plan from v1

### §4.1 v1 deployed state on mainnet at PRD-30 sign-off

- 3 programs deployed: `b402_pool`, `b402_verifier_transact`, `b402_verifier_adapt`.
- USDC + WSOL token configs registered.
- ~8 nullifiers in v1 shards (from Phase A.1/A.2/A.3 demos).
- ~2 shielded notes still spendable on v1 (corresponding to undeposited or unredeemed test deposits).

### §4.2 Cut strategy

**Clean cut, no state import.** Reasons:

- v1 nullifier shards are not addressable via Light's tree — different on-chain representation, no cryptographically meaningful import path.
- Only ~8 nullifiers exist; not worth importer complexity.
- Existing v1 notes can be unshielded via the v1 program (which stays deployed) for a grace period; clean conversion path.

### §4.3 Migration sequence

1. Deploy `b402_nullifier` to mainnet (~1.6 SOL rent, fresh program ID).
2. Deploy `b402_pool` v2 (program upgrade — same authority, same program ID — replaces the deployed bytecode).
3. The v1 `b402_verifier_transact` and `b402_verifier_adapt` are byte-for-bit reused (no circuit change per §3.5). No new verifier deploys.
4. Init: register the Light V2 address tree pubkey in pool's config (new admin instruction `set_light_address_tree`).
5. Pool's existing v1 nullifier-shard PDAs (any that exist) become stranded: rent locked, never spent again, no further effect on the pool. They're harmless leftovers.
6. New shields go to v2; new unshields use the v2 nullifier set.
7. Existing v1 notes (the ~2 outstanding) can still be unshielded — but only after we re-enable the v1 program with the old shard architecture, OR the user reshields-after-unshield once they migrate. **Decision**: ship v2 with `b402_pool` upgrade; existing v1 notes become un-spendable until users re-deposit. We reach out to the ~2 affected test wallets (us, basically) to coordinate.

For an alpha with us as the only active user, this is a no-op annoyance. For a v2 launch after broader adoption, this approach would be wrong; that's why we ship v2 BEFORE adoption scales.

### §4.4 Staged rollout

| Stage | Cluster | Gate |
|---|---|---|
| 0 | Localnet (cloned Light bytecode) | All Phase-0/1/2/3 tests green |
| 1 | Devnet (fresh deploy of v2 b402 against Light's devnet) | Phase-4 SDK tests green; sequential 100-wallet test passes |
| 2 | Mainnet-fork validator (Light mainnet bytecode cloned, no real SOL) | Phase-5 e2e green; per-unshield gas ≤ 25k lamports |
| 3 | Mainnet (real deploy) | All previous green; final review pass |

## §5. Test plan (TDD-first, by phase)

### §5.1 Phase 0 — local Light fixture (1 day)

`tests/integration/light_protocol_localnet.test.ts`:
- T0.1 — Local validator boots with cloned `light-system-program`, `account-compression`, `light-registry`. Light mainnet pubkeys resolve correctly.
- T0.2 — Address tree V2 initializes successfully; tree pubkey matches docs.
- T0.3 — `light-registry` is in expected state (Forester registry initialized).

`tests/integration/photon_indexer.test.ts`:
- T0.4 — Local Photon points at localnet, returns address tree root.
- T0.5 — Photon returns a valid validity proof for an unused address; proof verifies offline.

### §5.2 Phase 1 — `b402_nullifier` program (2 days)

`programs/b402-nullifier/tests/`:
- T1.1 — `derive_address_uses_b402_seed`: derives a unique address from `(b"b402/v1/null", id)`, deterministic, differs from upstream's `(b"nullifier", id)`.
- T1.2 — `create_nullifier_succeeds_when_unused`: CPI in, post-state shows the address is now occupied.
- T1.3 — `create_nullifier_fails_on_double_spend`: same id, ix returns `AddressAlreadyAssigned`.
- T1.4 — `create_nullifier_rejects_wrong_tree_pubkey`: caller passes a non-canonical address tree; ix fails with `InvalidAccountData`.
- T1.5 — `create_nullifier_rejects_invalid_validity_proof`: forged proof; Light's verifier rejects.
- T1.6 — `create_nullifier_emits_event`: emitted event includes canonical address bytes.
- T1.7 — `create_nullifier_rejects_unauthorized_caller`: only `b402_pool`'s adapter authority is allowed to call (defense-in-depth).

### §5.3 Phase 2 — pool program: replace shard surface (3 days)

`programs/b402-pool/tests/onchain/`:
- T2.1 — `transact_publishes_nullifier_via_cpi`: shield → unshield, post-tx the nullifier address exists in Light's tree, our pool's TreeState has the matching commitment leaf.
- T2.2 — `transact_rejects_double_spend_via_light`: same note unshielded twice, second tx fails with the propagated Light error.
- T2.3 — `transact_does_not_allocate_shard_pdas`: post-tx, `getProgramAccounts` for the pool returns no `NullifierShard`-shaped accounts.
- T2.4 — `transact_handles_two_nullifiers_in_one_tx`: shield consumes 1 real + 1 dummy note → 1 nullifier created. Unshield consumes 1 real → 1 nullifier created. Both addresses exist post-tx.
- T2.5 — `transact_propagates_light_validity_proof_failure`: stale tree root in proof → fails cleanly with our error wrapping Light's.
- T2.6 — `adapt_execute_publishes_nullifier_via_cpi`: same property for the adapt path.
- T2.7 — `transact_rejects_proof_for_wrong_id`: validity proof's id ≠ the nullifier value passed; Light catches.

### §5.4 Phase 3 — circuit verification only (½ day)

Per §3.5, the circuit doesn't actually change. Phase 3 verifies this:
- T3.1 — `r1cs_unchanged`: snarkjs r1cs info on `transact.r1cs` exactly matches the v1 hash.
- T3.2 — `zkey_unchanged`: SHA-256 of `transact_final.zkey` matches v1.
- T3.3 — `verifier_program_unchanged`: deployed `b402_verifier_transact` ID is the same as v1.

If any of these fails, the spike's circuit-cleanup claim was wrong and we revisit.

### §5.5 Phase 4 — SDK + Photon integration (2-3 days)

`packages/sdk/src/__tests__/`:
- T4.1 — `actions/shield.test.ts::v2_shield_drops_shard_accounts`: built tx has zero `nullifier_shard_*` keys, has the new Light accounts.
- T4.2 — `actions/unshield.test.ts::v2_unshield_fetches_validity_proof`: SDK pulls a non-inclusion proof from Photon for the computed nullifier before tx submit.
- T4.3 — `actions/unshield.test.ts::v2_unshield_packs_light_accounts_in_correct_order`: account ordering matches Light's `CpiAccounts` shape.
- T4.4 — `b402.test.ts::v2_handles_photon_outage`: SDK retries with backoff, surfaces a typed `RelayerProverUnavailable` error if Photon stays down.
- T4.5 — `b402.test.ts::v2_validity_proof_freshness`: SDK refetches proof if more than 10s elapsed since fetch.
- T4.6 — `b402.test.ts::v2_concurrent_root_rotation`: simulate root rotation between proof fetch and tx submit; SDK detects, refetches, retries once.

### §5.6 Phase 5 — end-to-end on local + mainnet-fork (2-3 days)

`tests/e2e/`:
- T5.1 — `v2_localnet_100_wallets.test.ts`: generate 100 fresh wallets. Each does 1 shield (~0.1 USDC) + 1 unshield to a fresh recipient. Records relayer balance delta per pair. **Asserts**: average per-unshield gas ≤ 25,000 lamports excluding ATA. Asserts privacy property (relayer signs all unshields, depositor wallet absent).
- T5.2 — `v2_mainnet_fork_100_wallets.test.ts`: same flow against a mainnet-fork validator with Light's mainnet programs cloned. Runs against real Photon endpoint (Helius). Asserts same numeric criteria.
- T5.3 — `v2_double_spend.test.ts`: shield once, unshield twice. Second unshield fails with the Light-propagated error.
- T5.4 — `v2_concurrent_unshield.test.ts`: two unshields against the same tree root (different notes), submitted in the same slot. Both succeed (Light's changelog buffer absorbs).
- T5.5 — `v2_reorg_recovery.test.ts`: simulate a reorg via local validator; SDK uses `confirmed` commitment; state recovers correctly.

### §5.7 Phase 6 — gated mainnet deploy

Pre-deploy checklist (must all be true):
- [ ] All T5.x green for ≥ 100 wallets on mainnet-fork.
- [ ] Per-unshield gas ≤ 25,000 lamports observed in T5.2.
- [ ] CU per unshield ≤ 600,000 observed.
- [ ] Photon dependency documented in README.
- [ ] Trust model section in README updated.
- [ ] Light program version locked in `Cargo.toml`.
- [ ] Final code review pass (claude + me).

Mainnet deploy steps:
1. Generate `b402_nullifier-keypair.json`.
2. Drain dust from program ID (expect attacker re-dust).
3. Build, deploy `b402_nullifier` (~1.6 SOL).
4. Build, deploy upgraded `b402_pool` (program upgrade, ~0 incremental SOL beyond size delta).
5. Init: `set_light_address_tree` admin ix.
6. Smoke: shield 0.1 USDC, unshield to user-owned recipient, verify privacy property + Light tree state via Photon's `getCompressedAccount`.

## §6. Edge cases (from spike, locked here)

| # | Case | Required behavior | Test |
|---|---|---|---|
| E1 | Photon RPC down | SDK retries 3× w/ backoff; typed `RelayerProverUnavailable` error | T4.4 |
| E2 | Stale validity proof, root rotated | SDK refetches once, retries | T4.5 |
| E3 | Concurrent unshields for different notes, same slot | Both succeed via changelog buffer | T5.4 |
| E4 | Concurrent unshields for the same note | First lands; second fails `AddressAlreadyAssigned` | T5.3 (variant) |
| E5 | Reorg between confirm and finalize | `confirmed` commitment derivation safe | T5.5 |
| E6 | Light tree mid-rollover | Photon returns new tree pubkey; SDK uses whatever Photon hands back | manual |
| E7 | Forester offline | `QueueFull` error surfaces; runbook says "wait or run our own Forester" | manual |
| E8 | Malformed validity proof | Light rejects; `InvalidValidityProof` error | T1.5 |
| E9 | Address-space collision (256-bit space) | Mathematically infeasible; on-chain check still rejects | covered by T1.3 |
| E10 | Pool admin pauses shield | v2 unshield still succeeds for existing notes | covered by existing v1 invariant test, ported |
| E11 | Light upgrade authority pushes a malicious upgrade | Liveness fails; non-inclusion property may be subverted; mitigated by monitoring + version-lock | doc only |

## §7. Cost model (re-stated, math-checked from spike)

Per-unshield gas (relayer-side):

| Component | Lamports | Source |
|---|---|---|
| Solana base tx fee | 5,000 | protocol |
| Priority fee | 5,000 | typical mainnet |
| Light rollover fee | ~5,000 | Light docs ("very low"); to be confirmed in Phase 5 |
| **Subtotal** | **~15,000** | **~$0.003 at $190/SOL** |
| Recipient ATA rent | 2,039,280 | one-time per recipient per mint |

Acceptance criterion: T5.1 + T5.2 must measure average per-unshield gas ≤ 25,000 lamports across N=100. If observed > 25,000, this PRD is wrong about Light's rollover fee and we revisit before mainnet.

## §8. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| Light Protocol's `light-system-program` is upgraded malicious-ly | High | Monitor upgrade authority; lock to a specific Light version; document in trust model; consider forking Light's primitives if upgrade authority becomes a recurring concern |
| Photon indexer goes down, no other indexer available | Medium | Self-host Photon (open-source MIT); hosted Helius + Triton both run Photon; document failover |
| Forester ecosystem fails (all Foresters offline) | Medium | Permissionless; we run our own as backup |
| Light's address tree V2 capacity (1T leaves) reached | Low | Far future; tree rollover is built-in to Light's design |
| Per-unshield gas exceeds 25k lamports in measurement | Medium | If T5.1/T5.2 fails the budget, revisit Light's fee structure before mainnet |
| Phase-2 ceremony coordination delays mainnet deploy | None | Per §3.5, no new ceremony required; existing zkey is reused |

## §9. Sign-off and review

| Section | Reviewer | Date | Status |
|---|---|---|---|
| Architecture decision | mayur | TBD | pending |
| Trust model + Light dependency | mayur | TBD | pending |
| Test plan completeness | claude (self-review) | 2026-04-29 | done |
| Public-input list freeze (§3.5) | mayur | TBD | pending |
| Migration plan (§4) | mayur | TBD | pending |

PRD-30 is locked when all reviewers above have signed off. Implementation against this PRD does not begin until lock.

## §10. Implementation log

(Filled in as phases complete)

| Phase | Tests Green | Implementation Complete | Notes |
|---|---|---|---|
| 0 — Light fixture | — | — | |
| 1 — `b402_nullifier` | — | — | |
| 2 — pool integration | — | — | |
| 3 — circuit unchanged verification | — | — | |
| 4 — SDK + Photon | — | — | |
| 5 — e2e localnet + mainnet-fork | — | — | |
| 6 — mainnet deploy | — | — | |
