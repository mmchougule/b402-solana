# PRD-04 — Composability Layer (RelayAdapt on Solana)

| Field | Value |
|---|---|
| **Status** | Draft — awaiting review |
| **Owner** | b402 core |
| **Date** | 2026-04-23 |
| **Version** | 0.1 |
| **Depends on** | PRD-01, 02, 03 |
| **Gates** | PRD-05 (per-adapter specs), adapter implementation |

Railgun on EVM uses a RelayAdapt contract that the privacy contract `delegatecall`s to execute arbitrary DeFi actions with shielded funds. Solana has no delegatecall. This PRD defines the equivalent pattern on Solana — how the pool composes with arbitrary DeFi programs while preserving the invariant that **the pool never trusts the downstream program with more than a proof-bound input and must receive at least a proof-bound output**.

---

## 1. Design goals

1. **Atomic** — one Solana transaction: unshield input → adapter acts → reshield output. Partial execution is impossible.
2. **Adapter isolation** — adapter bugs cannot drain the pool. The pool's safety relies on vault-balance-delta measurement, not adapter honesty.
3. **Extensible** — new DeFi protocols require a new adapter program, not a pool change. Adding an adapter is a governance action, not a protocol upgrade.
4. **Proof-bound** — the circuit commits the user to a specific action hash + expected output floor, so no relayer or MEV searcher can substitute a different action.
5. **Account-budget realistic** — Solana's ~1,232 B tx size and practical account limits (~35-ish per tx before ALTs) bound what we can compose.

---

## 2. The adapter ABI contract

Every b402 adapter program implements the following Anchor IDL interface:

```rust
/// Standard b402 adapter entrypoint.
/// Called by `b402_pool` via CPI after it has transferred `in_amount` of `in_mint`
/// into the adapter's input token account (derived as an ATA of the adapter's PDA).
/// The adapter executes its DeFi action and MUST leave at least `min_out_amount`
/// of `out_mint` in the pool's `VaultOut` (provided in accounts).
/// If the adapter cannot meet this floor, it must fail the CPI — any tokens
/// sent back to the pool's vault below the floor will trip the pool's post-check
/// and revert the whole tx anyway, so failing early is strictly better UX.
#[derive(Accounts)]
pub struct AdapterExecute<'info> {
    // Adapter's own PDA signer (seeds = [b"b402/v1", b"adapter"])
    #[account(mut, seeds = [b"b402/v1", b"adapter"], bump)]
    pub adapter_authority: SystemAccount<'info>,

    // Pool vaults — pool has already moved `in_amount` in
    #[account(mut)]
    pub in_vault: Account<'info, TokenAccount>,   // pool's vault for in_mint
    #[account(mut)]
    pub out_vault: Account<'info, TokenAccount>,  // pool's vault for out_mint

    // Adapter-local scratch accounts
    #[account(mut)]
    pub adapter_in_ta: Account<'info, TokenAccount>,
    #[account(mut)]
    pub adapter_out_ta: Account<'info, TokenAccount>,

    // Remaining accounts — whatever the downstream protocol needs
    // (passed through opaquely from the pool tx)
    pub token_program: Program<'info, Token>,
    // `remaining_accounts` = downstream-protocol accounts
}

pub fn execute(
    ctx: Context<AdapterExecute>,
    in_amount: u64,
    min_out_amount: u64,
    action_payload: Vec<u8>,  // opaque to the pool; adapter-specific
) -> Result<()>;
```

The adapter decodes `action_payload` into its own per-protocol instruction arguments (route plan, slippage, perp order, etc.) and performs the downstream CPIs.

### 2.1 Constraint: `action_payload` uniqueness

The pool's circuit binds `actionHash = Poseidon_2(adaptBindTag, keccak256(action_payload), expectedOutMint_Fr)`. The adapter receives the same `action_payload` bytes. If a relayer tampers with the payload between proof generation and submission, the on-chain hash check in the pool fails.

Hash choice: we use `keccak256` on `action_payload` (not Poseidon) for the byte-level hash because:
- Solana has a `sol_keccak256` syscall (cheap).
- Adapter payload is variable-length bytes; Poseidon requires field encoding, more expensive for variable length.
- Then Poseidon combines the keccak digest with the mint. One Poseidon, one keccak. Both cheap.

### 2.2 Adapter cannot touch arbitrary pool state

The pool passes exactly the accounts needed: input vault, output vault, the adapter's own scratch token accounts, and downstream-protocol accounts. The adapter cannot read or write `TreeState`, `NullifierShard`, or `PoolConfig` because those accounts are not passed in.

---

## 3. Pool-side control flow

Full sequence for `adapt_execute`, expanded from PRD-03 §4.6:

```
1. Verify PoolConfig (not paused for adapts).
2. Parse AdaptPublicInputs, assert inputs:
   - in_mint matches TokenConfig whitelisted
   - out_mint matches TokenConfig whitelisted
   - adapter_id found in AdapterRegistry, enabled
   - relayer_fee ≤ in_amount
3. Verify proof via b402_verifier_adapt.
4. Record pre_balance_in = in_vault.amount
   Record pre_balance_out = out_vault.amount
5. Spawn Vault PDA signer seeds.
6. CPI: token::transfer(in_vault → adapter_in_ta, in_amount_for_adapter)
   where in_amount_for_adapter = in_amount (relayer fee handled separately, see §3.1)
7. CPI: adapter.execute(in_amount_for_adapter, expected_out_value, action_payload)
   with remaining_accounts passed through.
8. Assert: out_vault.amount ≥ pre_balance_out + expected_out_value
   Else: AdapterReturnedLessThanMin — tx reverts.
9. Insert nullifiers into shards.
10. Append commitments to tree. These commitments hold out_mint and sum to
    (new_out_balance - pre_balance_out - minor slippage reserve).
11. Pay relayer fee from input vault (SOL rent or in-mint fee, see §3.1).
12. Emit AdaptCompleted event.
```

### 3.1 Relayer fee in adapt flows

Three fee-shape options; we pick **(a)** for v1:

(a) **Fee in input mint, pre-adapter.** Relayer fee is deducted from `public_amount_out_from_pool = circuit_in_amount`, before the adapter runs. E.g., user shields 100 USDC, adapts with in_amount 99 USDC + 1 USDC relayer fee.

(b) Fee in output mint, post-adapter. Requires the circuit to know the output mint's rate vs. fee — messier.

(c) Fee in SOL from relayer, reimbursed off-chain. Bad UX.

(a) is simplest and what Railgun RelayAdapt does.

### 3.2 Rent handling

New `NullifierShard` and `TreeState` reallocation are paid by the relayer in SOL; recovered in-kind via the fee.

---

## 4. Reentrancy

Solana's program runtime **does not support traditional reentrancy** — a program cannot CPI back into itself beyond a depth of 1, and our pool instructions do not CPI into `b402_pool`.

However, adapter CPIs **can** invoke other programs that touch shared accounts. We protect against this by:

1. Pool's state writes (nullifier inserts, tree append) happen **after** the adapter CPI returns. If the adapter or downstream program somehow manages a reentrant path back into pool state, it finds nullifiers already asserted-unspent but not yet written, and the tree frontier not yet updated. The reentrant path would need to pass proof verification first — which requires a valid proof against the CURRENT root and a nullifier set that does not contain the current nullifier. Circular; can't happen.
2. Token transfers from the vault require the pool's PDA signer. The adapter cannot sign as the pool. Therefore the adapter cannot drain the vault outside the path we explicitly CPI for.
3. We do not use any callback pattern; every CPI returns control synchronously.

Formal statement of the invariant:

> **Post-CPI balance invariant.** For any adapter CPI, `out_vault.amount` after the CPI ≥ pre-CPI balance + expected_out. Enforced by program read + require!. Adapters cannot circumvent this because the pool reads the vault directly, not via adapter-reported values.

---

## 5. Transaction-size and account-budget accounting

### 5.1 Account budget per adapt_execute tx

Fixed (pool-side): ~12 accounts.
Variable (adapter-side): depends on downstream protocol.

| Adapter | Typical downstream accounts | Total tx accounts |
|---|---|---|
| Jupiter (2-hop Whirlpool) | ~14 | ~26 |
| Jupiter (3-hop) | ~20 | ~32 |
| Kamino vault deposit | ~8 | ~20 |
| Drift perp open | ~15 | ~27 |
| Orca Whirlpool LP increase | ~12 | ~24 |

Solana ABI allows 35-ish accounts before Account Lookup Tables kick in.

### 5.2 Account Lookup Tables (ALTs)

We ship a b402-owned ALT seeded with common downstream accounts (Jupiter router program, Kamino market program, Drift state accounts, popular mint addresses, USDC reserve, etc.). The ALT is a public address on devnet and mainnet; SDK includes it in every adapt tx by default.

With the ALT, typical account budget per tx reduces by ~15–20 accounts, comfortably supporting 3-hop Jupiter routes.

### 5.3 Instruction-data size

Proof (256) + 11 public inputs × 32 = 608 B + `action_payload`. `action_payload` is capped at **400 B** in v1. Total instruction data ~1,100 B, fits within Solana's tx size limit (1,232 B).

---

## 6. Partial-execution refund path

If the adapter's downstream protocol returns a non-zero-but-less-than-min amount (e.g., Jupiter route returned 0.98 of expected due to pool imbalance), the pool reverts the whole tx in step 8. The user's notes are NOT spent. No state mutation persists.

If the adapter crashes mid-execution (CPI returns `Err`), Solana reverts the tx. Same outcome.

There is no "partial reshield" path. Atomic or nothing.

**UX implication:** slippage is paid by the user at setup time — the circuit's `expected_out_value` is the user's floor. If they set it too high, transactions revert often. SDK recommends ~0.5% buffer below Jupiter's quoted rate.

---

## 7. Adapter registry semantics

From PRD-03 §3.4:

```rust
pub struct AdapterInfo {
    pub adapter_id: [u8; 32],              // Poseidon(program_id_as_Fr)
    pub program_id: Pubkey,
    pub allowed_instructions: Vec<[u8; 8]>, // instruction discriminators whitelisted
    pub enabled: bool,
}
```

`allowed_instructions` is a finer-grain check. An adapter program may expose multiple entrypoints (`execute_swap`, `execute_deposit`, etc.). Registry records which discriminators are approved. Pool extracts the CPI instruction discriminator before invoking and rejects unknown ones.

**Why:** reduces blast radius if an adapter exposes an unsafe entrypoint that slips past audit. Registry whitelist is a second line of defense.

---

## 8. Emergency disable

`disable_adapter(adapter_id)` can be invoked by any single multisig signer (threshold=1 for disable, threshold=k for enable). Immediately flips `enabled = false`. All subsequent `adapt_execute` calls using that adapter fail `AdapterNotRegistered`.

This is the "kill switch" for a discovered adapter bug. Users are unaffected for shield/unshield/transact. Existing shielded positions remain recoverable — users can unshield and re-enter via a different adapter or wait for a fixed version.

---

## 9. Adapter upgrade policy

Same as pool: 12-month 3-of-5 multisig with 72-hour timelock, then immutable.

Adapters are smaller and higher-turnover — they integrate with external protocols that themselves upgrade. We accept that adapters stay upgradable longer than the pool. If protocol X upgrades its program, the corresponding adapter needs a corresponding update.

**Upgrade coordination:** if an adapter upgrade changes its ABI or allowed instructions, admin must also update the `AdapterRegistry` entry. SDK reads the registry at proof-gen time to ensure the client's expected ABI matches on-chain.

---

## 10. Failure modes & telemetry

Events emitted for every adapt attempt (success OR failure from the pool's perspective):

```rust
#[event]
pub struct AdaptAttempted {
    pub adapter_id: [u8; 32],
    pub slot: u64,
    pub in_mint: Pubkey,
    pub in_amount: u64,
    pub expected_out_mint: Pubkey,
    pub expected_out_min: u64,
}

// On success: AdaptCompleted (PRD-03 §6)
// On failure: Solana tx fails; no event emitted on-chain. Off-chain relayer logs failure reason.
```

The relayer service tracks adapter failure rates per protocol; SDK clients are alerted to high failure rates via status endpoint (e.g., "Kamino adapter currently at 40% failure rate — consider waiting").

---

## 11. Security considerations — adapter-specific risk checklist

Every new adapter must be reviewed against this checklist before registration:

1. **Does the downstream program transfer tokens OUT of anywhere owned by b402?** Only `adapter_in_ta` balance. Pool's vault is not exposed to downstream except via the controlled `in_amount` transfer.
2. **Can the downstream program escalate privileges?** No account the pool passes carries pool signer authority. Adapter's PDA is the signer for any transfer back; pool never passes its own PDA signer seeds.
3. **Can downstream return a different mint than claimed?** `expected_out_mint` is bound in circuit + checked at return-balance-check step.
4. **Can downstream fail silently with no revert?** Pool measures balance delta; it cannot.
5. **Does downstream do anything persistent that affects future adapts?** E.g., Drift opens a position tied to adapter's PDA. Per-position accounting lives in the adapter; pool only sees net token deltas per call. Perp position state = adapter-local.
6. **Is there an oracle dependency?** Yes for Drift (Pyth). Oracle failure → downstream reverts → pool reverts. No partial state.
7. **Is there a time-bomb / version coupling?** Some protocols sunset old versions. Adapter should pin to stable entrypoints.

Checklist lives at `b402-solana/ops/adapter-review.md`; each adapter PR must fill it out.

---

## 12. Revision history

| Version | Date | Author | Changes |
|---|---|---|---|
| 0.1 | 2026-04-23 | b402 core | Initial draft |

---

## 13. Sign-off

| Role | Name | Date | Status |
|---|---|---|---|
| Solana/Anchor review | | | |
| Protocol lead | | | |
| Final approval | | | |
