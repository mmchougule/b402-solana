# PRD-A04 - Fuzzing

| Field | Value |
|---|---|
| Status | Active |
| Owner | b402 core |
| Date | 2026-04-23 |
| Version | 1.0 |
| Depends on | PRD-A01, PRD-A02, PRD-A03 |
| Purpose | Define exact fuzz targets, oracles, corpora, and crash-handling policy |

## 1. Objective

Fuzz the highest-risk parser, serialization, and state-transition edges until malformed inputs are exhausted into typed failures rather than panics or corrupted state.

## 2. Fuzzing philosophy

Do not start with whole-program fuzzing as a blunt instrument.

Start with the narrowest, highest-leverage surfaces:
- byte parsing
- state mutation helpers
- instruction-argument validation
- model-checked transition boundaries

Then widen to instruction-sequence fuzzing once the oracles are mature.

## 3. Rust fuzz targets

Required initial targets:

1. `fr_decode_canonical`
- input: arbitrary 32-byte arrays
- oracle: decode succeeds only for canonical elements; never panic

2. `nullifier_insert`
- input: arbitrary existing shard state plus candidate nullifier
- oracle: shard remains sorted; count remains valid; duplicate spends reject cleanly

3. `tree_append`
- input: arbitrary valid tree snapshots plus leaf
- oracle: either append succeeds with coherent state or returns typed error; never produce invalid leaf count/root relation

4. `verify_payload_parse`
- input: arbitrary verifier instruction bytes
- oracle: invalid lengths and malformed slices reject cleanly; no panic

5. `transact_public_inputs_builder`
- input: arbitrary structured fields near bounds
- oracle: public-input layout stays fixed and bounded; no overflow or silent truncation

6. `note_store_ingest`
- input: arbitrary encrypted note bytes, tags, indices
- oracle: either reject or produce internally coherent spendable note

## 4. Instruction fuzz targets

Second-wave targets:
- `shield_args_decode`
- `transact_args_decode`
- `unshield_args_decode`
- adapter registration validation

Oracle:
- malformed args return typed errors
- no unchecked allocation growth
- no stack-sensitive path panics

## 5. Stateful fuzzing

Add a stateful fuzz harness after PRD-A03 model work is in place.

Action alphabet:
- shield
- transact
- unshield
- pause
- unpause
- register adapter

Oracle after each action:
- all PRD-A03 invariants still hold
- model and implementation stay aligned where comparable

## 6. Corpus policy

Store all corpora under:
- `b402-assurance/corpora/rust/`
- `b402-assurance/corpora/stateful/`

Rules:
- every crash must be minimized before commit
- every confirmed bug gets a regression test outside the fuzz target
- every seed corpus file needs a one-line description in `corpora/README.md` once implemented

## 7. Runtime policy

Required schedules:
- local developer smoke run: 60 seconds per target
- pre-merge run: 10 minutes per target
- nightly run: 4 hours across all key targets

No result counts as meaningful unless:
- corpus directory is stable
- seed list is versioned
- replay command is documented

## 8. Implementation steps

1. Add Rust fuzz crate or target layout under the assurance workspace.
2. Implement narrow parser and helper fuzz targets first.
3. Add replay scripts and corpus minimization scripts.
4. Add regression extraction workflow from crashes to normal tests.
5. Add stateful action-sequence fuzzing after invariant oracles are proven.

## 9. Exit criteria

PRD-A04 is complete when:
- all initial narrow targets exist
- pre-merge runtime completes clean
- nightly runtime plan exists and is reproducible
- corpora are versioned
- every discovered crash path has a normal regression test

## 10. What this phase must catch

The fuzzing phase is specifically meant to shake out:
- malformed proof payload parsing
- endian and slice-boundary mistakes
- sorted-shard corruption
- root/public-input layout drift
- malformed encrypted note handling
- pathological near-capacity shard behavior
