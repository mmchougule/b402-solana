# PRD-16 — Adrena Adapter (first adapter on the new ABI)

| Field | Value |
|---|---|
| **Status** | Draft — awaiting review |
| **Owner** | b402 core |
| **Date** | 2026-04-26 |
| **Version** | 0.1 |
| **Depends on** | PRD-11, PRD-12, PRD-13, PRD-15 |
| **Supersedes** | PRD-10 §3 (Drift remains canonical perps spec, deferred post-reboot/audit) |

---

## 1. Goal

Ship private perpetuals on Solana via [Adrena](https://www.adrena.xyz/) — fully on-chain, synchronous-fill, no-keeper, GPL-3.0 source-available, ~$50M TVL. Validates the new ABI (PRD-11–15) against a real protocol before Kamino lands.

---

## 2. Why Adrena (not Jupiter Perps, not Drift)

- **Jupiter Perps** is a request-queue + keeper model. Requires PRD-14 two-phase. Defer to v2 perps wave.
- **Drift v2** ate a $285M exploit on April 1 2026 (DPRK durable-nonce admin takeover, fake CVT collateral). Tether-led rescue closed April 16; full reboot pending fresh audits. Program ID will likely change post-reboot. Integrating against pre-reboot bytecode is wasted work.
- **Adrena** is operational, audited (Ottersec — one audit shipped, second in progress per Adrena docs), source-available under GPL-3.0 (`AdrenaFoundation/adrena-program`), synchronous, no keeper, $50M+ TVL, exactly the ABI shape PRD-11 + PRD-15 already cover. Adrena's docs explicitly reject the request-queue / keeper model in favor of synchronous CPI fills, which matches our v2 sync-only constraint cleanly.

### 2.1 Licensing note

Adrena is GPL-3.0 (not MIT). GPL governs distribution of derivative works of the source. b402's adapter program **does not link to or redistribute Adrena's source** — it issues CPIs to the deployed Adrena program by program ID. Runtime CPI is not a derivative work under GPL-3.0, so Adrena's license has no impact on b402's licensing or distribution. The adapter itself ships under b402's chosen license.

### 2.2 Audit posture

Ottersec is a reputable Solana security firm with prior coverage of Jito, Marinade, and other Solana DeFi staples. One Ottersec audit of Adrena has shipped; a second is in progress per Adrena's published roadmap. We treat Adrena's audit posture as **acceptable for v2-launch integration**, not as a substitute for our own adapter audit. The b402 Adrena adapter ships through the same audit pipeline as every other adapter (PRD-08).

---

## 3. Operations supported in v1

| Op | Inputs | Outputs | State | Notes |
|---|---|---|---|---|
| `OpenPosition` | `[(USDC, collateral)]` | `[]` | Position PDA | Delta-zero out; collateral in; position created |
| `IncreasePosition` | `[(USDC, additional)]` | `[]` | Position PDA | Mutates existing |
| `DecreasePosition` | `[]` | `[(USDC, settlement_min)]` | Position PDA | Partial close |
| `ClosePosition` | `[]` | `[(USDC, settlement_min)]` | Position PDA → closed | Full close |
| `LiquidatePosition` | n/a | n/a | n/a | b402 doesn't expose; Adrena's own liquidator handles |

---

## 4. Shadow PDA pattern

```
shadow_pda = PDA([
    "b402-shadow",
    ADRENA_PROGRAM_ID,
    b"adrena:position:v1",
    viewing_key_commitment,
])
```

Per PRD-13. The shadow PDA *is* the Adrena Position PDA — Adrena's own program owns it.

---

## 5. Action payload

```rust
pub enum AdrenaAction {
    Open { market: Pubkey, side: Side, leverage_bp: u16, collateral: u64 },
    Increase { collateral: u64 },
    Decrease { size_to_close: u64, min_out: u64 },
    Close { min_out: u64 },
}
```

`action_hash` per PRD-12 is computed over the serialized `AdrenaAction` plus the canonicalized accounts list. Adapter program at execution decodes the payload and constructs the Adrena CPI.

---

## 6. Validation

Implement against an Adrena-mainnet-fork local validator (same pattern as `swap-e2e-jupiter.ts`):
1. Boot test validator with Adrena programs cloned from mainnet.
2. Open position with $1k USDC collateral, 5x leverage long SOL.
3. Wait one slot, increase by $500.
4. Decrease by half.
5. Close.
6. Verify final settlement equals expected (within slippage).

CU budget projection: ~250k for Adrena CPI + 16k for adapter overhead + 325k for pool's existing handler = **591k total**. Under cap.

---

## 7. Hard vs soft

**Hard:**
- Adapter scope_tag: `adrena:position:v1`.
- v1 covers SOL-PERP and ETH-PERP markets only (Adrena's most liquid). Other markets via parameter.

**Soft:**
- Specific Adrena program ID — read at deploy time, registered in adapter registry.
- Position-account rent payment policy (relayer-funded by default).

---

## 8. Open questions

1. Adrena's ALP (LP) token: support direct LP via this adapter, or split into a separate adapter? Tentative: separate — `adrena-lp` scope, future PRD.
2. Funding rate accrual: Adrena settles funding lazily on position interactions. Does b402 surface accrued funding to the user pre-close? Tentative: yes — read-only RPC method on the adapter SDK.

---

## 9. Revision history

| Version | Date | Author | Changes |
|---|---|---|---|
| 0.1 | 2026-04-26 | b402 core | Initial draft. Adrena license corrected from MIT to GPL-3.0 (verified against `AdrenaFoundation/adrena-program`); audit attribution corrected from Halborn + Trail of Bits to Ottersec (one shipped, second in progress per Adrena docs). Conclusion (Adrena = right v1 perps target) unchanged. |

---

## 10. Sign-off

| Role | Name | Date | Status |
|---|---|---|---|
| Protocol lead | | | |
| Adapter lead | | | |
| Circuit lead | | | |
| Final approval | | | |
