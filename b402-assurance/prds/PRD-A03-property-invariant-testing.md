# PRD-A03 - Property and Invariant Testing

| Field | Value |
|---|---|
| Status | Active |
| Owner | b402 core |
| Date | 2026-04-23 |
| Version | 1.0 |
| Depends on | PRD-A01, PRD-A02 |
| Purpose | Define property tests for pure components and stateful invariant tests for the pool and adapters |

## 1. Objective

Move from example-based correctness to quantified behavioral guarantees.

This phase establishes:
- pure property tests for deterministic components
- state-machine invariant tests for pool behavior
- sequence tests for realistic instruction interleavings

## 2. Pure property tests

### 2.1 Rust crypto properties

Targets:
- `Fr`
- Poseidon wrappers
- `MerkleTree`
- note/nullifier derivation

Required properties:
- determinism
- input sensitivity
- append monotonicity
- proof verification soundness under sibling/path tamper
- no duplicate nullifier acceptance in shard insertion
- canonical and reduced decoding behavior separated cleanly

Minimum runs:
- 10,000 iterations per primitive property

### 2.2 TypeScript properties

Targets:
- `packages/sdk/src/merkle.ts`
- `packages/sdk/src/poseidon.ts`
- `packages/sdk/src/note-encryption.ts`
- `packages/sdk/src/wallet.ts`

Required properties:
- same-wallet same-seed determinism
- different context labels imply key separation
- note encrypt/decrypt round-trip
- wrong viewer cannot decrypt
- viewing tag false-positive rate is functionally negligible in tested corpus
- proof helper serialization is stable

Minimum runs:
- 5,000 iterations per property

## 3. Stateful invariant tests

State machine model:
- pool config
- token config
- tree state
- nullifier shards
- vault balances
- adapter registry

Actions:
- init pool
- add token config
- shield
- transact
- unshield
- register adapter
- pause
- unpause

Assertions after every action:
- `leaf_count` never decreases
- `root_ring` newest root is derived from prior state by append or unchanged
- nullifiers never disappear
- duplicate nullifier spend cannot succeed
- unshield is never blocked by pause state
- vault cannot be drained below proof-bound amounts
- disabled adapter cannot execute

## 4. Model-vs-implementation testing

Create a small executable reference model in the assurance workspace.

Purpose:
- the reference model tracks intended semantics without Anchor account machinery
- randomized action sequences run against both the model and the implementation
- divergences are minimized and reported

Required model outputs:
- expected leaf count
- expected root ring head progression
- expected spent nullifier set
- expected vault delta

## 5. Instruction-sequence scenarios

Minimum sequence suites:
- 100 short sequences of length 10
- 100 medium sequences of length 50
- 20 long sequences of length 250

Must include:
- repeated shields on same mint
- spend then replay attempt
- pause shields then unshield
- mixed dummy/non-dummy note cases
- interleaved adapter enable/disable
- root freshness expiry simulation

## 6. Implementation steps

1. Add pure Rust property tests for crypto and Merkle.
2. Add TS property tests for wallet, note encryption, and Merkle mirror logic.
3. Build the reference state-transition model in `b402-assurance/rust/model/`.
4. Add sequence generators with explicit seeds and reproducible failure replay.
5. Add invariant reports showing total action count, failures, and minimized seeds.

## 7. Exit criteria

PRD-A03 is complete when:
- all pure property suites pass at required iteration counts
- model-vs-implementation sequence tests pass
- invariant reports exist and are reproducible
- every failure replay is seed-addressable

## 8. Solana-specific red flags to capture

The invariant harness must explicitly test for:
- single-writer tree contention assumptions
- root ring exhaustion under delayed proof submission
- large shard insertion edge cases near capacity
- account-order sensitivity in instruction construction
- account reuse across sequences
