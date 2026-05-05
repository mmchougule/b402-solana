---
name: weather-private
title: "Private Weather (b402)"
description: "x402-gated weather endpoint backed by the b402 shielded pool on Solana. Each USDC payment auto-shields into a private note; the operator unshields to any wallet with no on-chain link from the receivable to the spend."
use_case: "Use for testing privacy-preserving x402 payment flows on Solana, or as a reference when adding the b402 paysh-shield to your own x402 server. Returns a JSON weather payload per paid call."
category: devtools
service_url: https://<deploy-host>
openapi:
  url: https://<deploy-host>/openapi.json
---

Reference x402 provider that shields every receivable through the b402-solana pool. Useful as a working integration target for x402 clients and as a copy-paste template for adding the shield to an existing server.

## How it works

The 402 challenge advertises `payTo = <operator-wallet>`. Every USDC transfer that lands at the operator's USDC ATA is detected by an off-chain watcher and converted into a shielded note in the b402-solana pool through a Groth16 proof + Merkle-tree append. The operator unshields to a fresh address whenever they want — there is no on-chain edge from the receivable to that spend.

Source and library: https://github.com/mmchougule/b402-solana/tree/main/packages/paysh-shield

## Endpoints

- `GET /weather/{city}` — JSON weather payload. Priced at 0.001 USDC per call. No free tier.

## Payer experience

Identical to any x402 endpoint. Use any standard x402 client (`pay curl`, `@coinbase/x402`, etc.). The receiver's privacy mechanism is invisible to the payer.

## Notes for agents

- The published `payTo` is a long-lived ingress controlled by the demo operator. Do not attempt to re-derive it; use whatever the live 402 challenge returns.
- One paid call returns one weather payload. There is no batch endpoint.

## Service URL

The `<deploy-host>` placeholder is replaced with the live Railway hostname before submission to `solana-foundation/pay-skills`.
