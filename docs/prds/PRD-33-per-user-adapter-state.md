# PRD-33 — Per-user adapter state via shielded-identity PDAs

| Field | Value |
|---|---|
| **Status** | Phase 33.1 + 33.2 + 33.3 implemented (local fork, awaiting mainnet redeploy) |
| **Owner** | b402 core |
| **Date** | 2026-05-02 (impl 2026-05-01) |
| **Version** | 0.2 |
| **Depends on** | PRD-09 (Kamino adapter), PRD-31 (indexer), Phase 9 (outSpendingPub public input) |
| **Gates** | private DeFi yield with intact set anonymity; Drift / Marginfi / Adrena adapters; V1.0 freeze |

---

## 1. Problem

Adapters that interact with stateful DeFi protocols (Kamino lend, Drift perps, Marginfi, Adrena) currently route every b402 user's interaction through a **single shared protocol-side account** owned by the adapter PDA. The Kamino adapter v0.1 is the canonical example: every b402 deposit hits the same Kamino `Obligation` account.

Three concrete failures of the shared-state model:

1. **Privacy poison at the protocol surface.** An observer who watches Kamino's obligation accounts sees every b402 deposit funnel through the same `owner = adapter_authority`. b402's pool-side anonymity is intact, but the moment funds touch Kamino, the set anonymity at Kamino's surface collapses to "is this from b402". A regulator or chain analyst tracking the shared obligation learns the **aggregate volume of every b402 user**.

2. **Liquidation blast radius.** Any one user who borrows aggressively against the shared obligation can trigger a liquidation that seizes **all other users'** collateral. The pool of shared deposits is one bad actor away from cascade.

3. **Withdraw correctness for non-trivial actions.** Borrowing requires per-user repayment tracking. The shared obligation has no record of "user A owes 100 USDC, user B owes 50". For deposit/redeem-only flows the kUSDC token is the receipt, but the moment we add a borrow path the model breaks down.

These are not implementation bugs. They are properties of the architectural choice to share protocol-side state.

## 2. Goal

A general pattern for adapters where each shielded user gets their own protocol-side state account, deterministically derived from on-chain-visible-but-anonymous identity. Specifically:

- Each b402 user has a unique `owner_pda` derived from a value that's known to the prover and bound into the proof, but does not link to any public identity outside b402.
- The adapter `invoke_signed`s the protocol-level ix with the user's `owner_pda` as the "user" account.
- Protocol-level set anonymity becomes **1-of-N b402 users**, not 1.
- Liquidation / borrow correctness is per-user; no cross-user blast.

## 3. The shielded-identity PDA construction

### 3.1 Identity source: `outSpendingPub` (Phase 9)

Post-Phase-9, every adapt_execute proof has `outSpendingPub[0]` as a public input (verifier index 23). This is the user's spending pubkey — a Poseidon image scalar, not a Solana pubkey, but a stable per-user identifier that:

- The user can compute deterministically from their viewing key
- The prover binds into every proof
- The pool can read off the proof without trusting the SDK
- An external observer cannot link to any publicly-known address (it's the OUTPUT of a Poseidon hash over the user's secret seed)

This gives us a pseudonymous user identifier, on-chain-visible, no circuit changes needed.

### 3.2 PDA derivation

```
viewing_pub_hash = bytes_le(outSpendingPub)[0..32]   // already 32B Fr, no extra hash needed

owner_pda = PDA(
  &[b"b402/v1", b"adapter-owner", viewing_pub_hash],
  adapter_program_id,
)
```

Properties:

- Per-adapter: the same user has DIFFERENT `owner_pda`s for Kamino, Drift, Marginfi etc. (because each adapter is a different `program_id`). Cross-protocol correlation by `owner_pda` alone is not possible.
- Deterministic: SDK can compute `owner_pda` client-side without an extra round trip.
- Unspoofable: `viewing_pub_hash` is bound by the proof; pool will reject any adapt_execute whose claimed `outSpendingPub` doesn't match what the prover produced.

### 3.3 Adapter-side signing

Adapters that compose protocol ixs `invoke_signed` with two seed sets simultaneously:

```rust
let auth_seeds: &[&[u8]] = &[b"b402/v1", b"adapter", &[bumps.adapter_authority]];
let owner_seeds: &[&[u8]] = &[b"b402/v1", b"adapter-owner", viewing_pub_hash, &[bumps.owner_pda]];

invoke_signed(
    &kamino_deposit_ix,
    &accounts,
    &[auth_seeds, owner_seeds],
)?;
```

`adapter_authority` signs the b402-side vault transfers (unchanged). `owner_pda` signs Kamino's obligation-write ixs. Both PDAs are owned by the adapter program; no third-party signing.

### 3.4 Pool-side binding

Today's pool reads `outSpendingPub` from the proof and uses it for the Phase 9 excess-leaf commitment. The same value is forwarded to the adapter via `Context::accounts.adapter_args` as a 32B parameter (NEW). Adapter then derives `viewing_pub_hash` and `owner_pda` from it.

This is a 1-line change in `programs/b402-pool/src/instructions/adapt_execute.rs`: pass `pi.out_spending_pub` into the adapter ix data. **No circuit change. No re-ceremony.** The proof already binds outSpendingPub.

## 4. Generalization to other adapters

The pattern: any DeFi protocol that takes a `user` or `owner` account as input becomes a per-user adapter target.

| Protocol | Per-user account | b402 PDA derivation | Notes |
|---|---|---|---|
| **Kamino lend** | `Obligation` (per user) + `UserMetadata` | `owner_pda` per `viewing_pub_hash` | The motivating case |
| **Drift perps** | `User` (SubAccount) + `UserStats` | Same pattern | Sub-account ID = 0 always |
| **Marginfi** | `MarginfiAccount` | Same pattern | Single account per user per group |
| **Adrena perps** | `UserStaking` + `Position` | Per-user PDAs | Multi-position support needs an extra index |
| **Jupiter swap** | None — stateless | Not needed | Already private; current adapter is the right design |
| **Orca whirlpool LP** | Position NFT | Different — NFT model, owner is whoever holds the mint | Treat the NFT as a shielded note (re-shield the position NFT itself) |
| **Sanctum LST stake** | None — stateless mint/burn | Not needed | Same as Jupiter |

**Stateless protocols (Jupiter, Sanctum, Phoenix LP-less swaps)** do not need this PRD's machinery. The current `adapter_authority`-only design is correct.

**Stateful protocols (Kamino, Drift, Marginfi, Adrena)** all share the same architectural envelope: per-user PDA derivation from `viewing_pub_hash`, dual-seed `invoke_signed`, no cross-user state mixing.

**NFT-position protocols (Orca, Meteora DLMM positions)** are a separate problem — the position itself is the receipt and can be reshielded as a b402 note (treat the position NFT mint as a private mint type). Out of scope for this PRD.

## 5. Storage / rent scaling

Each per-user `Obligation` (or equivalent) is a real on-chain account paying rent. Rough numbers:

| Protocol | Account size | Rent at 6960 lamports/byte | At 1k users |
|---|---|---|---|
| Kamino Obligation | ~3,344 B | ~0.023 SOL | ~23 SOL |
| Kamino UserMetadata | ~1,016 B | ~0.007 SOL | ~7 SOL |
| Drift User | ~4,376 B | ~0.030 SOL | ~30 SOL |
| Drift UserStats | ~424 B | ~0.003 SOL | ~3 SOL |
| Marginfi MarginfiAccount | ~2,304 B | ~0.016 SOL | ~16 SOL |

**Implications:**

- The adapter's PDA is the rent-payer (since users are anonymous). For 1000 active users on Kamino: ~30 SOL of locked rent in the adapter program.
- This is acceptable for V1.0 alpha (10s of users). Becomes meaningful at 10k users (~300 SOL = ~$30k locked).
- Mitigation 1: **lazy init** — only create the per-user obligation on the user's first deposit, not at "signup" (we have no signup anyway).
- Mitigation 2: **garbage collect** — admin-callable ix that closes empty obligations + recovers rent. Per-user opt-in (user signs a close-my-obligation request via shielded action).
- Mitigation 3: **tiered privacy** — small users (< $100 deposit) opt into a shared-N-of-100 obligation pool with degraded privacy; large users get their own. Trade-off explicit and chosen by user.

For V1.0 alpha + first 1k users: lazy init alone is sufficient. (1) and (2). (3) is a V1.5 concern.

## 6. Implementation plan

### Phase 33.1 — Pool-side outSpendingPub forwarding (~4h)

`programs/b402-pool/src/instructions/adapt_execute.rs` already reads `pi.out_spending_pub` (Phase 9 feature-gated). Forward it as an extra 32B in the adapter ix data. Adapter signature already has `viewing_pub_hash` slot (per the PRD-09 §7.2 design).

Tests: vector parity test extends to assert `out_spending_pub` = `viewing_pub_hash` round-trips byte-equal between SDK + pool + adapter.

### Phase 33.2 — Kamino adapter Path 1 implementation (~1.5d)

`programs/b402-kamino-adapter/src/lib.rs`:
- Add `derive_owner_pda(viewing_pub_hash)` helper
- Modify Deposit handler: derive `owner_pda`, init Kamino UserMetadata + Obligation if not present (lazy init), `invoke_signed` with both seed sets
- Modify Withdraw handler: same `owner_pda` derivation, `redeem_reserve_collateral` against the user's obligation (not via shared)
- Borrow / Repay handlers: same envelope; needed for V1.5

Tests: `tests/v2/e2e/v2_fork_lend.test.ts` runs N=3 distinct b402 users through deposit + withdraw, asserts each Kamino obligation is independent + unique.

### Phase 33.3 — Mainnet-fork verification (~4h)

Reuse `tests/v2/scripts/start-mainnet-fork.sh` with KAMINO_DATA_LIMIT=7. Run the multi-user fork test against cloned `klend` mainnet bytecode.

Pass criteria:
- Three distinct `viewing_pub_hash`es produce three distinct `Obligation` accounts (`solana account` per-account inspection)
- Each obligation's `owner` matches the SDK-derived `owner_pda` for that user
- Liquidation simulation: borrow 80% LTV against user A's obligation, push price to liquidation threshold — verify only user A's collateral is seized; users B and C unaffected
- Withdraw round-trip for user A returns the right kUSDC → USDC amount, user B's deposit untouched

### Phase 33.4 — Mainnet redeploy (~30 min)

Same as Phase 9 deploy script — `solana program upgrade` against the existing `2enwFg...` program ID. **Free upgrade** (no extend if size doesn't grow); buffer rent fully refunded.

### Phase 33.5 — Drift / Marginfi / Adrena adapters (~3d each)

Same envelope. Each adapter is a separate Rust crate following the Kamino template post-33.2. Schedule based on demand.

**Total Path 1 effort for Kamino: ~2 days focused.** Drift + Marginfi follow at ~3d each once the pattern is locked.

### 6.1 Stateful-adapter wire shape

The per-user payload prefix is invisible to the SDK at proof-generation time and to the adapter at-rest. The pool inserts it in flight. End-to-end the bytes flow:

```
SDK builds:
  action_payload      = Borsh(KaminoAction::Deposit{...})       (49 B)
  raw_adapter_ix_data = [8 disc][8 in_amount][8 min_out][4 len=49][action_payload]
  args                = AdaptExecuteArgs { action_payload, raw_adapter_ix_data, ... }

Pool receives args:
  - action_hash binding uses keccak(args.action_payload). Proof was
    generated over the same bytes (no prefix).
  - if is_stateful_adapter(adapter_program_key) AND phase_9_dual_note:
        cpi_ix_data = surgically rewrite raw_adapter_ix_data so the
                      embedded action_payload becomes
                      [32 viewing_pub_hash][original action_payload].
                      Length prefix bumped 49 → 81.
    else:
        cpi_ix_data = raw_adapter_ix_data unchanged.
  - invoke(adapter, cpi_ix_data)

Adapter receives cpi_ix_data:
  - decodes [8 disc][8 in_amount][8 min_out][4 len=81][81 B payload]
  - per_user_obligation build: decode_per_user_payload extracts
    [32 viewing_pub_hash][49 KaminoAction]
  - default build: try_from_slice on 49 B succeeds; the 32-B prefix
    isn't sent because is_stateful_adapter returns true ONLY in pools
    built with phase_9_dual_note + the matching adapter feature.
```

**Rationale for the in-flight rewrite (not SDK-side):**

- SDK prepending the prefix would require the proof's `action_hash` binding to also include the prefix. That makes the SDK's payload byte-identical to what the adapter sees, but makes the prover's circuit input dependent on the runtime adapter ID — leaking which adapter is being targeted to the prover toolchain. Pool-side rewrite keeps the prover oblivious.
- `args.action_payload` (the proof-bound bytes) and the wire-CPI bytes are now allowed to differ. The split is documented and load-bearing.
- Stateless adapters (Jupiter, Sanctum, mock) are forwarded byte-for-byte unchanged. No regressions.

**`is_stateful_adapter` is a hardcoded const list** in `programs/b402-pool/src/instructions/adapt_execute.rs` rather than a registry flag. Adding a new stateful adapter = one-line edit + pool upgrade. The alternative (extending `AdapterInfo` with a bool) reshapes the on-chain `AdapterRegistry` Vec inner-element layout, requiring a full registry re-init at upgrade time — operationally equivalent but with on-chain-state-migration risk that the const list avoids.

## 7. Limitations

### Hard limitations (cannot be designed away)

1. **Protocols requiring KYC or whitelisted user accounts** — incompatible. Examples: anything that gates user account creation behind a Squad signature or external identity. Not a problem for any DeFi primitive we currently target.

2. **Protocols with global per-user state observable by third parties** — e.g., a protocol that emits a per-user volume leaderboard using the `owner` field. Even with per-user PDAs, the per-PDA volume is now public. Mitigation: don't use protocols that doxx user volume. Kamino, Drift, Marginfi don't.

3. **Cross-protocol state correlation via shared subaccount addresses** — if an adapter mistakenly reuses the same PDA seed across protocols, an observer who sees the same `owner_pda` on Kamino AND Drift can correlate. Mitigation: PER-ADAPTER PDA derivation (each adapter is its own program; PDA addresses naturally differ). Already in §3.2.

### Soft limitations (acceptable trade-offs)

4. **Rent locked in adapter program** — addressed in §5. Becomes a real cost at scale; lazy init + garbage collect mitigate.

5. **Per-user account creation costs CU on first deposit** — Kamino's `init_obligation` ix is ~50K CU. First-deposit txs pay this; subsequent deposits don't. Acceptable.

6. **Transaction account-list growth** — each per-user obligation adds 1 account to the deposit ix's `remaining_accounts`. With Kamino's 19-account `ra_deposit`, +1 is fine; ALT compresses. At extreme nesting (3-protocol composition) we'd hit the 1232 B cap. Out of scope here.

7. **No migration path for existing v0.1 deposits** — the v0.1 shared obligation has whatever's in it from prior testing. Cannot retroactively migrate to per-user. **For V1.0 launch: drain the shared obligation first (one full withdraw), then upgrade adapter, then begin per-user deposits.** ~5 min op.

## 8. Scaling estimates

Assuming the Kamino adapter is the heaviest user (each user gets ~4.5 KB of state across Obligation + UserMetadata):

| Active users | Adapter rent | Notes |
|---|---|---|
| 100 | ~3 SOL | Trivial; alpha cost |
| 1,000 | ~30 SOL | V1 launch budget |
| 10,000 | ~300 SOL (~$30k @ $100 SOL) | Real expense; needs garbage-collect ix funded |
| 100,000 | ~3,000 SOL | Requires the tiered model from §5 mitigation 3 |

Beyond 100k active depositors, the on-chain rent argues for tiered privacy or a fundamentally different design (zk-VM + off-chain state proof, way out of scope).

For the V1.0 alpha → year-1 trajectory (target: 1k-10k users), the rent budget is real but manageable. Build the garbage-collect ix in 33.2 and we're fine.

## 9. Done criteria

PRD-33 ships Phase 33.1 + 33.2 + 33.3 + 33.4 when:

- Three concurrent b402 users on mainnet-fork have independent Kamino obligations
- Liquidation of one does not affect the others (verified)
- Withdraw round-trip works per-user
- Garbage-collect ix recovers rent on demand
- Mainnet redeploy of `2enwFg...` is one command
- Net cost is <0.05 SOL (free upgrade since binary size doesn't grow meaningfully)

V1.0 launch gates on this PRD's deliverables for any deposit/yield narrative claim.

## 10. Open questions

- **Sub-account index**: Drift supports multiple SubAccounts per User. Kamino allows multiple obligations per UserMetadata. Should b402 expose this to the user (via an SDK `subAccountIndex` parameter), or hardcode index = 0? Proposal: hardcode 0 in V1.0; multi-sub-account is V1.5.
- **Migration of v0.1 shared-obligation deposits**: as noted in §7.7, drain-and-upgrade is the simplest path. Alternative is an in-place migration ix that splits the shared obligation per `viewing_pub_hash` — much harder, not worth the complexity for an alpha with a handful of test deposits.
- **Cross-adapter user identity unification**: should the SDK expose a `b402.userIdentityHash` so the user can prove "I am the same b402 user across Kamino + Drift" if they want to (e.g., for a future loyalty program)? Probably not — defeats the purpose of per-adapter isolation. Document as a non-feature.

---

## Appendix: relation to similar projects

| Project | Per-user state model | Notes |
|---|---|---|
| **Aztec / zkSync L2 wallets** | Each user has a unique L2 address; protocol-state is per-address natively | Not directly comparable — full L2, not adapter-on-L1 |
| **Penumbra** | Penumbra is its own L1 with native per-user shielded state; doesn't bridge to external L1 protocols | Not adapter-pattern |
| **Railgun (EVM)** | Adapt module routes through `RailgunSmartWallet` per-tx; no persistent per-user state on Compound/Aave because the protocol-side `user` is the wallet contract per call | Single-tx state; b402's adapter is similar but Solana account model forces persistent obligation |
| **b402 (this PRD)** | Persistent per-user PDA derived from shielded identity; signs into protocol-level user accounts | Closest to Railgun's pattern adapted for Solana's stateful program model |

Solana's program-account model is the constraint that forces persistent per-user state where Railgun on EVM gets away with per-tx ephemeral state. Path 1 is the cleanest version of "embrace the constraint, make it private anyway".

---

## 11. Implementation status as of 2026-05-01

### Shipped on `feat/phase-9-deploy` (local commits, NOT pushed)

**Phase 33.1 — pool-side forwarding** (`programs/b402-pool/src/instructions/adapt_execute.rs`):
- Hardcoded `is_stateful_adapter(program_id)` const list — Kamino is the only entry today.
- `prepend_viewing_pub_hash_to_action_payload` surgically rewrites `args.raw_adapter_ix_data` so the embedded `action_payload` is prefixed with `pi.out_spending_pub` (32 B) and the u32 length prefix bumped by +32. Defence-in-depth: short input, truncated payload, u32 overflow all return `InvalidInstructionData`.
- Feature-gated on `phase_9_dual_note` (the only build that carries `pi.out_spending_pub`). Default builds skip the rewrite — backward-compatible with the v0.1 alpha pool.

**Phase 33.2 — Kamino adapter Path 1** (`programs/b402-kamino-adapter/src/lib.rs`):
- New `per_user_obligation` cargo feature, default OFF.
- `derive_owner_pda(adapter_program_id, viewing_pub_hash)` per PRD-33 §3.2.
- `decode_per_user_payload` extracts `[32 viewing_pub_hash][KaminoAction borsh]`.
- `handle_deposit_per_user`: lazy-init Kamino UserMetadata + Obligation + (if reserve has farm) ObligationFarmsForReserve, then refresh + deposit_v2. All ixs sign with **dual seed sets** — `auth_seeds` for `adapter_authority` (rent payer, post-CPI sweep) + `owner_seeds` for the per-user PDA (Kamino's obligation owner).
- `build_kamino_ix` extended to take `&[Pubkey]` of signer keys (was a single `auth_key`). Path 2 callers pass `&[auth_key]`; Path 1 callers pass `&[auth_key, owner_key]`.
- `OwnerPdaMismatch` (6010) — adapter validates the owner PDA forwarded in `remaining_accounts` matches the hash-derived PDA, defence against caller-side substitution.
- `gc_obligation` ix scaffold (admin-gated `GcObligation` Accounts + IDL slot). Body returns `NotYetImplemented` pending klend close-ix discriminator review (Phase 33.4 PR).

**Phase 33.3 — fork verification** (`tests/v2/e2e/v2_fork_lend_per_user.test.ts`):
- 3 distinct b402 users (alice/bob/carol — fresh keypairs, fresh viewing keys, USDC distributed via on-fork SPL transfers from alice's injected balance).
- Asserts (1) distinct owner PDAs (2) distinct obligation PDAs (3) per-user kUSDC delta > 0 (4) on-chain obligation `owner` field at offset 16 matches the SDK-derived owner PDA — proves Kamino actually wrote the per-user PDA as obligation owner (5) cross-isolation re-confirmed at on-chain account level.

**Test coverage**:
- `programs/b402-kamino-adapter/tests/per_user_payload.rs`: 7 host-side tests covering `decode_per_user_payload` happy path + 2 rejection cases + `derive_owner_pda` determinism + 3-user distinctness + bit-flip sensitivity + PRD §3.2 seed-list pin.
- `programs/b402-pool/src/instructions/adapt_execute.rs::stateful_adapter_forwarding_tests`: 7 unit tests covering byte layout, length-prefix bump, empty-payload edge, malformed-input rejection, stateful-list lookup, end-to-end round-trip through the kamino-decoder shape.
- `programs/b402-kamino-adapter/tests/payload.rs`: 7 pre-existing tests still green (no regression in the v0.1 wire format).
- BPF builds clean: `cargo build-sbf -p b402-kamino-adapter --features per_user_obligation` + `cargo build-sbf -p b402-pool --features inline_cpi_nullifier,phase_9_dual_note`.

### Deferred (out of this PR's scope)

- **Phase 33.2 Withdraw / Borrow / Repay per-user handlers**: scaffold present (`handle_withdraw` / `handle_borrow` / `handle_repay` exist as Path 2 placeholders gated `NotYetImplemented` at dispatch). Deposit was the V1.0 yield-narrative gate; redeem path goes through the existing kUSDC-as-receipt model so withdraw-via-this-adapter is a V1.5 concern. The dual-seed-set + `decode_per_user_payload` envelope from `handle_deposit_per_user` ports verbatim once the Kamino redeem ix's account list is locked.
- **Garbage-collect body** (`gc_obligation`): scaffold landed, body returns `NotYetImplemented`. Wiring needs verified klend `delete_user_metadata` + `close_obligation` discriminators + an emptiness pre-check. PRD-33 Phase 33.4 cleanup PR follows.
- **Liquidation-isolation Pyth-price simulation**: deferred to Phase 33.3.1 follow-up. Account-level isolation (this PR) is sufficient for the V1.0 ship gate — PDAs are independent on-chain accounts so a hypothetical liquidation can only touch the targeted obligation.
- **AdapterRegistry `stateful_adapter` field**: rejected in favour of the const list (see §6.1 rationale). Drift / Marginfi adapters land via one-line edits to `is_stateful_adapter`.

### Open questions for mayur to confirm before mainnet flip

1. **Default flip timing.** `per_user_obligation` is OFF in default kamino-adapter builds. PRD §7.7 calls out a drain-and-upgrade flow: drain the v0.1 shared obligation (one full withdraw), upgrade adapter to per-user binary, begin per-user deposits. Confirm the drain step before flipping the default.
2. **Mainnet redeploy ordering.** Pool first or adapter first? Per §6.1, the rewrite is gated on `phase_9_dual_note` AND `is_stateful_adapter`. If adapter ships per-user first while pool is still on default-feature build, pool will forward unprefixed payload → adapter's `decode_per_user_payload` fails on length check → tx aborts. Safe ordering: **pool with `phase_9_dual_note` first** (already deployed mainnet 2026-04-30 per project_b402_solana_phase7_live), THEN adapter with `per_user_obligation`.
3. **`gc_obligation` admin model.** Currently scaffolded as `admin: Signer` with no on-chain auth check. V1.0 wants either (a) restrict to `cfg.admin_multisig` (requires loading PoolConfig via CPI — adds 1 account) or (b) leave admin-open + rely on Kamino's own emptiness check (cheaper, looser). Pick before wiring the body.
4. **SDK exposure of `viewing_pub_hash` derivation.** The fork test re-derives owner_pda from `wallet.spendingPub` inside the test. The SDK's privateLend/privateRedeem helpers should auto-compute the per-user PDAs and inject them into `remainingAccounts` so callers don't need to know about the PDA layout. Out of this PR (no SDK changes).
5. **Adapter program-account-meta growth.** Per-user adds 1 account (owner_pda) to the `remaining_accounts` list. With Kamino's 19-account `ra_deposit`, the new layout has 20. ALT compresses the rest. Confirm wire size still <1232 B in the fork test on first run; if the per-user setup overflows, ALT-resident the per-user PDAs (cheap — they're stable per-user).

### Commit graph (local, not pushed)

```
49938d3 prd-33: per-user adapter state spec + failing TDD scaffold
494b343 kamino-adapter: per-user obligation helpers + feature flag (PRD-33 §3.2)
a6ec151 kamino-adapter: per-user deposit handler under per_user_obligation feature
b47c331 kamino-adapter: gc_obligation scaffold (PRD-33 §5 mitigation 2)
5d08090 sdk 0.0.14 + mcp 0.0.20: HOTFIX (carrier commit — pool 33.1 changes
        landed here from a parallel session; review the pool diff inside
        this commit alongside the kamino-adapter commits above)
11c94ce tests/v2: PRD-33 §33.3 mainnet-fork per-user obligation isolation
```

The pool changes landed in `5d08090` because of git index timing across a parallel session — the diff itself is the Phase 33.1 work (search for `is_stateful_adapter` + `prepend_viewing_pub_hash_to_action_payload`). Operationally fine; review-noise to flag.

