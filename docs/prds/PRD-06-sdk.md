# PRD-06 — TypeScript SDK (`@b402ai/solana`)

| Field | Value |
|---|---|
| **Status** | Draft — awaiting review |
| **Owner** | b402 core |
| **Date** | 2026-04-23 |
| **Version** | 0.1 |
| **Depends on** | PRD-02, 03, 04, 05 |
| **Gates** | SDK implementation, MCP integration |

The SDK is the surface every agent, wallet, and app will touch. It must (a) match the EVM SDK's API shape so multi-chain users have one mental model, (b) hide all ZK/Solana machinery behind the same methods, and (c) be MCP-tool-friendly so every operation maps to a single structured call.

---

## 1. Public API

### 1.1 Construction

```typescript
import { B402Solana } from '@b402ai/solana';

const b402 = new B402Solana({
  cluster: 'mainnet' | 'devnet',
  rpcUrl?: string,            // Helius / Triton preferred; falls back to cluster default
  seed?: Uint8Array,          // 32 B — derives spending + viewing keys
  keypair?: Keypair,          // alternative to seed, for Solana Kit interop
  relayerUrl?: string,        // default: b402 operator; user can override
  relayerFeeBps?: number,     // max tolerated, SDK rejects if relayer quote exceeds
});
```

One of `seed` or `keypair` must be provided. If `keypair`, SDK derives a deterministic b402 seed from the keypair via a domain-tagged hash (spec in PRD-02 §2).

### 1.2 Methods (parity with `@b402ai/sdk`)

All methods are async, return a typed `Result<T, B402Error>`.

```typescript
// Core privacy ops
b402.shield({ token: 'USDC' | 'SOL' | Pubkey, amount: string | bigint }): Promise<ShieldResult>
b402.unshield({ token, amount, recipient: Pubkey }): Promise<UnshieldResult>
b402.transfer({ token, amount, recipientSpendingPub: string }): Promise<TransferResult>

// DeFi composability
b402.privateSwap({ from, to, amount, slippageBps?: number }): Promise<SwapResult>
b402.privateLend({ token, amount, vault: 'kamino-main' }): Promise<LendResult>
b402.privateRedeem({ vault }): Promise<RedeemResult>
b402.privateLP({ pool, amountA, amountB, tickLower, tickUpper }): Promise<LPResult>
b402.privateRemoveLP({ positionNft }): Promise<LPResult>
b402.privatePerpOpen({ market, direction, size, margin, priceLimit }): Promise<PerpResult>
b402.privatePerpClose({ positionReceipt }): Promise<PerpResult>

// Status + wallet
b402.status(): Promise<StatusResult>              // shielded balances, open positions, anonymity set
b402.consolidate({ token }): Promise<ConsolidateResult>
b402.scanNotes({ since?: slot }): Promise<number> // returns newly-discovered note count

// Disclosure (opt-in)
b402.exportViewingKey({ scope: 'all' | 'note', noteCommitment?: string }): string
b402.generateDisclosureProof({ commitments: string[] }): Promise<DisclosureProof>
```

### 1.3 Unified multi-chain (optional)

`@b402ai/sdk` grows a `chain` parameter that dispatches to the right adapter:

```typescript
import { B402 } from '@b402ai/sdk'; // unified

const b402 = new B402({ chain: 'solana', seed, rpcUrl });
// All the above methods work, identical signature.
```

Under the hood, `@b402ai/sdk` depends on `@b402ai/solana` (optional peer dep) and wires dispatch.

---

## 2. Internal architecture

```
┌─────────────────────────────────────────────────────────┐
│ Public API (B402Solana class)                           │
└──────────────────────┬──────────────────────────────────┘
                       │
      ┌────────────────┼─────────────────────┐
      ▼                ▼                     ▼
┌───────────┐   ┌─────────────┐     ┌────────────────┐
│ Wallet    │   │ Note Store  │     │ Action Builder │
│ (keys)    │   │ (scanner,   │     │ (intents →     │
│           │   │ local cache)│     │ public-inputs) │
└─────┬─────┘   └──────┬──────┘     └───────┬────────┘
      │                │                    │
      └────────────────┼────────────────────┘
                       ▼
             ┌──────────────────┐
             │ Prover (WASM)    │  @b402ai/solana-prover
             │ - Circom witness │
             │ - Groth16 proof  │
             └────────┬─────────┘
                      │
                      ▼
             ┌──────────────────┐
             │ Tx Builder       │
             │ - Anchor instrs  │
             │ - ALT lookup     │
             │ - SetCuLimit     │
             └────────┬─────────┘
                      │
        ┌─────────────┴────────────┐
        ▼                          ▼
┌──────────────┐           ┌──────────────┐
│ Self-submit  │           │ Relayer HTTP │
│ (user pays)  │           │ (gasless)    │
└──────────────┘           └──────────────┘
```

### 2.1 Wallet module

- **Seed derivation:** user seed (32 B) → spending private key (BN254 Fr) + viewing private key (X25519 scalar), per PRD-02 §2.
- **Ephemeral keys:** fresh X25519 scalar per outgoing note.
- **No persistent storage required.** All state is recoverable from Solana RPC replay. Optional local cache for scan speed.

### 2.2 Note store

- **Logical view:** list of `SpendableNote` objects.
- **Backing:** in-memory + optional IndexedDB / filesystem cache.
- **Refresh:** watches Solana for `CommitmentAppended` events (via WebSocket or polling), runs scan algorithm (PRD-02 §4.3), decrypts own notes, and indexes.
- **Cache invalidation:** a `NullifierSpent` event for one of our notes removes it from the spendable set.

### 2.3 Action builder

Given a high-level intent (`shield 10 USDC`), produces:

1. Selected input notes (if any).
2. Output notes (derived amounts + random blinding + encryption).
3. Public inputs for the circuit.
4. Private inputs (witness).
5. Adapter payload (for adapt operations).

Handles:
- Note selection (greedy match, minimize fragmentation).
- Auto-consolidation when input count > 2 (chain of transact calls).
- Relayer fee quoting.
- Fresh `merkle_root` fetching.

### 2.4 Prover

- **Package:** `@b402ai/solana-prover`, separate from the main SDK to allow dynamic loading (prover is ~5 MB WASM).
- **Circom → WASM:** witness generation compiled via `circom --wasm`.
- **Proof generation:** `snarkjs` groth16 prove, or `rapidsnark-wasm` for ~3× speedup.
- **Target:** <2 s transact proof on 8-core desktop.
- **Streaming:** emits progress events (witness_start, witness_done, proof_start, proof_done).

### 2.5 Tx builder

- Constructs Anchor instructions per PRD-03.
- Includes `SetComputeUnitLimit` + `SetComputeUnitPrice` per operation.
- Uses b402 ALT (Address Lookup Table) for account budget.
- Prepares `VersionedTransaction`.
- For gasless: serializes, sends to relayer. For self-submit: signs locally, submits via `sendTransaction`.

### 2.6 Relayer client

- HTTP POST `/v1/relay/submit` with body: `{ tx_bytes, metadata }`.
- Response: `{ signature, status, error? }`.
- SDK retries with backoff; falls back to self-submit if no relayer reachable and user's wallet has SOL.

---

## 3. Error taxonomy

```typescript
class B402Error extends Error {
  code: B402ErrorCode;
  chain: 'solana' | 'base' | 'arb' | 'bsc';
  details: Record<string, unknown>;
}

enum B402ErrorCode {
  // Wallet / keys
  InvalidSeed              = 'INVALID_SEED',
  NoSpendableNotes         = 'NO_SPENDABLE_NOTES',

  // Proof
  ProofGenerationFailed    = 'PROOF_GEN_FAILED',
  WitnessGenerationFailed  = 'WITNESS_GEN_FAILED',

  // On-chain
  TokenNotWhitelisted      = 'TOKEN_NOT_WHITELISTED',
  NullifierAlreadySpent    = 'NULLIFIER_SPENT',
  RootExpired              = 'ROOT_EXPIRED',
  ProofVerifyFailed        = 'PROOF_VERIFY_FAILED',
  SlippageExceeded         = 'SLIPPAGE_EXCEEDED',
  AdapterFailed            = 'ADAPTER_FAILED',

  // Network / relayer
  RelayerUnreachable       = 'RELAYER_UNREACHABLE',
  RpcError                 = 'RPC_ERROR',
  TxTimeout                = 'TX_TIMEOUT',

  // Fees
  RelayerFeeTooHigh        = 'RELAYER_FEE_TOO_HIGH',
  InsufficientBalance      = 'INSUFFICIENT_BALANCE',

  // Validation
  InvalidRecipient         = 'INVALID_RECIPIENT',
  AmountOutOfRange         = 'AMOUNT_OUT_OF_RANGE',
}
```

Errors are structured for MCP consumption — agents can branch on `code`.

---

## 4. Progress events

Long-running operations emit progress via `EventEmitter`:

```typescript
b402.on('progress', (event: ProgressEvent) => {});

type ProgressEvent =
  | { kind: 'note-scan', progress: number }
  | { kind: 'witness-gen', progress: number }
  | { kind: 'proof-gen', progress: number }
  | { kind: 'tx-submit', signature?: string }
  | { kind: 'tx-confirmed', signature: string };
```

UIs and agents display/log progress; MCP tool exposes the final state only.

---

## 5. Status result

```typescript
type StatusResult = {
  chain: 'solana';
  cluster: 'mainnet' | 'devnet';
  wallet: {
    spendingPub: string;
    viewingPub: string;
  };
  balances: Array<{
    token: string;
    mint: string;
    amount: string;
    noteCount: number;
  }>;
  positions: {
    drift: Array<{ market: string; direction: 'long'|'short'; size: string; margin: string; receiptCommitment: string }>;
    orca: Array<{ whirlpool: string; tickLower: number; tickUpper: number; liquidity: string; positionNftMint: string }>;
    kamino: Array<{ market: string; sharesToken: string; sharesAmount: string }>;
  };
  anonymitySet: Record<string /* mint */, number>;  // commitment count per token
  lastScannedSlot: number;
};
```

---

## 6. MCP tool mapping

Each SDK method gets one MCP tool in `b402-mcp`. Tool names mirror methods:

```
b402_shield(chain, token, amount)
b402_unshield(chain, token, amount, recipient)
b402_transfer(chain, token, amount, recipient_pub)
b402_private_swap(chain, from, to, amount, slippage_bps?)
b402_private_lend(chain, token, amount, vault)
b402_private_redeem(chain, vault)
b402_private_lp(chain, pool, amount_a, amount_b, tick_lower, tick_upper)
b402_private_perp_open(chain, market, direction, size, margin, price_limit)
b402_private_perp_close(chain, position_receipt)
b402_status(chain)
b402_consolidate(chain, token)
b402_scan_notes(chain)
b402_export_viewing_key(chain, scope, note_commitment?)
```

`chain` parameter defaults to user's `B402_CHAIN` env var if unset. Agents can target `solana` explicitly.

Errors surfaced as structured `B402Error` objects; MCP envelope includes `code`, `chain`, `details` for deterministic agent handling.

---

## 7. Package structure

```
packages/
├── sdk/               @b402ai/solana
│   ├── src/
│   │   ├── b402.ts          // B402Solana class
│   │   ├── wallet.ts
│   │   ├── notes/
│   │   │   ├── store.ts
│   │   │   ├── scanner.ts
│   │   │   └── encryption.ts
│   │   ├── actions/
│   │   │   ├── shield.ts
│   │   │   ├── unshield.ts
│   │   │   ├── transact.ts
│   │   │   ├── adapt.ts
│   │   │   └── adapters/
│   │   │       ├── jupiter.ts
│   │   │       ├── kamino.ts
│   │   │       ├── drift.ts
│   │   │       └── orca.ts
│   │   ├── tx/
│   │   │   ├── builder.ts
│   │   │   ├── alt.ts
│   │   │   └── relayer.ts
│   │   ├── poseidon.ts      // Rust-parity TS implementation (tested)
│   │   ├── merkle.ts
│   │   ├── errors.ts
│   │   └── index.ts
│   └── package.json
├── prover/            @b402ai/solana-prover
│   ├── src/
│   │   ├── transact.ts      // loads WASM, runs witness + proof
│   │   ├── adapt.ts
│   │   └── disclose.ts
│   ├── wasm/                // circom-generated .wasm + zkey
│   └── package.json
├── relayer/           b402-solana-relayer (Node service)
│   ├── src/
│   │   ├── server.ts
│   │   ├── submit.ts
│   │   └── quote.ts
│   └── package.json
└── shared/            @b402ai/solana-shared
    ├── src/
    │   ├── types.ts
    │   ├── constants.ts      // program IDs, ALT addresses, VK hashes
    │   └── encoding.ts
    └── package.json
```

---

## 8. Versioning

- SDK versions bumped on any public API change. Minor for additions, major for breaking changes.
- **Circuit version pinned to SDK major.** SDK version `1.x` uses verifier program version `1`; SDK version `2.x` uses a migration-aware verifier. No silent circuit changes within a major.
- Prover WASM and VK hash published in `@b402ai/solana-shared`. SDK at startup verifies VK hash matches on-chain VK (detects stale cached WASM or wrong cluster).

---

## 9. Testing hooks (see PRD-07)

- **Deterministic mode:** `B402Solana` takes optional `determinism: { randomSource: () => Uint8Array }` for reproducible tests.
- **Mock relayer:** testing utility that fakes relayer responses; used in unit tests.
- **Mainnet-fork mode:** SDK points at a local validator fork; integration tests exercise full flows.

---

## 10. Performance targets

| Operation | Target p50 | Target p95 |
|---|---|---|
| `shield` end-to-end (including proof) | 3 s | 5 s |
| `unshield` | 3 s | 5 s |
| `transact` | 3 s | 5 s |
| `privateSwap` (Jupiter 2-hop) | 5 s | 8 s |
| `privateLend` (Kamino) | 4 s | 7 s |
| Note scan, 10k commitments | 2 s | 4 s |
| `status` (cached) | 200 ms | 500 ms |

Targets measured in PRD-07 benchmarks. Miss → optimize before mainnet.

---

## 11. Open questions

1. **Note-store persistence format.** IndexedDB in browser, SQLite in Node. Schema decision for PRD-07.
2. **Multi-wallet support.** v1 is single-seed. Hierarchical wallets (per-app sub-accounts) v2.
3. **Solana Kit vs. web3.js.** Kit is newer, leaner. Prefer Kit for v1 SDK; confirm wallet adapter compat.
4. **Prover worker vs. main thread.** Browser: Web Worker mandatory (proving blocks event loop). Node: optional.
5. **Offline disclosure proof generation.** User may want to generate disclosure proofs from cold notes without network. Supported via prover package directly.

---

## 12. Revision history

| Version | Date | Author | Changes |
|---|---|---|---|
| 0.1 | 2026-04-23 | b402 core | Initial draft |

---

## 13. Sign-off

| Role | Name | Date | Status |
|---|---|---|---|
| SDK lead | | | |
| API review | | | |
| MCP maintainer | | | |
| Final approval | | | |
