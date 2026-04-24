# PRD-08 — Audit and Launch Plan

| Field | Value |
|---|---|
| **Status** | Draft — awaiting review |
| **Owner** | b402 core |
| **Date** | 2026-04-23 |
| **Version** | 0.1 |
| **Depends on** | PRDs 01–07 |
| **Gates** | Mainnet launch |

This PRD defines the path from code-complete to mainnet users holding real funds. It is the least glamorous PRD and the most load-bearing — shipping shielded-pool code without this plan is malpractice.

---

## 1. Audit scope and firms

### 1.1 Components in scope

| Component | Priority | Firm preference |
|---|---|---|
| Transact circuit | P0 | Veridise (formal verification) + ZK-auditor-capable firm |
| Adapt circuit | P0 | Same |
| Disclose circuit | P1 | Same, smaller scope |
| Pool program (`b402_pool`) | P0 | Solana-native firm (Accretion, Sec3, OtterSec, Zellic) |
| Verifier programs | P0 | Shared — uses `groth16-solana` (already audited) + our wrapper |
| Adapter programs | P1 | Solana firm, per-adapter review |
| SDK | P2 | Code review by third party; not a full audit |
| Relayer service | P2 | Code review |

### 1.2 Firm shortlist

- **Veridise** — ZK / formal verification. Has audited Privacy.cash and many ZK protocols. Retain for circuits + FV.
- **Accretion** — Solana-native Anchor specialists. Retain for pool + adapters.
- **OtterSec** — Solana coverage. Alternative or secondary to Accretion.
- **Zellic** — solid on Solana, Rust, and cryptography bridges. Consider for a second independent pass on the pool program.
- **Sec3** — automated + manual Solana audit; useful as a lightweight "pre-audit" before the primary engagement.

**Plan:**
- Primary circuit audit: **Veridise** including FV of transact circuit.
- Primary program audit: **Accretion** (pool + adapters).
- Secondary/independent: **Zellic** on the pool program only.
- Pre-audit scanning: **Sec3** automated tools + internal.

### 1.3 Budget

Rough estimates, subject to quote. ZK circuits price 80–120% above EVM baseline (PRD-01-A-reference).

| Line item | Range |
|---|---|
| Veridise — circuits + FV | $150k – $250k |
| Accretion — pool + adapters | $80k – $140k |
| Zellic — pool (secondary) | $40k – $70k |
| Bug bounty reserve | $500k committed |
| **Subtotal** | **$270k – $460k + bounty** |

$250k Colosseum pre-seed covers a meaningful share. Additional funding required for full program; EF ESP application is open.

### 1.4 Timeline

| Phase | Duration |
|---|---|
| Internal freeze + final testing | 2 weeks |
| Veridise engagement (circuits) | 6–8 weeks |
| Accretion engagement (programs) | 4–6 weeks, overlap with Veridise |
| Zellic secondary | 3–4 weeks, sequential after Accretion |
| Remediation cycles | 3–4 weeks |
| Final sign-off + public report | 2 weeks |
| **Total** | **~16–22 weeks from freeze to mainnet** |

If Track B (hackathon) ships May 11, and Track A freeze starts shortly after, mainnet target is Q4 2026.

---

## 2. Trusted setup ceremony (Phase-2)

### 2.1 Pre-ceremony prerequisites

- Circuits frozen at a specific commit. No edits post-ceremony.
- Phase-1 PPoT transcript selected and pinned (PRD-02 §7.1).
- Ceremony coordinator identified, separate from contributors.
- Verification scripts ready; test-run against a dev ceremony.

### 2.2 Contributors (target list)

**Confirmed slot for b402 core** — one contribution.

**External candidates (ordered by preference):**
1. **Privacy & Scaling Explorations** (Ethereum Foundation). Ran many ceremonies. Strong reputational weight.
2. **Aztec Labs** — Noir / Groth16 background.
3. **Light Protocol** — relevant Solana ZK context; their groth16-solana is in our trust base.
4. **Kohaku contributors** (b402 already has a working relationship via `@b402ai/kohaku`).
5. **Privacy.cash team** — cross-ecosystem legitimacy.
6. **An academic team** (Stanford Applied Crypto, UIUC DeCal, etc.).

Goal: **3 confirmed external contributors** before opening ceremony. More is better.

### 2.3 Ceremony operational plan

Per contributor:

1. Coordinator ships a prepared USB drive + signed checklist.
2. Contributor boots a fresh Linux live system with no network on a fresh machine (no prior use).
3. Contributor runs `snarkjs zkey contribute` with entropy from three independent sources (hardware RNG, dice, public-random-beacon mix).
4. Contributor signs attestation with their public key, publishes attestation + output `zkey` hash to the public log.
5. Contributor destroys the machine's storage (physical destruction) and posts photo.
6. USB drive returns to coordinator; next contributor repeats.

**Public log:** GitHub repo `b402-ai/b402-solana-ceremony` with every attestation, running hash chain, and per-contributor statement.

### 2.4 Post-ceremony

- Final `zkey` and `verificationKey.json` hashed; hash embedded in verifier program at build time.
- Full ceremony archive pinned to IPFS + Arweave.
- Public "ceremony complete" statement signed by all contributors.

---

## 3. Bug bounty

### 3.1 Structure

- Platform: **Immunefi** (primary) + direct-to-team bounty for ZK-specific findings.
- Scope: circuits + pool + adapters + verifier wrapper.
- Severity tiers + rewards:
  - Critical (fund loss / double-spend / unauthorized unshield): **$500k**.
  - High (admin privilege escalation, DoS on unshields): $100k.
  - Medium (adapter misrouting, non-fatal DoS): $25k.
  - Low (events/indexer issues): $2k.
- Out of scope: frontend-only issues, relayer service issues (separate smaller bounty).

### 3.2 Pre-bounty: private disclosure window

- 2-week window post-audit where named auditors + invited researchers can report privately for enhanced reward (+50% bonus).

### 3.3 Funding

- $500k committed pre-launch, escrowed.
- Replenished from any post-launch revenue or grant inflows.
- If critical is paid, pause launch until replacement funds sourced.

---

## 4. Launch ramp

### 4.1 Phases

**Phase 0 — Devnet alpha (Track B).** Hackathon demo. Unaudited. No mainnet.

**Phase 1 — Mainnet private alpha.** After audit sign-off + ceremony complete.
- Whitelisted depositors only.
- Per-user cap: $10k/day, $50k total.
- Overall pool cap: $250k TVL.
- Duration: 2 weeks, adjustable.
- Pause button engaged, unpause on clean metrics.

**Phase 2 — Mainnet public alpha.** Caps lifted incrementally:
- Per-user cap: $100k/day, $500k total.
- Overall pool cap: $5M TVL.
- Duration: 4 weeks.

**Phase 3 — Mainnet GA.**
- Caps removed.
- Admin pause retained for 12 months post-GA.

### 4.2 Gate criteria between phases

Phase 1 → 2:
- Zero P0 / P1 incidents.
- Adapter failure rates <5% per operation.
- Relayer uptime >99.5%.
- At least 30 distinct external users.

Phase 2 → 3:
- 4 weeks incident-free.
- Caps monotonically increased without stress.
- External audit of any post-launch changes.

### 4.3 Caps enforcement

Caps enforced at the **relayer** level (soft enforcement). Pool itself does not enforce caps — enforcing on-chain would require per-user state, contradicting privacy. Relayers voluntarily reject over-cap transactions.

A user paying their own SOL and self-submitting can bypass caps — accepted trade-off, matches Railgun. During phased launch, third-party relayers advised to adopt same caps; primary b402 relayer enforces.

---

## 5. Incident response

### 5.1 Severity classification

- **P0:** active fund loss or imminent. Shutdown shields; unshields remain open.
- **P1:** security flaw identified, not exploited. Pause shields; unshields remain open.
- **P2:** operational issue; relayer down, RPC issue. Failover and notify.
- **P3:** minor bug, no user impact.

### 5.2 On-call rotation

- 24/7 rotation across b402 core contributors, 1-hour response SLA for P0/P1.
- Escalation path: on-call → protocol lead → multisig signers.

### 5.3 Runbooks

Per-scenario playbooks in `ops/runbooks/`:

- `shield-pause.md` — how to execute pause, verify on-chain, announce publicly.
- `adapter-disable.md` — disable a specific adapter.
- `relayer-failover.md` — spin up secondary region.
- `trusted-setup-compromise.md` — if a ceremony contributor reveals they retained toxic waste post-launch.
- `verifier-bug.md` — pool compromised by verifier bug. Recovery plan: tree + nullifier state archived; users given viewing keys to recover positions via separate disclose-and-withdraw mechanism.

### 5.4 Public comms

- **Status page:** `status.b402.ai` or equivalent.
- **Incident template:** what happened, what's paused, what's safe, ETA for resolution.
- **Post-mortems:** published for every P0 / P1 within 7 days.

---

## 6. Legal and compliance

### 6.1 Pre-launch review

- Legal review of protocol design for the b402 operating jurisdiction.
- Review of relayer terms of service.
- Disclosures baked into SDK docs and frontend (if any).

### 6.2 Posture

Permissionless protocol. Not a money transmitter in the protocol sense — we don't custody, don't clear, don't settle. Relayers as service providers may have jurisdictional obligations; b402-operated relayers follow them.

### 6.3 Sanctions

No on-chain sanctions screening (PRD-01 §10). Relayer operators may choose to screen destination addresses per their jurisdictions; SDK informs users of which relayer they selected.

### 6.4 Tax / reporting

User-sovereign disclosure tools (viewing keys + disclosure circuit) give users the ability to generate audit-ready statements. Not mandatory, not enforced.

---

## 7. Ongoing operations

### 7.1 Monitoring

Dashboards:
- TVL per token.
- Commitment count (anonymity set proxy).
- Tx success rate per instruction.
- Adapter failure rates.
- Relayer latency.
- Proof-gen latency (SDK-reported).
- CU usage per instruction type.
- Alerts on anomalies (sudden TVL change, nullifier-set growth spike, root-advancement stall).

### 7.2 Relayer operations

- Two regions minimum (e.g., us-central, europe-west on GCP Cloud Run — same stack as EVM relayers).
- IPv4 first setting per memory note about RPC hardening.
- `--no-cpu-throttling --cpu-boost` as per memory note about ZK proofs.

### 7.3 Admin multisig operations

- 5 signers, 3-of-5 threshold for all admin actions.
- Hardware wallets mandatory for signers.
- Quarterly drills: queue + cancel + activate fake upgrades.
- Signer rotation SOP documented.

### 7.4 Revocation of upgrade authority

- 12-month calendar marker pre-set.
- Multisig signs a `revoke_upgrade_authority` instruction at T+12mo.
- Irreversible.
- Public announcement + independent verification post-revocation.

---

## 8. Track A vs. Track B boundary

| Item | Track A (production) | Track B (hackathon prototype) |
|---|---|---|
| Audits | Full (Veridise + Accretion + Zellic) | None |
| Trusted setup | Full 3+ contributor ceremony | Throwaway solo ceremony |
| Admin multisig | 5-signer hardware wallets | Single dev key |
| Bug bounty | $500k + Immunefi | None |
| Mainnet deployment | Yes | **No** |
| Deposit caps | Phased | N/A |
| Scope | Full: Jupiter, Kamino, Drift, Orca | Jupiter only |
| Tokens | USDC, SOL + more via admin | USDC + SOL only |
| Relayer | Multi-region, HA | Dev single-instance |
| Compliance review | Complete | Disclaimer in README |
| Incident response | 24/7 on-call | Best effort |
| Coverage | ≥95% circuits, ≥85% SDK | Core paths only |

Track B code is **prototype-labeled and devnet-only**. Track A is a **clean rewrite** against the same PRDs, informed by Track B lessons.

---

## 9. Mainnet launch checklist

Not to be marked complete until every item signs off. Auditors + protocol lead + legal all required.

- [ ] All PRDs signed off and version-frozen.
- [ ] Circuits frozen, R1CS snapshot published.
- [ ] Trusted setup ceremony complete, archive published.
- [ ] VK hashes embedded in verifier program.
- [ ] All audits complete with all high/medium findings resolved.
- [ ] Formal verification of transact circuit signed off.
- [ ] Bug bounty live on Immunefi.
- [ ] Incident runbooks complete.
- [ ] Admin multisig configured, drills complete.
- [ ] Relayer multi-region deployed and monitored.
- [ ] Status page live.
- [ ] SDK released with pinned VK + program IDs.
- [ ] MCP tools updated.
- [ ] Legal sign-off.
- [ ] Deposit caps + kill switches verified on devnet.
- [ ] Launch announcement reviewed.

---

## 10. Open questions

1. **Which specific version of `groth16-solana` do we depend on, and who audited it.** Verify prior audit reports; confirm version not in scope of any open issues.
2. **Do we participate in or require a second Phase-2 ceremony post-GA to add further contributors?** Tentative: yes if GA activity warrants. Requires a new VK and a migration.
3. **Do we publish a formal threat-model document independent of PRD-01 §3?** Yes — auditors often prefer standalone.
4. **Compliance-mode relayer option.** Third parties may want to run screened relayers; do we ship a reference screened-relayer module? Tentative: yes, as a separate optional package.
5. **EF ESP grant coordination.** Office Hours applied 2026-04-19. Coordinate disclosure / funding alignment with Kohaku adapter.

---

## 11. Revision history

| Version | Date | Author | Changes |
|---|---|---|---|
| 0.1 | 2026-04-23 | b402 core | Initial draft |

---

## 12. Sign-off

| Role | Name | Date | Status |
|---|---|---|---|
| Protocol lead | | | |
| Security lead | | | |
| Legal | | | |
| Ops lead | | | |
| Final approval | | | |
