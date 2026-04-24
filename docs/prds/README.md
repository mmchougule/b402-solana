# PRDs

Sequenced product requirements documents for `b402-solana`. Each PRD gates the next — do not start work on a downstream PRD until upstream is signed off.

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

## Review process

Each PRD moves through: **Draft → Under Review → Revisions → Signed Off → Locked**.

Once a PRD is **Locked**, its decisions are load-bearing for downstream PRDs and cannot be changed without an explicit amendment noted in the Revision History.
