# PRDs

Sequenced product requirements documents for `b402-solana`. Each PRD gates the next — do not start work on a downstream PRD until upstream is signed off.

## v1 protocol (signed)

| # | Title | Status |
|---|---|---|
| 01 | Protocol Architecture & Design Decisions | Draft |
| 01-A | Amendment: CU budget, Light CMT evaluation, hackathon track, hybrid MPC+ZK rejection | Draft |
| 02 | Cryptographic Spec | Draft |
| 03 | Anchor Program Spec | Draft |
| 04 | Composability Layer (RelayAdapt equivalent) | Draft |
| 05 | DeFi Adapters (Jupiter, Kamino, Drift, Orca) | Draft |
| 06 | TypeScript SDK | Draft |
| 07 | Testing Strategy & TDD Plan | Draft |
| 08 | Audit & Launch Plan | Draft |
| 09 | Kamino Lend/Borrow Adapter | Implementation underway |
| 10 | Drift Perp Adapter | Deferred (post-incident reboot) |

## v2 ABI — must (lock the protocol)

| # | Title | Status |
|---|---|---|
| 11 | Vector Token Bindings (M-in / N-out) | Draft |
| 12 | Content-Addressed `action_hash` (keystone) | Draft |
| 13 | Shadow PDA Derivation Spec | Draft |
| 14 | Two-Phase Async with Claim Notes | Deferred — until first async adapter |
| 15 | Delta-Zero Adapt + Deadline Slot | Draft |
| 16 | Adrena Adapter (first v2-native) | Draft |
| 24 | Phoenix Adapter (Spot CLOB → Maker → Rise) | Spike |

The v2 ABI is **non-breaking with respect to deployments**: v1 devnet deployments stay live during the v2 rollout. A new Phase-2 ceremony + redeploy only happens once v2 is proven on a feature branch and audited.

## v2+ forward (designed-for, ship-later)

| # | Title | Status |
|---|---|---|
| 17 | Recursive Proof Aggregation (Nova / Sonobe folding) | Forward |
| 18 | Programmable Note Policies | Forward |
| 19 | Multi-Asset Notes | Deferred — PRD-11 covers same use cases via dual notes |
| 20 | Verifiable Scanner | Forward |
| 21 | PQ-Readiness Migration Path | Forward |
| 22 | Bonded Relayer Market | Forward |
| 23 | Encrypted Intents Layer | Forward |

Forward PRDs are not on the v2 critical path. They are specified now so the v1/v2 architecture does not preclude any of them.

## Review process

Each PRD moves through: **Draft → Under Review → Revisions → Signed Off → Locked**.

Once a PRD is **Locked**, its decisions are load-bearing for downstream PRDs and cannot be changed without an explicit amendment noted in the Revision History.
