# Security policy

## Disclosure

Security issues — please email **security@b402.ai** with subject `[b402-solana
security]`. We respond within 72 hours.

If you don't hear back, escalate to the founder direct contact in the GitHub
profile (open issue with `[ESCALATION]` in the title — please do **not**
disclose the substance of the issue in a public issue).

PGP key: see [keys.b402.ai](https://keys.b402.ai) (fingerprint published in the
team-keys repository — pinned in this repo's commit history).

## Scope

In scope for security disclosure:

- All crates under `programs/` and `packages/` on `main` branch
- All circuits under `circuits/` on `main`
- The relayer service at `packages/relayer/`
- Devnet-deployed program IDs listed in [README.md](./README.md#devnet-deployment)

Out of scope:

- The `phase-3-abi-v2` branch (work-in-progress, not deployed)
- Code in `docs/prds/` that is unimplemented (PRDs are specs, not code)
- Mainnet deployments — no mainnet pool exists yet at the time of this
  document; once it does, this section will be updated
- DoS attacks against the relayer (use rate limits + Cloudflare in front)
- Issues requiring physical access to infrastructure

## What we consider critical

Severity tiers, in descending order:

1. **Critical** — direct theft of funds from the pool, double-spend of a
   nullifier, forging a Groth16 proof against any of the deployed verifiers,
   bypassing the per-instruction-discriminator allowlist on adapters.
2. **High** — bypassing the post-CPI delta invariant (adapter return
   forgery), draining adapter scratch ATAs, denial-of-service that
   permanently locks user funds.
3. **Medium** — temporarily blocking shield/unshield/transact/adapt, leaking
   information that strengthens pool-level clustering analysis beyond
   the documented Layer 3 baseline.
4. **Low** — gas/CU regressions, off-chain SDK / relayer issues that don't
   affect on-chain correctness.

## What we will NOT pursue legally

We will not pursue legal action against good-faith security researchers who:

- Report findings via the disclosure channel above
- Don't access user funds beyond what's necessary to prove the issue
- Don't disclose publicly before we've had reasonable time to fix
  (default 90 days; we'll negotiate if more time is needed)
- Don't sell findings or use them to harm users

This is a soft DMCA-style safe harbor. If you operate from a jurisdiction
where this needs to be more formal, email us and we'll execute a written
agreement.

## Bug bounty

A formal bounty program (Immunefi-hosted or self-hosted) is on the roadmap
before mainnet TVL grows beyond the initial alpha cap. Until then,
disclosed-and-fixed issues with novel impact will receive ad-hoc rewards
from the project at the team's discretion.

## OFAC + sanctions posture

The b402 protocol code is open-source code. The deployed pool program is
non-custodial — no operator can move user funds. Our reference relayer
(`packages/relayer/`) screens against the OFAC SDN list and geo-blocks
sanctioned jurisdictions. Operators of derivative deployments are responsible
for their own sanctions compliance.
