/**
 * Canonical protocol constants. MUST match `packages/crypto` (Rust) and
 * `programs/b402-pool/src/constants.rs` bit-for-bit.
 */

/** BN254 scalar field modulus. */
export const FR_MODULUS: bigint =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export const TREE_DEPTH = 26 as const;
export const ROOT_HISTORY_SIZE = 64 as const;

export const DomainTags = {
  commit:         'b402/v1/commit',
  nullifier:      'b402/v1/null',
  mkNode:         'b402/v1/mk-node',
  mkZero:         'b402/v1/mk-zero',
  noteEncKey:     'b402/v1/note-enc-key',
  spendKey:       'b402/v1/spend-key',
  spendKeyPub:    'b402/v1/spend-key-pub',
  viewKey:        'b402/v1/view-key',
  viewTag:        'b402/v1/viewtag',
  feeBind:        'b402/v1/fee-bind',
  rootBind:       'b402/v1/root-bind',
  adaptBind:      'b402/v1/adapt-bind',
  disclose:       'b402/v1/disclose',
  recipientBind:  'b402/v1/recipient-bind',
  // Phase 9 dual-note: domain-separates the deterministic random_b
  // derivation `Poseidon(commitment_a, TAG_EXCESS)`. Used by SDK +
  // pool program to mirror each other exactly.
  excess:         'b402/v1/excess',
  pqIntent:       'b402/v1/pq-intent',
  pqIntentReq:    'b402/v1/pq-intent-req',
  pqIntentRoute:  'b402/v1/pq-intent-route',
  pqAuthKey:      'b402/v1/pq-auth-key',
  pqIntentJson:   'b402/v1/pq-intent-json',
} as const;

export type DomainTagName = keyof typeof DomainTags;

/**
 * Devnet-deployed program IDs (also used as the default for mainnet alpha
 * since the same program keypairs are used). See ops/mainnet-deploy.sh.
 */
export const PROGRAM_IDS = {
  b402Pool:               '42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y',
  b402VerifierTransact:   'Afjbnv2Ekxa98jjRw33xPPhZabevek2uZxoE75kr6ZrK',
  b402VerifierAdapt:      '3Y2tyhNSaUiW5AcZcmFGRyTMdnroxHxc5GqFQPcMTZae',
  b402JupiterAdapter:     '3RHRcbinCmcj8JPBfVxb9FW76oh4r8y21aSx4JFy3yx7',
  b402KaminoAdapter:      '2enwFgcGKJDqruHpCtvmhtxe3DYcV3k72VTvoGcdt2rX',
  b402MockAdapter:        '89kw33YDcbXfiayVNauz599LaDm51EuU8amWydpjYKgp',
} as const;

export const JUPITER_V6_PROGRAM_ID = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

/**
 * b402 Address Lookup Table — compresses stable high-frequency accounts
 * (programs, protocol PDAs, common mints, adapter scratch ATAs) from 32 B to
 * 1 B in every `adapt_execute` tx. Required to fit Jupiter routes under
 * Solana's 1,232 B tx-size cap. See PRD-04 §5.2 and ops/alt/README.md.
 *
 * Regenerate with `pnpm --filter=@b402ai/solana-examples alt create`.
 */
export const B402_ALT_DEVNET = '9FPYufa1KDkrn1VgfjkR7R667hbnTA7CNtmy38QcsuNj';
export const B402_ALT_MAINNET = '3TSPLsa8aM5Xg9n8EHMuV5SK85RuMP96veFjv4BVrK9f' as const;

/** Known mainnet mints we ship support for in v1. */
export const MAINNET_MINTS = {
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  WSOL: 'So11111111111111111111111111111111111111112',
} as const;

/** PDA seed prefixes matching `programs/b402-pool/src/constants.rs`. */
export const PDA_SEEDS = {
  version:    new Uint8Array([0x62, 0x34, 0x30, 0x32, 0x2f, 0x76, 0x31]), // "b402/v1"
  config:     new TextEncoder().encode('config'),
  token:      new TextEncoder().encode('token'),
  vault:      new TextEncoder().encode('vault'),
  tree:       new TextEncoder().encode('tree'),
  nullifier:  new TextEncoder().encode('null'),
  adapters:   new TextEncoder().encode('adapters'),
  treasury:   new TextEncoder().encode('treasury'),
} as const;

/** Public-input count for the transact circuit verifier (includes domain tags + recipient bind). */
export const TRANSACT_PUBLIC_INPUT_COUNT = 18 as const;

/**
 * Canonical order of public inputs for the transact circuit verifier.
 *
 * SOURCE OF TRUTH for SDK + tests + indexers. The on-chain pool program
 * (`programs/b402-pool/src/instructions/{shield,transact,unshield}.rs`)
 * pushes inputs in this exact order, and the circuit's `component main {
 * public [...] }` enumerates them in this exact order (see
 * `circuits/transact.circom`).
 *
 * Drift between this constant and any of those three sources will silently
 * fail every proof — the verifier rejects a permutation as a tampered proof.
 *
 * Indexes are 0-based.
 */
export const TRANSACT_PUBLIC_INPUT_ORDER = [
  'merkleRoot',           // 0
  'nullifier0',           // 1
  'nullifier1',           // 2
  'commitmentOut0',       // 3
  'commitmentOut1',       // 4
  'publicAmountIn',       // 5  (u64 LE in low 8 bytes of 32B)
  'publicAmountOut',      // 6  (u64 LE in low 8 bytes of 32B)
  'publicTokenMint',      // 7  (32B raw Pubkey)
  'relayerFee',           // 8  (u64 LE in low 8 bytes of 32B)
  'relayerFeeBind',       // 9
  'rootBind',             // 10
  'recipientBind',        // 11
  'commitTag',            // 12
  'nullTag',              // 13
  'mkNodeTag',            // 14
  'spendKeyPubTag',       // 15
  'feeBindTag',           // 16
  'recipientBindTag',     // 17
] as const;

export type TransactPublicInputName = typeof TRANSACT_PUBLIC_INPUT_ORDER[number];

/** Lookup the index of a public input by name. Throws on unknown name. */
export function publicInputIndex(name: TransactPublicInputName): number {
  const idx = TRANSACT_PUBLIC_INPUT_ORDER.indexOf(name);
  if (idx < 0) throw new Error(`unknown public input ${name}`);
  return idx;
}
