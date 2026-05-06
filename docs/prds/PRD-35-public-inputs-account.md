# PRD-35 — Move Groth16 public inputs from ix data to account data

Status: drafted 2026-05-03. Author: mayur. Owner: protocol.
Blocks: PRD-33 §11 q0 (per-user kamino mainnet flip), every future
adapter that touches a stateful protocol (Drift, Marginfi, Adrena,
Sanctum LST, Orca whirlpool, pump.fun if/when integrated).

## 1. The architectural ceiling we're hitting

Solana v0 transaction max serialized size: **1232 bytes** (hard cap from
the QUIC packet limit, not changeable). Today's Phase 9 verifier ix
carries the public inputs inline:

```
verifier-adapt::verify ix:
  [discriminator           8 B]
  [proof_a                64 B]
  [proof_b               128 B]
  [proof_c                64 B]                          <- 256 B Groth16 proof
  [public_inputs[24]    768 B]   <- 24 inputs × 32 B    <- THE BLOAT
                       ─────
                      1024 B    just for the verifier ix data
```

Add to that the pool's `adapt_execute` ix carrying account metas, the
forced-static keys (per-user PDAs that can't be ALT-resident because
they vary per user), the compute-budget ix, blockhash + sigs:

| component (per-user kamino deposit) | bytes |
|--|--|
| Phase 9 verifier ix | ~1024 |
| 5 per-user PDAs forced static | ~160 |
| ATAs + programs + signers | ~200 |
| Compute budget + sigs + overhead | ~150 |
| **Total** | **~1530** |
| **v0 cap** | **1232** |
| **Over by** | **~300 B** |

This is the kamino number. Drift's per-user `User` + `UserStats`,
Marginfi's `MarginfiAccount`, Adrena's `UserStaking`+`Position` all
follow the same shape (per-user state account → forced static slot).
**Every per-user adapter we ever ship hits this same ceiling** — Kamino
is just the canary. PRD-33 ships V1 against this, but every future
adapter is locked out until we lift it.

## 2. The fix

Stop carrying the 768 B of public inputs inside the verifier ix data.
Instead, write them to a small persistent (or transient) account, and
have the verifier ix reference that account by pubkey. The verifier
reads the inputs from the account at execution time.

```
                              before                              after

verifier ix data:    264 B (8 disc + 256 proof)         264 B
                  + 768 B (inputs)                    +   0 B
                  ──────                              ──────
                  1032 B                                264 B   <- saves 768 B per call
```

The 768 B move OUT of the message. The account that holds them is
referenced by pubkey (32 B static OR 1 B ALT-resident). Net saving:
~700-735 B per verify call — roughly **2× headroom** under the cap. Every
adapter benefits, no ceremony required, same VK.

## 3. How public inputs reach the account

Two practical patterns. Both preserve atomicity.

### 3.1 Pattern A — Per-user inputs PDA, write-then-verify in same tx

A pool-side PDA scoped by the user's `spendingPub`:

```
pending_inputs_pda = PDA(
  &[b"b402/v1", b"pending-inputs", spending_pub_le_bytes],
  pool_program_id,
)
```

The user's tx contains two ixs:
1. `pool::write_inputs(public_inputs[24])` — writes 768 B into
   `pending_inputs_pda.data`. Costs ~16k CU.
2. `pool::adapt_execute(proof[256], inputs_account_ref)` — reads inputs
   from PDA, runs verification, executes adapter, zeroes the PDA's
   inputs region.

Total tx data: 776 B (write_inputs ix data) + 264 B (verify ix data) +
account refs + adapter call = roughly **same as today inside one tx**.

**This pattern doesn't help on its own** — we shifted bytes between ixs
within the same tx without reducing the message total.

### 3.2 Pattern B — Two-tx commit-then-verify (the actual win)

Tx 1: `pool::commit_inputs(public_inputs[24])` writes to the per-user
PDA. ~880 B. Lands easily.

Tx 2: `pool::adapt_execute(proof[256], adapter_args)` references the
already-written PDA. ~500-1000 B depending on adapter. **Fits comfortably**
under the cap because the 768 B of inputs are already on chain.

Atomicity: the PDA acts as a one-shot "permission token." Tx 1 writes;
tx 2 reads and zeroes (idempotent — re-execution against zeroed PDA
fails). If tx 2 never lands the PDA holds stale inputs (refundable rent,
~0.005 SOL per user) until the next tx 1 overwrites.

**Failure mode coverage:**
- Tx 1 fails: state untouched, retry from scratch. Atomic.
- Tx 1 succeeds, tx 2 fails: PDA holds stale data. Next attempt overwrites tx 1's data. Refund-on-gc reclaims rent. No funds at risk because no shielded state changed.
- Tx 1 + tx 2 succeed: PDA zeroed, normal exit.

UX: relayer bundles both txs sequentially. From the user's perspective
this is one logical operation (one signature, one tx hash for tx 2).

### 3.3 Why pattern B is the recommended ship

Pattern A doesn't reduce per-tx bytes. Pattern B does. Atomicity is
preserved by design (state-token model). Implementation cost is
moderate.

## 4. Per-protocol generalization

This isn't kamino-specific. Every adapter that touches a stateful
protocol gets the same headroom benefit:

| adapter | ix-data bytes saved per call | unblocks |
|--|--|--|
| Kamino | 768 (Phase 9 dual-note inputs) | per-user lend (PRD-33), borrow/repay (V1.5) |
| Drift | 768 | per-user perp open/close, sub-account model |
| Marginfi | 768 | per-user account, lend/borrow |
| Adrena | 768 | per-user position, perps |
| Jupiter | 768 | nothing today (stateless), but unlocks larger swap account lists |
| Sanctum LST | 768 | nothing today (stateless), keeps headroom for LST routing |
| Orca whirlpool | 768 | per-position NFT model, multi-tick LP |

Composable example post-PRD-35:

```
single tx: shield USDC → Jupiter swap to wSOL → Drift perp open
                                              → Marginfi collateral deposit
```

All four protocols in one tx, each per-user, with byte budget to spare.
Currently impossible at any one step (tx already over cap).

## 5. Implementation plan

### Phase 35.1 — pool::commit_inputs ix + pending_inputs PDA (~4h)

`programs/b402-pool/src/instructions/commit_inputs.rs`:

```rust
#[derive(Accounts)]
pub struct CommitInputs<'info> {
    #[account(
        init_if_needed,
        payer = relayer,
        space = 8 + 768 + 1,                              // disc + inputs + version
        seeds = [b"b402/v1", b"pending-inputs",
                 spending_pub_le.as_ref()],
        bump,
    )]
    pub pending_inputs: Account<'info, PendingInputs>,
    #[account(mut)]
    pub relayer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn commit_inputs(
    ctx: Context<CommitInputs>,
    spending_pub_le: [u8; 32],          // matches proof's outSpendingPub bytes
    public_inputs: [[u8; 32]; 24],
) -> Result<()> {
    let acct = &mut ctx.accounts.pending_inputs;
    acct.version = 1;
    acct.inputs = public_inputs;        // 768 B copy
    Ok(())
}
```

### Phase 35.2 — verifier-adapt::verify_with_account_inputs (~3h)

New ix variant alongside existing inline-inputs `verify`. Reads the
24 × 32 B inputs from the passed `pending_inputs_pda` account data
instead of from ix data. Same proof verification logic.

```rust
pub fn verify_with_account_inputs(
    ctx: Context<VerifyWithAccountInputs>,
    proof: [u8; 256],
) -> Result<()> {
    let acct = &ctx.accounts.pending_inputs;
    require!(acct.version == 1, AdaptError::PendingInputsBadVersion);
    let inputs: &[[u8; 32]; 24] = &acct.inputs;
    groth16_verify(&proof, inputs, &VK)?;
    Ok(())
}
```

**Critical:** the existing inline-inputs `verify` ix stays for
backward-compat with the current pool. Pool gets an upgrade to call
the new `verify_with_account_inputs` instead.

### Phase 35.3 — pool::adapt_execute reads from PDA + zeroes after (~3h)

```rust
pub fn adapt_execute<'info>(
    ctx: Context<AdaptExecute<'info>>,
    args: AdaptExecuteArgs,             // proof only, no public inputs
) -> Result<()> {
    // Existing logic except:
    //   1. Reference pending_inputs_pda in account list
    //   2. Pass it through to verify_with_account_inputs CPI
    //   3. After successful verify+execute: zero the PDA's inputs
    //      so it can't be replayed.
}
```

PRD-33 §6.1 wire-shape stays — the action_payload prepend logic is
orthogonal.

### Phase 35.4 — SDK 2-tx orchestrator (~4h)

`packages/sdk/src/b402.ts`:

```ts
async privateSwap(req: PrivateSwapRequest): Promise<PrivateSwapResult> {
  // ... build proof, public_inputs, etc.

  // Tx 1: commit inputs.
  const commitTx = await this._buildCommitInputsTx(spendingPubLe, publicInputs);
  await this._submitTx(commitTx);   // relayer pays gas

  // Tx 2: adapt_execute.
  const executeTx = await this._buildAdaptExecuteTx(proof, adapter, ...);
  const sig = await this._submitTx(executeTx);

  // ... existing post-process.
  return { signature: sig, ... };
}
```

The two txs land sequentially. UX-wise this is identical to today
(relayer-driven, no extra user signing) — just two tx hashes instead
of one.

### Phase 35.5 — gc_pending_inputs admin ix (~2h)

For PDAs left stale by failed tx 2. Admin-callable, closes any
`pending_inputs_pda` whose `last_used_slot < current_slot - 1000`
(roughly 7 minutes). Refunds rent to admin treasury.

### Phase 35.6 — fork test (~3h)

`tests/v2/e2e/v2_fork_pending_inputs.test.ts`:
- Multi-user privateSwap flow against the new 2-tx pattern
- Failure-mode test: deliberately fail tx 2, verify retry works, verify gc reclaims rent
- Composability test: shield → Jupiter swap → Drift open in one logical operation, three txs total

### Phase 35.7 — pre-deploy gate per PRD-34 (~2h)

Run reproducible-build, mainnet-fork e2e, upgrade-dry-run, IDL diff,
CU+size budget check before any mainnet upgrade.

### Phase 35.8 — mainnet redeploy (verifier-adapt + pool, atomic) (~1h)

Verifier-adapt first (with both old + new ix variants), then pool.
Pool's old code path uses old verifier ix; new path uses new. No
service interruption. Old in-tx privateSwaps on mainnet keep working
during the transition.

**Total: ~22h focused work. Ship V1 → V2 in 3 days max.**

## 6. Limitations + concerns + mitigations

| concern | severity | mitigation |
|--|--|--|
| 2-tx atomicity loss | medium | State-token PDA (§3.2). Failure modes documented. Worst case: a few wasted lamports per failed tx-2; no funds at risk. |
| Per-user PDA proliferation | low | Each user has 1 pending_inputs_pda + their per-adapter owner_pda. Manageable. gc_pending_inputs reclaims rent for stale ones. |
| Replay attack on inputs PDA | medium | Pool zeroes the inputs region after successful execute. Re-execution sees `version == 0` and rejects. Documented in §5.3. |
| Tx 1 → tx 2 ordering on relayer | low | Relayer submits sequentially with same blockhash, fails-fast on tx 1 errors. SDK retries the pair on relayer-side error. |
| MEV: someone observes tx 1 (with public inputs) and racing-frontruns tx 2 | medium | Public inputs alone don't carry value. The shielded note state isn't readable from inputs. Worst case: an observer learns "user X is about to swap" — same info leak as today's privateSwap once it lands. No new attack surface. |
| Verifier ix backward compat | low | Add `verify_with_account_inputs` as a NEW ix variant. Old `verify` stays. Pool upgrades to call new. No flag day. |
| Account size cost | low | 800 B PDA × $0.005/B rent ≈ $4 per user, refundable via gc. |
| Composability: 2 protocols in one tx still needs careful sizing | medium | Post-PRD-35 each adapter call is ~500 B without inputs. Two-protocol composition (~1000 B) fits comfortably. Three-protocol composition (~1500 B) probably doesn't — but two is the realistic V1 multi-protocol target. |

## 7. Why users (and devs) will take this seriously

**The story we couldn't tell before PRD-35:**

- "private DeFi on Solana" was structurally limited to 1 protocol per tx
- Every per-user adapter we shipped would hit the same ceiling Kamino just hit
- Composable multi-protocol private flows (shield → swap → lend → perps in one logical op) impossible

**The story we can tell after PRD-35:**

- "the only privacy pool on Solana that composes across DeFi" — Kamino + Drift + Marginfi + Adrena + Jupiter + Orca + Sanctum, per-user state per protocol, atomic from the user's perspective
- ~2× tx headroom for every operation. Future adapters land without ceiling concerns.
- Per-user state at every protocol (set anonymity 1-of-N b402 users, not 1-of-1)
- A real demoable narrative: "shield → Jupiter swap → Drift perp open" in one screencast

**Engineering credibility props:**

- Permanent fix at the right layer (the proof-publishing pattern), not a Kamino-specific patch
- No re-ceremony, no circuit changes, no proof-format migration — same verification key
- Backward compat preserved (old ix stays alongside new)
- 22h focused engineering, ~3 days end-to-end including hardening + deploy

**Distribution-side props:**

- Demoable composability is the mainnet narrative for HN / CT / Solana ecosystem posts
- Each new adapter is now small (no fight against tx size) — Drift, Marginfi can ship in days each
- Real users can compose flows without "this protocol works but that one doesn't"

## 8. Sequencing against open work

PRD-33 V1 (per-user Kamino, no rent fee, no withdraw) → BLOCKED by §11 q0 → PRD-35 → unblocks everything:
- PRD-33 V1 mainnet flip (deposit only)
- PRD-33 V1.5 (rent fee + withdraw + borrow + repay — fits trivially with PRD-35 headroom)
- Drift adapter (new, follows post-PRD-35 pattern)
- Marginfi adapter (new)
- Multi-protocol composition demos

PRD-34 (pre-deploy harness) is independent and ships in parallel.

## 9. Decision

**Ship PRD-35 BEFORE PRD-33 V1 mainnet flip.** Reason: deploying PRD-33
V1 to mainnet without PRD-35 means deploying a binary that can't actually
process a privateLend call (the SDK-side tx will throw before submission
on every attempt). Honest path is: PRD-35 first, then PRD-33 V1 deposit
works end-to-end and mainnet flip is real.
