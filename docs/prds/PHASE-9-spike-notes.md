# Phase 9 — spike notes (BLOCKER)

| Field | Value |
|---|---|
| Date | 2026-04-30 (overnight session) |
| Branch | `feat/phase-9-dual-note` (off `feat/phase-7-inline-cpi` HEAD `7e21ff0`) |
| Status | **BLOCKED — spec is incompatible with v2.1 circuit. No production code committed.** |
| PRD under review | `docs/prds/PHASE-9-dual-note-minting.md` |

## TL;DR

The PRD §3.2 design — *pool computes `commitment_b` in Rust from runtime values* — cannot be implemented against the deployed v2.1 adapt circuit. The pool program does not have access to the user's `spending_pub`, which is the primary witness binding a Poseidon commitment to its owner. Three secondary problems compound (PRD says BigEndian Poseidon vs the deployed LittleEndian, PRD says `random_a` is "proof-bound" but `outRandom` is a private witness, PRD says `spending_pub_x/y` come from `recipient_bind` reconstruction but in adapt the recipient_bind is hashed over zeros).

Per the agent task instructions ("If the spike reveals the design is wrong... STOP, write findings, do NOT implement against a broken spec"), I stopped at the end of the spike, committed only this notes file, and left the rest of the implementation (steps 2–10 in the PRD §8 plan) for the user to direct.

Three fixable design alternatives are sketched in §6 below. All require either a circuit change (with new trusted setup) or a deeper SDK refactor than the PRD anticipated. The user picks the path; I will not improvise.

## §1. Spike checklist (PRD §6)

### Q1. Which OUT slot's random do we use as `random_a`? Is it accessible to the pool?

**Finding: `random_a` (in any slot) is a private witness. The pool cannot see it.**

- v2.1 adapt circuit (`circuits/adapt.circom:99-102`) declares:
  ```
  signal input outValue[2];
  signal input outRandom[2];
  signal input outSpendingPub[2];
  signal input outIsDummy[2];
  ```
  These are declared *above* the `component main { public [...] }` at line 281–304. The public list contains `commitmentOut[0..2]` only — the random and spending_pub are private to the prover.

- SDK side (`packages/sdk/src/b402.ts:746-752`): `outRandom` is generated locally with `nodeRandomBytes(32)` reduced mod p, hashed into `outCommitment = commitmentHash(outMintFr, expectedOut, outRandom, spendingPub)`, and never written to the wire. It survives only in the SpendableNote stored locally for the user (line 1032-1043).

- Pool side: at proof-verify time the pool only sees `pi.commitment_out[0]` (and `[1]`, which is forced to zero in the swap case). The 32-byte commitment hash is binding, but irreversibly so — extracting `random_a` would require breaking Poseidon.

**Implication for §3.2 of the PRD**: the line
```rust
let random_b = poseidon::hashv(..., &[&random_a, &TAG_EXCESS], ...);
```
cannot be expressed because `random_a: [u8; 32]` is not in scope on the pool side.

The closest substitute that *is* in scope is `pi.commitment_out[0]` itself — it's proof-bound, public, opaque to observers, and non-malleable. Substituting it for `random_a` (i.e. `random_b = Poseidon(commitment_a, TAG_EXCESS)`) would let the SDK independently recompute the same `random_b` because the SDK also knows `commitment_a` (it's the same `outCommitment` it constructed at line 747). **But this only solves spike Q1 — Q2 remains a hard blocker.**

### Q2. Where do `spending_pub_x`, `spending_pub_y` come from in the pool's view of public inputs?

**Finding: they are not in the pool's view, full stop.**

- The pool's adapt public-input vector is built by `programs/b402-pool/src/instructions/adapt_execute.rs:584-623`, `build_public_inputs_for_adapt`. Of its 23 entries, *none* is the user's spending_pub. The mints, the value, the action_hash, the merkle_root, the relayer_fee_bind, the recipient_bind, and 6 domain tags — but nothing carrying the user identity that the OUT commitment is bound to.

- PRD §3.2 hand-waves this with "from proof public input (recipient_bind reconstruction)". I traced this:

  - `recipient_bind = Poseidon_3(recipientBindTag, recipientOwnerLow, recipientOwnerHigh)` per `circuits/adapt.circom:251-257`.

  - In `privateSwap` (`packages/sdk/src/b402.ts:807-809`), `recipientOwnerLow` and `recipientOwnerHigh` are hardcoded to `0n, 0n`. There is no recipient — the swap output goes back into the pool, not to a public address.

  - So `recipient_bind = Poseidon_3(recipientBindTag, 0, 0)` for every adapt_execute. It carries zero information about the user. Reconstruction yields nothing.

- For unshield, recipient_bind does carry the recipient's pubkey (split into 128-bit low/high). But that's the *withdrawal address*, not the *spending pub* the OUT commitment is bound to. They are different keys.

**Implication for §3.2 of the PRD**: the line
```rust
let commitment_b = poseidon::hashv(..., &[&u64_to_fr_le(excess), &random_b, &spending_pub_x, &spending_pub_y], ...);
```
cannot run because no `spending_pub_x` / `spending_pub_y` exists in the handler's scope.

The deployed `Commitment` template (`circuits/lib/commitment.circom`) takes a single `spendingPub` Fr element, not an x/y split (the PRD's notation is inaccurate on top of being unsourced — Poseidon over BN254 doesn't decompose a coord-pair). So to stay parity-compatible with what the SDK and circuit produce on every other call, the pool would need a single `spending_pub: [u8; 32]` available, which it doesn't have.

### Q3. Does `tree_state` support 3 leaves per tx? Refactor scope?

**Finding: tree state is not the constraint. `tree_append` is per-leaf and can be called any number of times.**

- `programs/b402-pool/src/util.rs:22` — `tree_append(tree, leaf)` is a one-shot helper that increments `leaf_count`, walks the frontier, updates the root ring, returns the new root. It has no batching assumption.

- In the existing handler (`adapt_execute.rs:534-562`), the loop calls `tree_append` once per non-dummy `commitment_out[i]`. Adding a third call (or a fourth) is mechanically trivial.

- `state.rs::TreeState` carries `leaf_count: u64`, `frontier: [[u8;32]; TREE_DEPTH]`, `root_ring: [[u8;32]; ROOT_HISTORY_SIZE]`. None of these are 2-bounded. The 26-deep tree caps leaves at 2^26 ≈ 67M; a third leaf per tx is irrelevant.

So this spike item is **not a blocker**. The PRD's worry "may need refactor if hardcoded 2-per-tx" is unfounded.

### Q4. `u64_to_fr_le` exists in pool's util module?

**Finding: it exists but as a duplicated *private* helper across four instruction files.**

- Definitions: `instructions/adapt_execute.rs:578`, `instructions/shield.rs:229`, `instructions/unshield.rs:383`, `instructions/transact.rs:270`. Identical bodies.

- `programs/b402-pool/src/util.rs` does not currently expose it. If Phase 9 lands as drafted it would justify lifting one of those into util as `pub fn u64_to_fr_le`. Cheap, harmless refactor — but cosmetic.

Not a blocker.

### Q5. Test: Poseidon parity with TS SDK — does the existing convention support a new tag?

**Finding: yes, but the PRD got the convention wrong.**

- The deployed convention is *not* `TAG_EXCESS = poseidon_bytes("b402/v1/excess")` (PRD §3.1).
- It is `TAG_EXCESS = (BE-int interpretation of "b402/v1/excess") mod p`, encoded as a 32-byte little-endian Fr representation. See:
  - Rust const: `programs/b402-pool/src/constants.rs:34-67` — `tag_fr_le(b"b402/v1/...")` is a const fn that does BE→mod p→reverse-to-LE entirely at compile time. No Poseidon call.
  - TS runtime: `packages/shared/src/encoding.ts:35-44` — `tagToFr(name)` is a single big-endian shift loop, then `% FR_MODULUS`. Again, no Poseidon.
  - Crypto crate parity: `packages/crypto/src/domain.rs:46-49` and `packages/crypto/src/fr.rs::Fr::from_tag` — same algorithm in Rust.

- All 9 existing tags (commit, null, mk-node, mk-zero, spend-key-pub, fee-bind, root-bind, adapt-bind, recipient-bind) follow this convention bit-for-bit. Adding "excess" as a tenth tag is straightforward: one line in the Rust const file, one line in `DomainTags` in `packages/shared/src/constants.ts`, one update to the test that asserts all tags distinct, one update to the test that asserts the encoding round-trip.

- Endianness of the *Poseidon hash itself* is also wrong in the PRD §3.2 pseudocode. The deployed pool uses `Endianness::LittleEndian` everywhere (`util.rs:13`, `adapt_execute.rs:274`, `shield.rs`, etc.). The PRD wrote `Endianness::BigEndian` — that would produce a different output and silently break parity.

So the *tag* part of Q5 is solvable; the *parity test* is impossible to write today because steps 3.2/3.3 of the PRD don't have a buildable Rust-side implementation to compare against.

## §2. Why this halts implementation

The PRD's `random_a` and `spending_pub_*` references rely on those values being inside the pool program's view of the proof's public inputs. They are not. They are private witnesses. The PRD's §3.2 Rust pseudocode is therefore not buildable as-is; nothing the agent could write would compile and match the SDK's commitment for any reasonable input. The next step (§7 TDD plan) opens with a "vector parity test" between Rust and TS — the test would have to be aborted before it can be written, because there is no defined Rust-side `commitment_b` builder to test.

I considered three workarounds and rejected each as an "improvisation against a broken spec":

1. **Substitute `commitment_out[0]` for `random_a`** (deterministic, both sides see it). Solves Q1, but Q2 still blocks: the pool still has no `spending_pub` to put inside `Poseidon(TAG_COMMIT, mint, excess, randomB, spendingPub)`.

2. **Substitute `recipient_bind` for `spending_pub_x/y`**. The PRD suggests this. It produces a 32-byte value the pool *does* see, but it's `Poseidon(recipientBindTag, 0, 0)` — a constant for every adapt_execute call. Using it as the "owner" leg of an output commitment would mean every excess note in history is owned by the same global identity. Anyone observing it on-chain can spend it. Total break of the privacy + ownership invariants.

3. **Skip the `spending_pub` leg entirely** (commitment_b = Poseidon(TAG_COMMIT, outMint, excess, randomB)). This leaves the excess note unowned — same break as (2), reframed.

No version of the spec as drafted preserves §4's security invariant *"Excess note is recoverable by user only"*. This is the core protocol guarantee; a workaround that breaks it is not a workaround.

## §3. Codebase findings (file:line citations)

Per the task: "Cite line numbers in the codebase for each finding."

| Claim | Citation |
|---|---|
| `outRandom` is a private witness (not a public input) | `circuits/adapt.circom:100`, declared above the `public [...]` list at `circuits/adapt.circom:281-304` |
| `outSpendingPub` is a private witness | `circuits/adapt.circom:101`, public list at `circuits/adapt.circom:281-304` |
| Pool's adapt public-input vector contains 23 entries, none of which is `spending_pub` | `programs/b402-pool/src/instructions/adapt_execute.rs:584-623` (`build_public_inputs_for_adapt`) |
| `recipient_bind` for adapt is `Poseidon_3(tag, 0, 0)` | SDK side: `packages/sdk/src/b402.ts:807-809` (recipientOwnerLow/High = 0); circuit side: `circuits/adapt.circom:251-257` (Poseidon_3 over those signals) |
| Existing tags are BE-int-mod-p, not Poseidon hashes | `programs/b402-pool/src/constants.rs:34-67`, `packages/shared/src/encoding.ts:35-44`, `packages/crypto/src/domain.rs:46-49` |
| Existing pool Poseidon calls use `Endianness::LittleEndian` | `programs/b402-pool/src/util.rs:13`, `programs/b402-pool/src/instructions/adapt_execute.rs:274` |
| `tree_append` supports calling N times per ix; no 2-per-tx hardcode | `programs/b402-pool/src/util.rs:22`, used in a for-loop in `adapt_execute.rs:537-561` |
| `u64_to_fr_le` is duplicated across 4 instruction files | `instructions/adapt_execute.rs:578`, `shield.rs:229`, `unshield.rs:383`, `transact.rs:270` |
| `outRandom` flows from SDK-side `nodeRandomBytes` to local SpendableNote only | `packages/sdk/src/b402.ts:746-752` (mint), `packages/sdk/src/b402.ts:1032-1043` (store) |
| Commitment template takes a single `spendingPub` Fr (not x/y) | `circuits/lib/commitment.circom` (single field input named `spendingPub`) |

## §4. What the PRD got right

- **§1 Problem statement.** Vault-dust leak is real and bites at scale. Verified by reading `adapt_execute.rs:525-532`: the `delta >= pi.expected_out_value` check passes any positive delta, but the OUT commitment is bound to `expected_out_value` (`pi.commitment_out[0]` and the circuit constraint `outSum === expectedOutValue` at `adapt.circom:241`). Excess sits in the vault.
- **§2 Goal.** "User's two notes sum to actual_out" is the right user-facing acceptance criterion.
- **§4 Security framing.** The invariants are the right ones to enforce; only the §3.2 implementation sketch fails to satisfy invariant *"Excess note is recoverable by user only"* without a circuit change.
- **§5 Privacy impact.** Correct: dual-leaf events leak "non-zero slippage" but no value info, anonymity set unchanged.
- **§3.4 Tx size.** Correct that the wire shape doesn't grow per ix, only events.
- **§3.5 Compute units.** Estimate ~17K extra CU is roughly right for one extra Poseidon + one extra `tree_append` + one event emit. Headroom from 558K → ~575K confirms.

## §5. What the PRD got wrong

| Issue | Where | Correct value |
|---|---|---|
| Tag derivation | §3.1 ("`poseidon_bytes("b402/v1/excess")`") | Should be `tag_fr_le(b"b402/v1/excess")` — same const-fn shape as the other 9 tags. No Poseidon call. |
| Poseidon endianness | §3.2 (`Endianness::BigEndian`) | Existing convention is `Endianness::LittleEndian`. Mismatch silently breaks all parity. |
| `random_a` source | §3.2 ("proof-bound `random_a`") | `outRandom` is a private witness, not exposed to the pool. Even with the proposed "use commitment_out[0]'s random" alternative, only the *commitment* (a hash *of* random) is public; random itself is unrecoverable. |
| `spending_pub_x`, `spending_pub_y` source | §3.2 ("from proof public input (recipient_bind reconstruction)") | Not in any public input. recipient_bind in adapt_execute is `Poseidon_3(tag, 0, 0)` — a public constant carrying no user identity. |
| Spending pub field decomposition | §3.2 ("`spending_pub_x`, `spending_pub_y`") | Commitment template uses a single Fr `spendingPub` input, not an (x, y) pair. Poseidon over BN254 has no native EC-coordinate notion. |
| `tree_state.append_leaf` API | §3.2 ("if it's hardcoded to 2-per-tx, refactor") | Already supports N. The current handler loops over `commitment_out.iter()` calling `tree_append` per-element. No hardcode. |
| Refactor `nullifier_remaining_consumed` slicing | n/a (the PRD overlooked this) | If excess minting happens *after* the adapter CPI in `adapt_execute.rs`, `tree_append` adds a leaf inside the same handler. The remaining-accounts slicing in inline-cpi mode is not affected (only nullifier accounts ride there), but any new accounts the excess flow needs would have to extend the slicing convention. None do, so this is fine. |

## §6. Three viable redesigns (sketched, not built)

### Option A — circuit change to expose `outSpendingPub[0]` as a public input

- One additional public signal added to `adapt.circom`'s `public [...]` block. Total grows from 23 → 24.
- Cost: re-run trusted setup for the adapt circuit (Powers of Tau already exist; ceremony is per-circuit and takes a single-machine afternoon). Re-deploy `b402_verifier_adapt` with the new VK and pool's `verifier_adapt` config pointer updated.
- Wire cost: +32 B per adapt_execute (one more Fr in the public input vector). Phase 7B's 1153 B simple swap → 1185 B. Phase 7B's 1177 B complex swap (24 ra) → 1209 B. Both fit under 1232.
- CU cost: +~3K for one more public-input scalar mult in the verifier. Negligible against current 558K usage.
- After landing: PRD §3.2 implementation becomes literal — pool reads `pi.out_spending_pub` directly and computes `commitment_b` exactly per the pseudocode (with the endianness + tag fixes from §5 above).
- **Risk profile**: highest disruption (circuit + verifier deploy) but cleanest end state. Existing v2.1 mainnet remains unaffected because we're shipping a new feature flag combo (`inline_cpi_nullifier + dual_note`).

### Option B — pool emits an *encrypted-only* excess hint; SDK appends out-of-band

- Pool emits `ExcessNoteHint { leaf_index: u64, excess: u64, commitment_a: [u8;32] }` event but does NOT append a leaf to the tree.
- SDK observes the event, computes its own `commitment_b = Poseidon(TAG_COMMIT, outMint, excess, randomB, spendingPub)` (it knows all four inputs), inserts into the local NoteStore.
- Spending the excess note later: the SDK has no merkle proof for it because it was never appended to the tree. The transact circuit's input-spend constraint `merkleRoot[i] === computedRoot` (`adapt.circom:190-191`, mirrored in `transact.circom`) requires a real path. **The user can never spend the excess note. Fails Goal §2.**
- **Risk profile**: trivial to implement, but does not deliver the goal. Reject.

### Option C — value-anchored leaf shape + new spend branch

- Define a second leaf shape: `commitment_excess = Poseidon(TAG_EXCESS_LEAF, commitment_main, excess)` where `commitment_main` is the existing `commitment_out[0]` for the swap.
- Pool can compute this in Rust today — both inputs are public on-chain.
- New spend circuit (`spend_excess.circom`, fresh primitive) proves: "I know the preimage of `commitment_main` (i.e. I own the main note); I observed `commitment_excess` linked to `commitment_main` with value `excess`; therefore I claim `excess` units." No `spending_pub` directly — owner identity flows transitively from `commitment_main`.
- Costs: a new circuit (~200 LoC), new VK, new on-chain verifier program, new SDK code path, new nullifier shape. Multi-day work, broader audit surface.
- **Risk profile**: avoids re-trusting the adapt setup but introduces a whole new primitive. Larger overall scope than Option A.

### Option D — defer to Phase 8 (Jito bundle / split tx)

- Skip dual-note for swaps. Accept the dust until a separate "sweep dust" tx primitive is built later.
- Per-swap economic loss capped at slippageBps. At 100 bps and small swaps this is bearable; at $1M scale it's not, as PRD §1 notes.
- **Risk profile**: punts the problem. Unblocks Phase 9 demo claim only if the demo is rephrased.

**My recommendation, for the user's review**: Option A is the cleanest match to the PRD's intent and unblocks the demo claim verbatim ("zero slippage loss"). It's the largest deploy event of the four (new VK on-chain) but it's a one-shot expense that aligns with how every other existing circuit was built. Options B and C either fail the goal (B) or invent a parallel primitive (C); Option D defers.

## §7. State of the branch at this checkpoint

- `git rev-parse HEAD` → `7e21ff0` (`sdk: opt-in tx-size diagnostic for privateSwap (B402_DEBUG_TX=1)`) — same as `feat/phase-7-inline-cpi` HEAD when the spike began. Branch was created via `git switch -c feat/phase-9-dual-note`.
- Working tree carries the same uncommitted modifications that were on `feat/phase-7-inline-cpi` at session start (PRD-21 doc edits, mcp-server private_swap polish, sdk b402.ts changes — all unrelated to Phase 9).
- This file (`docs/prds/PHASE-9-spike-notes.md`) is the only Phase-9-specific addition and is intentionally the only thing I am proposing to commit.
- No `.so` was built, no new tests were added, no SDK code was modified for Phase 9.

## §8. What the user does next

1. Read this document. Compare against the PRD §3.2 sketch.
2. Decide between Options A / B / C / D in §6 (or articulate a fifth path).
3. If Option A: schedule a trusted-setup rerun for the adapt circuit, then green-light the implementation. The circuit edit is one signal added to the `public [...]` list; the SDK already has `outSpendingPub` in the witness.
4. If Option C: scope the new `spend_excess` primitive as a follow-up PRD (PHASE-9-B-spend-excess.md). The current dual-note PRD becomes obsolete.
5. If Option D: close this PRD and reframe the Phase 9 demo claim.

After the user's call I can resume implementation cleanly from this branch — no rework of what's been written here, just additive commits per the chosen option.

## §9. Open questions only the user can answer

1. Is a new trusted setup acceptable for adapt? The current VK was generated 2026-04-XX; running a fresh ceremony involves [list of contributors]. Solo-machine setup is fine for a v1 testnet but suboptimal for mainnet trust.
2. Is the 32-byte wire-cost of one extra public input acceptable? Phase 7B's headroom calc was based on 23 public inputs; 24 inputs leaves +32 B less for adapter accounts in the worst-case route.
3. For Option C, is a separate "spend excess" tx (1 tx per excess claim) acceptable UX? Or does the PRD demand single-tx atomicity (in which case Option A is the only path)?
4. Phase 9's demo claim ("first composable private DEX swap on Solana — zero slippage loss") — is it OK to weaken to "≤slippageBps loss" for now if Option D is taken? Or is "zero loss" a hard demo constraint?
