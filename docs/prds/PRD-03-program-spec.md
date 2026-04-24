# PRD-03 — Anchor Program Specification

| Field | Value |
|---|---|
| **Status** | Draft — awaiting review |
| **Owner** | b402 core |
| **Date** | 2026-04-23 |
| **Version** | 0.1 |
| **Depends on** | PRD-01, PRD-01-A, PRD-02 |
| **Gates** | PRD-04 (composability), code implementation |

This PRD binds the crypto spec (PRD-02) to Solana account layouts, PDAs, instruction handlers, and CPI contracts. It is the reference a Solana/Anchor auditor will use to review the program line by line.

Every field, seed, error, and CPI contract is specified before any code is written.

---

## 0. Scope

Three programs:

1. **`b402_verifier`** — Groth16 verifier. One program per circuit VK. Wraps `Lightprotocol/groth16-solana`. Immutable.
2. **`b402_pool`** — the shielded pool. Holds custody, tree state, nullifier set, dispatches instructions, CPIs into verifier and adapters.
3. **`b402_adapters`** — one program per DeFi integration (Jupiter, Kamino, Drift, Orca). Specced in PRD-04; this PRD defines the adapter ABI contract the pool relies on.

Additionally: a fourth program `b402_admin` for the multisig-governance layer is **not** a separate program in v1. Admin instructions live on `b402_pool` and are gated by a stored multisig pubkey. This keeps the v1 surface small.

---

## 1. Program IDs and deployment

- **Devnet IDs (Track B prototype):** ephemeral; pinned in `Anchor.toml` per deployment.
- **Mainnet IDs:** deterministic via `solana program deploy` with pinned keypairs. Published in the repo under `ops/deploy/mainnet-ids.toml` after deployment.
- **Upgrade authority:**
  - `b402_verifier` — `None` (immutable at deploy).
  - `b402_pool` — 3-of-5 multisig for 12 months post-launch; then `None`. 72-hour timelock via a queued-upgrade account (see §9).
  - `b402_adapters` — same policy as pool, per-adapter.

---

## 2. `b402_verifier` program

### 2.1 Responsibility

Verify a Groth16 proof against a hardcoded verification key.

### 2.2 Build-time inputs

- Verification key JSON (from PRD-02 §7 ceremony output).
- VK is compiled into the program as a `const VK: &[u8]` (prepared via a build script that deserializes the JSON into the syscall-expected layout).

### 2.3 Instructions

Single instruction `verify`:

```rust
pub struct VerifyAccounts { /* no accounts — pure computation */ }

pub struct VerifyArgs {
    pub proof: [u8; 256],           // Groth16 proof bytes
    pub public_inputs: Vec<[u8; 32]>, // N public inputs, each a BN254 Fr as 32B BE
}
```

Returns `Ok(())` if the proof verifies, or a specific error code otherwise.

### 2.4 Compute budget

- `sol_alt_bn128_addition`, `_multiplication`, `_pairing` syscalls total ~180k CU.
- Public-input hashing and endianness conversion: ~5k CU.
- Target: **200k CU per verify**. Measured on devnet during Track B.

### 2.5 Multi-circuit handling

One verifier program **per circuit VK**. Transact and adapt use separate verifiers:

- `b402_verifier_transact` — transact circuit VK
- `b402_verifier_adapt` — adapt circuit VK
- `b402_verifier_disclose` — disclose circuit VK

Benefits: changing one circuit does not touch others; each verifier is independently auditable and independently immutable.

The pool's `transact` instruction CPIs into `b402_verifier_transact`. The pool's `adapt_execute` CPIs into `b402_verifier_adapt`. Hardcoded in the pool (not admin-configurable) for trust minimization.

---

## 3. `b402_pool` program

### 3.1 Responsibility

Owns pool state. Validates, sequences, and applies shielded operations. Holds token custody. Mediates all CPIs to verifier and adapters.

### 3.2 Errors (full taxonomy)

```rust
#[error_code]
pub enum PoolError {
    // setup
    AlreadyInitialized         = 1000,
    NotInitialized             = 1001,
    InvalidAdminSignature      = 1002,
    UnauthorizedAdmin          = 1003,

    // pause
    PoolPaused                 = 1100,
    CannotPauseWithdrawals     = 1101,

    // token
    TokenNotWhitelisted        = 1200,
    TokenAlreadyConfigured     = 1201,
    MintMismatch               = 1202,
    VaultMismatch              = 1203,

    // tree
    InvalidMerkleRoot          = 1300,
    TreeCapacityExceeded       = 1301,
    FrontierMismatch           = 1302,

    // nullifiers
    NullifierAlreadySpent      = 1400,
    NullifierOrderingViolation = 1401,
    NullifierShardMismatch     = 1402,

    // commitments
    CommitmentAlreadyExists    = 1500,
    InvalidCommitment          = 1501,

    // proof
    ProofVerificationFailed    = 1600,
    ProofPublicInputMismatch   = 1601,
    InvalidFeeBinding          = 1602,
    InvalidRootBinding         = 1603,
    InvalidAdapterBinding      = 1604,

    // amounts
    InsufficientVaultBalance   = 1700,
    PublicAmountExclusivity    = 1701,
    ValueOverflow              = 1702,
    SlippageExceeded           = 1703,

    // adapter
    AdapterNotRegistered       = 1800,
    AdapterReturnedLessThanMin = 1801,
    AdapterCallReverted        = 1802,

    // misc
    InvalidInstructionData     = 1900,
    AccountSizeMismatch        = 1901,
    RentNotCovered             = 1902,
}
```

Error numbers are stable across program upgrades. New errors always append; never renumbered.

### 3.3 PDAs

All PDAs use `b"b402/v1"` as a version prefix in seeds to allow future-version PDAs to coexist.

| PDA | Seeds | Purpose | Max size |
|---|---|---|---|
| `PoolConfig` | `[b"b402/v1", b"config"]` | admin pubkey, pause flags, version | 256 B |
| `TokenConfig` | `[b"b402/v1", b"token", mint]` | per-token: decimals, vault pubkey, enabled flag | 128 B |
| `Vault` token account | ATA-style PDA: `[b"b402/v1", b"vault", mint]` | holds pool custody of `mint` | Token account size |
| `TreeState` | `[b"b402/v1", b"tree"]` | root ring, frontier, leaf count | 3,720 B (§PRD-02 5.3) |
| `NullifierShard[p]` | `[b"b402/v1", b"null", p_be_2B]` | bucket `p` ∈ 0..65535 of nullifiers | 10,200 B each, 65,536 total |
| `AdapterRegistry` | `[b"b402/v1", b"adapters"]` | list of registered adapter program IDs | 4,096 B |
| `QueuedUpgrade` | `[b"b402/v1", b"upgrade", slot_be_8B]` | 72-hour delayed upgrade pending | 512 B |
| `TreasuryConfig` | `[b"b402/v1", b"treasury"]` | treasury pubkey (for optional future fee; currently unused) | 64 B |

Account creation policy:
- `PoolConfig`, `TreeState`, `AdapterRegistry`, `TreasuryConfig` created once at init.
- `TokenConfig` and `Vault` created lazily at first `add_token_config`.
- `NullifierShard[p]` created lazily on first nullifier falling in shard `p`. Rent covered by the user's tx; relayers recoup from fee.
- `QueuedUpgrade` created on admin queue, closed on activation or cancellation.

### 3.4 Account struct definitions

#### `PoolConfig`

```rust
#[account]
pub struct PoolConfig {
    pub version: u16,                      // 2
    pub admin_multisig: Pubkey,            // 32
    pub admin_threshold: u8,               // 1 (e.g., 3)
    pub paused_shields: bool,              // 1
    pub paused_transacts: bool,            // 1
    pub paused_adapts: bool,               // 1  (unshield never pauses)
    pub upgrade_authority_revoked: bool,   // 1
    pub deployed_slot: u64,                // 8
    pub verifier_transact: Pubkey,         // 32
    pub verifier_adapt: Pubkey,            // 32
    pub verifier_disclose: Pubkey,         // 32
    pub _reserved: [u8; 96],               // forward-compat padding
}
```

#### `TokenConfig`

```rust
#[account]
pub struct TokenConfig {
    pub mint: Pubkey,                      // 32
    pub decimals: u8,                      // 1
    pub vault: Pubkey,                     // 32 (the Vault token account PDA)
    pub enabled: bool,                     // 1
    pub added_at_slot: u64,                // 8
    pub _reserved: [u8; 32],
}
```

#### `TreeState`

```rust
#[account]
pub struct TreeState {
    pub version: u16,
    pub leaf_count: u64,
    pub ring_head: u8,                     // 0..63
    pub root_ring: [[u8; 32]; 64],         // 2048
    pub frontier: [[u8; 32]; 26],          // 832
    pub zero_cache: [[u8; 32]; 26],        // 832 — computed at init
    pub _reserved: [u8; 64],
}
```

#### `NullifierShard`

```rust
#[account]
pub struct NullifierShard {
    pub prefix: u16,                       // 2
    pub count: u32,                        // 4
    pub nullifiers: Vec<[u8; 32]>,         // grows as needed
}
```

Representation choice: sorted `Vec<[u8; 32]>` inside the account, binary-searched on lookup. Insertion is O(n) per shard but n stays small (expected 2k at saturation). Alternative: a hashmap-style packed buffer with linear probe — considered and rejected for code-review simplicity.

#### `AdapterRegistry`

```rust
#[account]
pub struct AdapterRegistry {
    pub count: u16,
    pub adapters: Vec<AdapterInfo>,
}

pub struct AdapterInfo {
    pub adapter_id: [u8; 32],              // Poseidon hash of program_id
    pub program_id: Pubkey,
    pub allowed_instructions: Vec<[u8; 8]>, // instruction discriminators whitelisted
    pub enabled: bool,
}
```

#### `QueuedUpgrade`

```rust
#[account]
pub struct QueuedUpgrade {
    pub queued_at_slot: u64,
    pub activates_at_slot: u64,            // queued + ~72h in slots
    pub new_program_hash: [u8; 32],        // sha256 of .so bytes
    pub purpose: String,                   // human-readable; bounded 128B
    pub approved_by: Vec<Pubkey>,
    pub _reserved: [u8; 128],
}
```

---

## 4. Instruction set

### 4.1 `init_pool`

One-time. Creates `PoolConfig`, `TreeState`, `AdapterRegistry`, `TreasuryConfig`. Admin-only.

**Accounts:**
- `[signer, mut]` deployer
- `[mut, init]` PoolConfig PDA (rent-exempt)
- `[mut, init]` TreeState PDA
- `[mut, init]` AdapterRegistry PDA
- `[mut, init]` TreasuryConfig PDA
- `[]` verifier_transact program
- `[]` verifier_adapt program
- `[]` verifier_disclose program
- `[]` system_program

**Args:**
```rust
pub struct InitPoolArgs {
    pub admin_multisig: Pubkey,
    pub admin_threshold: u8,
}
```

**Effects:** zeroes all state, writes admin and verifiers, computes `zero_cache`.

### 4.2 `add_token_config`

Admin-only. Whitelists an SPL mint.

**Accounts:**
- `[signer]` admin_multisig signer (with full multisig auth — see §9)
- `[mut]` PoolConfig
- `[mut, init_if_needed]` TokenConfig PDA
- `[mut, init_if_needed]` Vault token account PDA (owner = PoolConfig PDA)
- `[]` mint
- `[]` token_program
- `[]` system_program
- `[]` associated_token_program

**Args:**
```rust
pub struct AddTokenConfigArgs { pub mint: Pubkey; }
```

**Effects:** creates `TokenConfig` and `Vault` if missing; sets `enabled = true`.

### 4.3 `shield`

User deposits tokens and adds a commitment.

**Accounts:**
- `[signer, mut]` relayer (fee payer; can be the user for self-submit)
- `[signer, mut]` depositor (must sign to authorize token transfer)
- `[mut]` depositor_token_account
- `[]` TokenConfig
- `[mut]` Vault
- `[mut]` TreeState
- `[]` PoolConfig
- `[]` verifier_transact
- `[]` token_program
- `[mut, init_if_needed]` NullifierShard (for dummy/zero nullifiers — see below)
- `[]` system_program

**Args:**
```rust
pub struct ShieldArgs {
    pub proof: [u8; 256],
    pub public_inputs: TransactPublicInputs,  // §PRD-02 6.2
    pub encrypted_notes: [EncryptedNote; 2],  // ciphertext + ephPub + viewingTag per output
    pub note_dummy_mask: u8,                  // bit i = 1 if output i is dummy
}

pub struct TransactPublicInputs {
    pub merkle_root: [u8; 32],
    pub nullifier: [[u8; 32]; 2],
    pub commitment_out: [[u8; 32]; 2],
    pub public_amount_in: u64,
    pub public_amount_out: u64,
    pub public_token_mint: Pubkey,
    pub relayer_fee: u64,
    pub relayer_fee_bind: [u8; 32],
    pub root_bind: [u8; 32],                  // 0 if unused
}

pub struct EncryptedNote {
    pub ciphertext: [u8; 89],
    pub ephemeral_pub: [u8; 32],
    pub viewing_tag: [u8; 2],
}
```

**Validation steps (ordered):**
1. `PoolConfig.paused_shields == false` else `PoolPaused`.
2. `TokenConfig.enabled == true` and `mint == public_token_mint` else `TokenNotWhitelisted`.
3. `public_amount_in > 0` and `public_amount_out == 0` else `PublicAmountExclusivity`.
4. `nullifier[0]` and `nullifier[1]` both zero (shield has no inputs — circuit enforces dummy masks, but program also asserts).
5. `merkle_root` is in `TreeState.root_ring[]` else `InvalidMerkleRoot`.
6. CPI to `verifier_transact.verify(proof, public_inputs.flatten())`. On failure, `ProofVerificationFailed`.
7. For each non-zero `commitment_out[j]`: verify not already in tree via bloom-filter heuristic + reject if exact collision with most-recent frontier (full uniqueness enforced by `random` randomness; full on-chain set check is not scalable — design assumes user-side randomness).
8. CPI `token::transfer(depositor_token_account → Vault, public_amount_in)`.
9. Append each non-dummy `commitment_out[j]` to tree (§PRD-02 5.4). Emit `CommitmentAppended(leaf_index, commitment, encrypted_note)` event.
10. Assert relayer fee == 0 for shield (relayer is paid in SOL out-of-band at shield; the in-kind fee path is only for unshield/adapt). If `relayer_fee > 0`, `InvalidFeeBinding`.

**CU budget:** ~250k. Break-down in PRD-07.

### 4.4 `transact`

Spend N notes, create M notes. Internal transfer (no public amount movement).

Same accounts as `shield` minus `depositor_token_account` and `depositor` signer. Plus:
- `[mut]` NullifierShard[p0] for `nullifier[0]`
- `[mut]` NullifierShard[p1] for `nullifier[1]`

**Validation steps:**
1. Pause check.
2. `public_amount_in == 0 && public_amount_out == 0` (internal only).
3. Root ring membership.
4. CPI to `verifier_transact.verify(...)`.
5. For each non-zero `nullifier[i]`:
   - Shard `p = nullifier[i] >> 240` (high 16 bits).
   - Verify account seed matches shard `p`.
   - Binary search; if present, `NullifierAlreadySpent`.
   - Insert in sorted position.
6. Assert `nullifier[0] <= nullifier[1]` (with 0 sorting first).
7. Append commitments to tree.
8. Emit events.

**CU budget:** ~280k.

### 4.5 `unshield`

Spend notes, withdraw to clear recipient.

Accounts:
- `[signer, mut]` relayer
- `[mut]` recipient_token_account
- `[mut]` relayer_fee_token_account (ATA of relayer_fee_recipient, can be 0-address if no fee)
- `[]` TokenConfig
- `[mut]` Vault
- `[mut]` TreeState
- `[]` PoolConfig
- `[]` verifier_transact
- `[]` token_program
- `[mut]` NullifierShard[p0], `[mut]` NullifierShard[p1]
- `[]` system_program

**Args:** same `TransactPublicInputs` as shield. `public_amount_out > 0`, `public_amount_in == 0`. `relayer_fee ≤ public_amount_out`.

**Validation:**
1. Pause check — but `paused_shields` does NOT block unshield. **Unshield can never be paused.**
2. `public_amount_out > 0 && public_amount_in == 0`.
3. `relayer_fee ≤ public_amount_out`.
4. `relayer_fee_bind == Poseidon_2("b402/v1/fee-bind", relayer_fee_recipient_as_Fr, relayer_fee)` — verifies bind.
5. Root ring, proof verify, nullifier checks (as transact).
6. Commitment appends (for non-zero `commitment_out[j]` — change outputs).
7. Token transfers:
   - Vault → recipient_token_account: `public_amount_out - relayer_fee`.
   - Vault → relayer_fee_recipient's ATA: `relayer_fee`.

**CU budget:** ~260k without adapter. With big transact, ~300k.

### 4.6 `adapt_execute`

Unshield into adapter → adapter performs action → reshield output. Covered in full in PRD-04; this section specifies the pool's side of the contract.

**Accounts (pool-side):**
- `[signer, mut]` relayer
- `[mut]` Vault (source; the input token)
- `[mut]` VaultOut (destination; the output token — may be a different mint)
- `[]` AdapterRegistry
- `[]` verifier_adapt
- `[mut]` TreeState
- `[mut]` NullifierShard[p0], `[mut]` NullifierShard[p1]
- `[]` PoolConfig
- `[]` token_program
- (variable, passed through to adapter) `adapter_accounts...`

**Args:** `AdaptPublicInputs` (extends `TransactPublicInputs` with adapter binding — §PRD-02 6.3).

**Execution order (critical, specified in detail in PRD-04):**
1. All validation as transact + verify `adapter_binding`.
2. Verify proof via `verifier_adapt`.
3. Record pre-CPI balances of `Vault` (input) and `VaultOut` (output).
4. Transfer `public_amount_out_in_circuit` of input mint from Vault to adapter's input account.
5. CPI `adapter.execute(payload)` with `adapter_accounts...`.
6. Read post-CPI balance of `VaultOut`.
7. Assert `post - pre ≥ expected_out_value` else `AdapterReturnedLessThanMin`.
8. Nullifier inserts + commitment appends as transact.
9. Emit `AdaptCompleted(adapter_id, in_mint, in_amount, out_mint, out_amount)`.

**Atomicity:** if step 5 reverts or step 7 fails, the entire transaction reverts — including nullifier inserts (step 8) never happens and vault balances are unchanged. User funds cannot be half-stolen.

**CU budget:** 400–700k depending on adapter. Route-length caps in PRD-04.

### 4.7 Admin instructions

- `pause(which)` / `unpause(which)` — sets pause flags; requires full multisig threshold.
- `rotate_admin(new_multisig, new_threshold)` — same.
- `register_adapter(info)` — adds to AdapterRegistry.
- `disable_adapter(id)` / `enable_adapter(id)` — quick kill switch; single-sig for emergency disable, multisig for enable.
- `queue_upgrade(new_hash, purpose)` — starts 72h timelock.
- `activate_upgrade(hash)` — after timelock, any admin signer can activate; program upgrade happens via BPF upgradable loader path.
- `cancel_upgrade(slot)` — admin can abort queued upgrade.
- `revoke_upgrade_authority()` — permanent, irreversible after 12 months post-launch.

All admin instructions validated against `PoolConfig.admin_multisig` + threshold. Multisig verification uses a co-signer pattern — see §9.

---

## 5. CPI contracts

### 5.1 Verifier CPI

```rust
// In b402_pool, calling b402_verifier_*:
verifier_program.verify(
    accounts = [], // verifier has no stateful accounts
    args = VerifyArgs {
        proof,
        public_inputs: packed_public_inputs,
    },
)?;
```

`packed_public_inputs` layout: serialized `[32 * N]` BE bytes. Endianness and ordering specified in PRD-02 §6. Any mismatch → `ProofVerificationFailed`.

### 5.2 Token CPI

Standard SPL token:
- `transfer` from Vault to user or adapter: use `invoke_signed` with Vault's PDA signer seeds.
- `transfer` from user to Vault: user signature required.

### 5.3 Adapter CPI

Full contract in PRD-04. Summary:
- Adapter is a separate program in `b402_adapters`.
- Pool passes token accounts, parameters, and remaining `AccountInfo`s.
- Adapter returns only a status and optionally writes to its own state. Pool never trusts adapter's return — trust is established by vault balance delta (§4.6.6–7).

---

## 6. Event emissions

All events emit `anchor_lang::emit!(...)`. Off-chain indexers reconstruct tree and scan for notes using these.

```rust
#[event]
pub struct CommitmentAppended {
    pub leaf_index: u64,
    pub commitment: [u8; 32],
    pub encrypted_note: EncryptedNote,
    pub tree_root_after: [u8; 32],
    pub slot: u64,
}

#[event]
pub struct NullifierSpent {
    pub nullifier: [u8; 32],
    pub shard: u16,
    pub slot: u64,
}

#[event]
pub struct AdaptCompleted {
    pub adapter_id: [u8; 32],
    pub in_mint: Pubkey,
    pub in_amount: u64,
    pub out_mint: Pubkey,
    pub out_amount: u64,
    pub slot: u64,
}

#[event]
pub struct TokenWhitelisted {
    pub mint: Pubkey,
    pub decimals: u8,
    pub slot: u64,
}

#[event]
pub struct AdapterRegistered {
    pub adapter_id: [u8; 32],
    pub program_id: Pubkey,
    pub slot: u64,
}
```

No events leak private data. `encrypted_note` is encrypted; indexers see ciphertext only.

---

## 7. Rent and account-size policy

- All PDAs rent-exempt at creation. Rent covered by:
  - `init_pool` — deployer pays.
  - `add_token_config` — admin pays.
  - `NullifierShard` creation — user's tx pays (via relayer sponsor with recoupment). Shard may need periodic reallocation as it grows; Anchor's `realloc` used with `zero_init`.
  - `AdapterRegistry` reallocation — admin-only.
- Max shard size: 10,200 B at saturation (2,045 nullifiers × 32 B + overhead). Below the 10,240 account limit.
- Tree state does not grow.

---

## 8. Compute budget reservation

Every instruction declares its CU request via `SetComputeUnitLimit` at SDK layer, not program-side. Program assumes sufficient CU was requested; if not, Solana reverts mid-instruction.

SDK helpers in `@b402ai/solana` set the following defaults:

| Instruction | Requested CU |
|---|---|
| init_pool | 300k |
| add_token_config | 100k |
| shield | 350k |
| transact | 400k |
| unshield | 400k |
| adapt_execute (Jupiter 2-hop) | 900k |
| adapt_execute (Kamino) | 700k |
| adapt_execute (Drift) | 1,100k |
| admin ops | 200k |

Measured and tuned in PRD-07.

---

## 9. Admin multisig flow

Not a separate program. Implemented as a co-signer pattern:

- `PoolConfig.admin_multisig` is a pubkey = Poseidon-like hash committing to a sorted list of signer pubkeys. (Rejected: a full list on-chain; keeps `PoolConfig` tight.)
- Admin instructions take `AdminAuth` arg:

```rust
pub struct AdminAuth {
    pub signers: Vec<Pubkey>,           // all N signers (sorted)
    pub signer_indices: Vec<u8>,        // which indices actually signed this tx
    pub proof: [u8; 32],                // Merkle or Poseidon proof to reconstruct admin_multisig
}
```

- Program verifies that `hash(signers) == admin_multisig`, that each `signers[i]` for `i in signer_indices` appears as a signer on the tx, and that `len(signer_indices) >= admin_threshold`.

**Why not use `squads-protocol`:** introduces a large external program dependency; audit cost not justified for what is essentially "verify k-of-n signed." Roll our own, 100 LoC, auditable.

**Upgrade timelock:** `queue_upgrade` stores `activates_at_slot = current_slot + 72h_in_slots`. `activate_upgrade` requires `current_slot >= activates_at_slot`.

---

## 10. Security invariants (program-level)

Auditors verify these hold across all code paths:

1. **No nullifier insertion without a successful proof verify.** Every path writing to `NullifierShard` must have passed a CPI to `verifier_transact` or `verifier_adapt` earlier in the same instruction.
2. **No vault transfer without balance conservation.** Transfers from Vault require a verified proof whose `public_amount_out` (plus `relayer_fee`) matches.
3. **No commitment append without well-formedness.** `commitment_out[j]` is a public input to a verified proof; the circuit ensures well-formedness.
4. **No pause applies to unshield.** `unshield` is always permitted as long as valid proof presented. Checked in `unshield` handler; regression test in PRD-07.
5. **No adapter CPI without balance-delta check.** `adapt_execute` records pre-balance, CPIs, re-reads post-balance, asserts ≥ expected. No assumption on adapter behavior.
6. **Nullifier ordering.** Program enforces `nullifier[0] ≤ nullifier[1]` with sentinel 0.
7. **Root ring freshness.** Every proof verifies against a root in the ring; old roots are rejected.
8. **No admin instruction reduces user authority.** Admin cannot forge spends, modify user notes, or pause unshields.
9. **Upgrade timelock is unskippable.** No admin instruction sets `activates_at_slot` below `queued_at_slot + 72h`. Unit test required.
10. **Immutability ≠ reversibility.** Once upgrade authority is revoked, it cannot be re-granted. Unit test required.

---

## 11. Devnet vs. mainnet differences

None in the program. The program itself does not care which cluster; all cluster-specific config (RPC URLs, ceremony hashes, mint addresses) live in the SDK.

Track B (devnet) and Track A (mainnet) deploy the same `.so` once Track A is audit-signed. Track B's Track-B-only shortcuts (throwaway trusted setup, limited token whitelist) are SDK and deploy-script configuration, not program code.

---

## 12. Open questions

1. **Nullifier shard binary-search cost.** At saturation (~2k entries), binary search is ~11 comparisons + 11 account reads inside the vec. Cheap. Confirm in benchmarks.
2. **Atomic composition with multiple adapter calls.** v1 `adapt_execute` assumes single-CPI. Do we want two-CPI (unshield → swap on Jupiter → deposit on Kamino → reshield) in one tx? Tentative: no in v1; users compose at the client.
3. **Admin squads-protocol escape hatch.** If we later want to adopt squads for richer multisig UX, `admin_multisig` is just a pubkey. Swap via `rotate_admin`.
4. **Nullifier memory layout.** Sorted Vec vs fixed-array + tombstones. Sorted Vec is simpler and size is bounded. Revisit only if benchmarks complain.
5. **Rent-exempt reallocation.** Nullifier shards reallocate; current Anchor allows this. Verify across Anchor 0.30 + 0.31.
6. **Account budget for adapter CPI.** Solana tx size limit (~1,232 B) caps accounts per tx. Jupiter routes requiring many accounts may hit the cap. Mitigation: user splits across two txs, or we use account-lookup tables (ALTs). Decide in PRD-04.

---

## 13. Revision history

| Version | Date | Author | Changes |
|---|---|---|---|
| 0.1 | 2026-04-23 | b402 core | Initial draft |

---

## 14. Sign-off

| Role | Name | Date | Status |
|---|---|---|---|
| Solana/Anchor review | | | |
| Protocol lead | | | |
| Security review | | | |
| Final approval | | | |

Once signed off, PRD-04 (composability layer, per-adapter specs) proceeds in parallel with initial `b402_pool` implementation.
