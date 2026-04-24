# Anatomy of a b402-solana shield transaction

Real tx from our local test-validator run, dissected layer by layer. Mirrors
what you'd see on Solscan for a shield/unshield on Solana — the equivalent
of the Basescan view you'd get for a Railgun shield on Base EVM.

## Sample tx: shield 100 tokens

```
signature:   3nNYqY4RozZyDqb3WLnmuStZUK512LLvdr9LKTHKGoJY3kti78ZsXPvy7oQPc8RieAFETC5PwzLEavu3LUBj25rN
slot:        3068
status:      ✅ Finalized
fee:         0.00001 SOL (~$0.002 @ $200/SOL)
instructions: 2  (ComputeBudget, Shield)
compute:     239,224 CU total (out of 1,400,000 requested)
size:        1,157 bytes (under 1,232 limit)
```

---

## The 12 accounts

Every Solana tx declares which accounts it touches. The pool program reads
from / writes to these:

| # | Role | Account | Why |
|---|---|---|---|
| 0 | relayer (signer, writable) | `5bqQQQQ...Manv` | Pays SOL fee |
| 1 | depositor (signer, writable) | `GUC2Ekf...xMXt` | Authorizes token transfer |
| 2 | depositor ATA (writable) | `HoxixpS...7SQN` | Source of 100 tokens |
| 3 | TokenConfig PDA (read) | `ESD5w1M...ToGKPK` | Proves mint is whitelisted |
| 4 | Vault PDA (writable) | `AsL6hJD...P86Abr` | Destination — holds shielded tokens |
| 5 | TreeState PDA (writable) | `8pEMXAq...QNHu` | Merkle tree, gets new leaf |
| 6 | PoolConfig PDA (read) | `Ay8jgsA...DqFaw` | Pause flags, pinned verifier address |
| 7 | Verifier program (read) | `G6AycE5...hEC7` | `b402_verifier_transact` for CPI |
| 8 | SPL Token program | `TokenkegQfeZ...` | For CPI token transfer |
| 9 | System program | `1111...1111` | For any account creation |

The pool, verifier, SPL Token, and System programs are the same across all
b402-solana txs. The other 6 depend on which user / which mint.

---

## Instruction data (1,099 bytes)

```
[0..8]       Anchor discriminator for "shield"
             = sha256("global:shield")[..8]
             = dc c6 fd f6 e7 54 93 62

[8..12]      u32 LE length of `proof` Vec<u8> = 256

[12..268]    Groth16 proof, 256 bytes
             = proof_A (64B, y-negated) || proof_B (128B) || proof_C (64B)

[268..580]   TransactPublicInputs struct (312 bytes total):
             merkle_root       [32]
             nullifier         [32][32]   (both zero — shield has no inputs)
             commitment_out    [32][32]   (out[0] = real, out[1] = zero)
             public_amount_in  u64 LE     = 100
             public_amount_out u64 LE     = 0
             public_token_mint [32]       (raw Solana mint pubkey)
             relayer_fee       u64 LE     = 0
             relayer_fee_bind  [32]
             root_bind         [32]
             recipient_bind    [32]       (bind owner pubkey — zero for shield)

[580..584]   u32 LE length of encrypted_notes Vec = 0
             (self-shield: depositor knows the note, no on-chain ciphertext)

[584..585]   u8 note_dummy_mask = 0b10
             (output 0 real, output 1 dummy)
```

The on-chain handler deserializes this, validates, calls the verifier,
transfers the token, appends the commitment to the tree, emits events.

---

## Program execution trace

```
Program ComputeBudget111111111111111111111111111111 invoke [1]
  ← set_compute_unit_limit(1_400_000)
Program ComputeBudget... success

Program 2vMTGvSCobE7HfVvdSHsmVNzCFmbYdc3TsQwekUwcusy invoke [1]
Program log: Instruction: Shield
  ← pool program entered

  Validates:
    - paused_shields == false
    - pinned verifier_program matches
    - public_amount_in > 0, _out == 0, fee == 0
    - mint matches token_config.mint
    - merkle_root is in the 128-entry root ring
    - nullifier[0] == nullifier[1] == 0 (shield has no inputs)

  Builds 18 public inputs on the heap (avoid blowing 4 KB BPF stack):
    [0]  merkle_root
    [1]  nullifier[0] = 0
    [2]  nullifier[1] = 0
    [3]  commitment_out[0]
    [4]  commitment_out[1] = 0
    [5]  u64_to_fr_le(public_amount_in)
    [6]  u64_to_fr_le(public_amount_out)
    [7]  reduce_le_mod_p(mint.to_bytes())   ← canonicalize
    [8]  u64_to_fr_le(relayer_fee)
    [9]  relayer_fee_bind
    [10] root_bind
    [11] recipient_bind
    [12..17] 6 domain tags (commit, null, mk-node, spend-pub, fee-bind,
             recipient-bind) — verified by program matching PoolConfig

  Program G6AycE529UPg1hib72A5A7Yf8eZRx9uFmDZQYMSYhEC7 invoke [2]
    ← verifier CPI (Anchor-formatted: discriminator + Vec<u8> length + payload)
  Program log: Instruction: Verify
    - parses proof (A 64B, B 128B, C 64B)
    - reverses endianness LE → BE for ark_bn254
    - Groth16Verifier::new(proof, publics, &baked_VK)
    - 3 pairings + IC multi-scalar-mul via Solana alt_bn128 syscalls
    - returns Ok → proof valid
  Program G6Ayc... consumed 178,319 CU
  Program G6Ayc... success

  Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2]
    ← CPI to SPL Token
  Program log: Instruction: Transfer
    - depositor_ata → vault, 100 tokens
    - authority = depositor (real signer)
  Program Token... consumed 4,645 CU
  Program Token... success

  Tree append:
    - zero_copy TreeState load_mut (no memcpy)
    - tree_append(commitment_out[0])
      * walk 26 levels via sol_poseidon
      * update frontier[lowest_zero_bit]
      * advance root_ring[(ring_head + 1) % 128]
      * leaf_count += 1
    - emit!(CommitmentAppended { leaf_index, commitment, ..., tree_root_after })
    - emit!(ShieldExecuted { mint, amount, slot })

Program 2vMTGv... consumed 239,224 CU
Program 2vMTGv... success
```

---

## Events (Anchor `emit!` → `Program data` log lines)

Two events fire, both as base64-encoded `Program data:` lines:

```
CommitmentAppended {
  leaf_index:      4             ← our position in the 2^26-capacity tree
  commitment:      [32 bytes]    ← Poseidon_5(tag, mint, amount, random, spendingPub)
  ciphertext:      [89 zeros]    ← self-shield omitted the encrypted note
  ephemeral_pub:   [32 zeros]
  viewing_tag:     [2 zeros]
  tree_root_after: [32 bytes]    ← new merkle root
  slot:            3068
}

ShieldExecuted {
  mint:   BAYFsn9...pp9
  amount: 100
  slot:   3068
}
```

Indexers watch for these events to rebuild the global tree + track pool TVL.

---

## What's hidden vs. revealed

| Data | On chain | Visible to |
|---|---|---|
| Depositor pubkey (signer) | ✅ | Everyone |
| Source ATA | ✅ | Everyone |
| Mint being shielded | ✅ | Everyone |
| **Amount shielded** | ✅ (`public_amount_in` in public inputs) | Everyone |
| **Vault balance** | ✅ | Everyone (aggregate TVL by mint) |
| **Commitment** (opaque bytes) | ✅ | Everyone, but they can't open it |
| **Contents of commitment** (who owns it, for what purpose) | ❌ | Only holder of spendingPriv |
| Future unshield destination | ❌ | Nobody until unshield happens |
| Nullifier for this note | ❌ (zero on shield) | — (revealed on spend) |

Shield is a one-way valve: amount is public going in, but the *identity* of
the future spender is hidden. When they later spend (via `unshield` or
`transact`), they reveal only a nullifier — which is cryptographically
unlinked from the original shield.

---

## Unshield — the symmetric flow

```
signature:   2bZY61j58TN1gAZh8oFNr7ccd897hZLMXdnhtQmmUQwr1ky6ngZxwM8bNdFVYZ8EhhL5zooy7i4XpghBDgTmagf4
fee:         0.000005 SOL
compute:     221,592 CU
```

Different instruction, similar shape:

```
accounts (12 total):
  relayer (signer)
  PoolConfig (read)
  TokenConfig (read)
  Vault (write)                   ← drained by 100
  recipient_token_account (write) ← recipient gets 100
  relayer_fee_token_account (write) ← unused when fee=0
  TreeState (write)               ← root advances (no leaf if full unshield)
  Verifier (read)
  NullifierShard[prefix_0] (write) ← nullifier inserted here
  NullifierShard[prefix_1] (write) ← dummy shard (not touched for 1-input spend)
  SPL Token + System

program flow:
  ...validate paused, mint, root-ring...
  CPI → verifier (Groth16, 178 k CU)
  recipient_bind check:
    expected = Poseidon_3(tag, recipient.owner[0..16]_u128, recipient.owner[16..32]_u128)
    assert pi.recipient_bind == expected  ← binds owner pubkey into proof
  nullifier_insert(shard, nullifier)
    - binary-search sorted shard
    - error if duplicate = NullifierAlreadySpent
  vault → recipient_token_account, 100 tokens (pool PDA signs)
  emit!(NullifierSpent, UnshieldExecuted)
```

What binds the destination: the **recipient_bind** public input. The
on-chain program computes `Poseidon_3(tag, owner_low, owner_high)` from
`recipient_token_account.owner` and compares to the proof's committed
value. Malicious relayer can't swap in their own ATA — the proof doesn't
verify for any owner other than the one the sender chose.

---

## Mapping to the Basescan view

Your Base shield tx shows:
- Entry Point 0.7.0 → ERC-4337 wrapper (our analog: relayer keypair, since
  Solana doesn't need account abstraction for gasless)
- RelayAdapt 0x437Df42F... → the Railgun composition layer (our analog:
  `b402_jupiter_adapter` / `b402_mock_adapter` — Phase 2)
- Railgun main 0x26111e23... → the shielded pool contract (our analog:
  `b402_pool` at `2vMTGvSCobE...Pool` on our test validator)
- Treasury 0x2dBe91FF... (79 USDC fee) → our `TreasuryConfig` PDA (no fee
  in v1 — 0% protocol fee locked in PRD-01 §11)
- 26,921 USDC transfer → our `Vault PDA` deposit

The structural difference from EVM Railgun: on Solana the tree state,
nullifier set, pool config, and per-token vaults are all **separate
accounts** (PDAs) rather than all being slots of one contract. Each
instruction declares up front exactly which ones it touches; the runtime
parallelizes transactions that don't conflict on those accounts.

---

## Timing at every layer

| Phase | Wall time | Where |
|---|---:|---|
| SDK assembles witness | ~5 ms | TS |
| Merkle root fetch from RPC | ~30 ms | RPC roundtrip |
| **Groth16 proof generation** | **~800 ms** | snarkjs (WASM) |
| Instruction encoding | ~1 ms | TS |
| Tx signing | ~2 ms | TS (ed25519) |
| RPC submit | ~50 ms | RPC roundtrip |
| Validator processes tx | ~30 ms | Solana runtime |
| **`confirmed` commitment** | **~400 ms** | (1 slot + gossip) |
| **Total wall time** | **~1.3 s** | |

Proof generation is the dominant cost. Rapidsnark (C++) would cut it to
~250 ms; we're using snarkjs for simplicity in v1.

---

## Running your own shield to reproduce

```bash
# Terminal 1: boot validator
./ops/local-validator.sh --reset

# Terminal 2: run the demo
cd examples && pnpm e2e
```

Then pull up any tx hash in the output:

```bash
solana -u http://127.0.0.1:8899 confirm -v <signature>
```

You'll see every detail this doc describes.
