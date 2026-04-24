# Frontier submission strategy

Internal doc. Not for the repo README.

## Track

There are no tracks. Frontier 2026 is one main competition, judged holistically by 40+ judges from Solana Foundation, Phantom, Superteam, and ecosystem VCs.

Targets:
- **Grand Champion — $30,000** (1 team)
- **Standout Team — $10,000** (20 teams)
- **Accelerator acceptance — $250k pre-seed** (real prize)

Side-bounties run on Superteam Earn separately. The current Arcium side-bounty on Superteam Earn is the Cypherpunk one, already closed. If a Frontier-specific Arcium bounty posts before May 11, we pursue it as a secondary submission with an integration demo (not the core product).

## Submission requirements

1. GitHub repo with code demonstrably created during the hackathon window (Apr 6 – May 11).
2. Pitch deck.
3. Demo video (product walkthrough, recorded).
4. Weekly video updates (optional but boosts visibility).

All deliverables by **2026-05-11**.

## Value proposition (one paragraph for the submission)

> **b402-solana brings private DeFi composability to Solana.** Today, agents transacting on Solana leave full on-chain footprints — strategies, holdings, and behavioral patterns are public by default. Privacy.cash solves transfers only; Arcium/Umbra use a different trust model and no DeFi composability; Token-22 confidential transfer is disabled pending audit. b402-solana ships the first Solana SDK giving agents a production-grade shielded pool with atomic composability into Jupiter, Kamino, Drift, and Orca — shield USDC/SOL, execute any DeFi action from inside the pool, reshield the output, all in one gasless transaction. Same API we already ship on Base, Arbitrum, and BSC via our Railgun fork (`@b402ai/sdk`), now unified across chains. 0% protocol fee, permissionless relayers, ZK-sovereign trust model.

## Differentiation — concrete, judge-readable

| | b402-solana | Privacy.cash | Umbra/Arcium | Token-22 CT |
|---|---|---|---|---|
| Shielded SPL tokens | Yes | Planned | Yes | Disabled |
| Private Jupiter swap | Atomic in-pool | Planned | Encrypted (MPC) | — |
| Private Kamino lending | Yes | No | No | — |
| Private Drift perps | Yes | No | No | — |
| Private Orca LP | Yes | No | No | — |
| Protocol fee | **0%** | 0.35% | TBD | 0 |
| Trust model | ZK (Groth16) | ZK (Groth16) | MPC | ZK (ElGamal) |
| Compliance stance | Permissionless | Mandatory KYT | Built-in screening | — |
| Agent SDK / MCP | Yes | No | Partial | — |
| Multi-chain unified API | Yes (Base/Arb/BSC/Solana) | Solana + Base | Solana | Solana |

## Narrative hooks

- **Track record.** b402 team already ships the EVM counterpart in production on Base, Arbitrum, and BSC. This is a port, not a first attempt. Risk-down for the judges.
- **Agents.** Solana's 2026 narrative is agent activity. Private DeFi is a load-bearing primitive for agents operating with real capital.
- **Interoperability.** `@b402ai/sdk` + `@b402ai/solana` + b402-mcp means every agent building on Claude/GPT tool-calling gets Solana privacy for free.
- **Credibility.** EF ESP application open. Kohaku adapter shipped. Light Protocol, Privacy & Scaling Explorations reachable for Phase-2 ceremony.

## Demo script (outline)

1. Agent wallet connects. Cold start, zero funding.
2. Developer calls `b402.shield({ chain: 'solana', token: 'USDC', amount: 10 })` — agent shields 10 USDC.
3. Call `b402.privateSwap({ from: 'USDC', to: 'SOL', amount: 5 })` — atomic unshield → Jupiter → reshield.
4. `b402.privateLend({ token: 'USDC', amount: 3, vault: 'kamino-main' })` — 3 USDC to Kamino.
5. `b402.status()` — shows balances without revealing to chain observers.
6. Unshield to a clean address; explorer link: sender unlinkable from recipient.
7. Screen-side: chain observer view — pool TVL visible, none of the moves are attributable.
8. Tie to EVM: same SDK call, swap `chain: 'base'`. Multi-chain privacy, one API.

## What "real" means for us

The submission is devnet-deployed alpha. Every piece is real code executing real operations:
- Circom circuit is real, compiles, tests pass.
- Groth16 proof generation is real (WASM).
- Anchor program is real, deployed on devnet, verifies proofs on-chain.
- Jupiter CPI is real, swapping live devnet tokens.
- SDK calls construct real transactions with real proofs.

What we do **not** do:
- Mock the verifier with a returns-true stub.
- Fake the circuit with a hand-crafted "proof".
- Ship a UI that pretends work is happening.
- Simulate Jupiter responses.

Every shortcut is a "smaller scope" shortcut, not a "fake it" shortcut.

The README will label this "alpha, devnet only, not audited, not mainnet-safe" in the first paragraph so nobody deploys funds to it.
