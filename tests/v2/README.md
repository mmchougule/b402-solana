# v2 — Light Protocol IMT integration tests

Tests gating PRD-30 implementation. Phased per PRD §5.

## Layout

```
tests/v2/
  integration/         Phase 0 — Light fixture + Photon
    light_protocol_localnet.test.ts
    photon_indexer.test.ts
  e2e/                 Phase 5/6c — full shield/unshield + adapter flows
    v2_localnet_stress.test.ts
    v2_fork_swap.test.ts
    v2_fork_lend.test.ts
```

Phase 1 (`b402_nullifier` program tests) lives in `programs/b402-nullifier/tests/`.
Phase 2 (pool integration tests) lives in `programs/b402-pool/tests/onchain/`.
Phase 3 (circuit-unchanged verification) lives in `circuits/transact/test/`.
Phase 4 (SDK + Photon) lives in `packages/sdk/src/__tests__/`.

## Pre-req setup (one-time)

```bash
# Light CLI (validator + programs + photon orchestrator)
npm install -g @lightprotocol/zk-compression-cli@0.28.0-beta.5

# Photon indexer (Rust binary, ~5min compile)
cargo install --git https://github.com/lightprotocol/photon.git \
  --rev ac7df6c388db847b7693a7a1cb766a7c9d7809b5 --locked --force
```

## Running

```bash
# Boot Light test-validator + Photon (in one terminal)
light test-validator

# Run Phase 0 tests against it (in another terminal)
pnpm --filter='@b402ai/solana-v2-tests' test tests/v2/integration/

# Tear down
pkill -f "light test-validator"
```

## Notes

- All Phase 0-4 tests run against the Light test-validator. No real SOL spent.
- Phase 5 e2e against a mainnet-fork validator (Light's mainnet bytecode cloned, fresh test wallets).
- Phase 6 mainnet deploy is gated by the Phase 5 acceptance threshold (per-unshield gas ≤ 25,000 lamports).
