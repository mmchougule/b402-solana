---
name: paysh-send
title: "paysh-send — private USDC transfers"
description: "Pay-per-use private USDC transfer over x402 on Solana. The payer sends (principal + fee) USDC, the recipient receives principal at a wallet that has no on-chain link to the payer. Routed through the b402 shielded pool."
use_case: "Use for sending USDC privately to any Solana wallet via a single x402 call. Useful for paying contractors, donations, B2B settlement, or any transfer where the payer should not appear on the recipient's wallet history."
category: finance
service_url: https://paysh-shield-production.up.railway.app
openapi:
  url: https://paysh-shield-production.up.railway.app/openapi.json
---

Private USDC transfer service. Pay (principal + fee) USDC via x402; recipient receives principal at the wallet you specify with no on-chain edge from payer to recipient.

## How it works

1. `POST /send` with `{ to, amount }` returns 402 with the total price (principal + fee) and operator's payTo.
2. Payer signs an SPL transfer of total to payTo, retries with `X-PAYMENT` header.
3. Server confirms the payment, then shields the principal into the b402 shielded pool, then unshields the principal to `to` via the b402 hosted relayer (so the operator's wallet does not appear on the spend tx).
4. Server returns `{ paymentSig, shieldSig, unshieldSig, recipient, principal, fee }`.

## Fee schedule

- 0.05 USDC base, plus
- 0.05% of principal for principal < $1k
- 0.08% for principal < $10k
- 0.10% for principal >= $10k

Min principal: 0.01 USDC. Max principal: 100,000 USDC per call.

## Endpoints

- `POST /send` — `{ to, amount }`. Priced per fee schedule. Returns 200 with all three signatures on success.

## Privacy properties

What this hides:
- The on-chain edge from `payer → recipient`. The recipient receives funds from the b402 pool's vault, signed by the b402 hosted relayer, not by the operator or payer.
- The amount of any subsequent shielded operations the operator performs.

What this does NOT hide:
- The `payer → operator` SPL transfer is a plain on-chain USDC transfer.
- The shield ix's public input includes the deposit amount.
- For real per-transfer privacy under chain analysis, you need an anonymity set: many users transferring through the pool concurrently, with random delays and amount-decorrelation. Single-user immediate transfers are timing-correlated despite the cryptographic break.

## Source

https://github.com/mmchougule/b402-solana/tree/main/packages/paysh-shield
