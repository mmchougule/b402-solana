/**
 * Percolator-specific helpers for `B402Solana.privatePerpOpen`/`privatePerpClose`.
 *
 * The pool's `adapt_execute(_v2)` is generic — it forwards an opaque
 * `action_payload` and `remaining_accounts` block to the registered
 * adapter. These helpers build the percolator-shaped versions of both,
 * matching the layouts pinned in:
 *   - `programs/b402-percolator-adapter/src/payload.rs`
 *     (`PercolatorAction` Borsh enum + `encode_per_user_payload`)
 *   - `programs/b402-percolator-adapter/src/pda.rs` (PDA seeds)
 *   - `programs/b402-percolator-adapter/src/actions/open.rs::RA_*`
 *     (variadic `remaining_accounts` slot indexes — close shares them)
 *
 * Byte-level parity with the Rust encoder is asserted in
 * `__tests__/percolator.test.ts` against fixtures that match the Rust
 * test cases in `payload.rs::tests`.
 *
 * Per-user payload wire format (PRD-36 §5.3, mirrors PRD-33 §6.1):
 *   `[viewing_pub_hash: 32 B] [borsh(PercolatorAction)]`
 *
 * Borsh enum variants: 1-byte discriminant (declaration order) followed
 * by fields. Numeric fields are little-endian.
 */
import {
  PublicKey,
  type AccountMeta,
} from '@solana/web3.js';

const SEED_B402 = Buffer.from('b402/v1');
const SEED_ADAPTER = Buffer.from('adapter');
const SEED_PERP_OWNER = Buffer.from('perp-owner');
const SEED_PERP_MAPPING = Buffer.from('perp-mapping');

/** `PercolatorAction` Borsh discriminants. Stable wire format; never reorder. */
const TAG_OPEN_POSITION = 0;
const TAG_CLOSE_POSITION = 1;

/** `viewing_pub_hash` prefix length on stateful-adapter payloads. */
export const VIEWING_PUB_HASH_PREFIX_LEN = 32;

/** Pool's hard cap on `action_payload` length (mirrors `PAYLOAD_MAX_LEN`). */
export const PAYLOAD_MAX_LEN = 350;

/** `execute` ix discriminator — sha256("global:execute")[..8]. */
const EXECUTE_DISC = Uint8Array.from([130, 221, 242, 154, 13, 193, 189, 29]);

/** Per-deployment maximum slab account count (mirrors `PERCOLATOR_MAX_ACCOUNTS_DEFAULT`). */
export const PERCOLATOR_MAX_ACCOUNTS_DEFAULT = 1024;

function u16Le(v: number): Uint8Array {
  if (v < 0 || v > 0xffff || !Number.isInteger(v)) {
    throw new RangeError(`u16 out of range: ${v}`);
  }
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v, 0);
  return new Uint8Array(b);
}

function u64Le(v: bigint): Uint8Array {
  if (v < 0n || v > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError(`u64 out of range: ${v}`);
  }
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v, 0);
  return new Uint8Array(b);
}

const I128_MIN = -(1n << 127n);
const I128_MAX = (1n << 127n) - 1n;

function i128Le(v: bigint): Uint8Array {
  if (v < I128_MIN || v > I128_MAX) {
    throw new RangeError(`i128 out of range: ${v}`);
  }
  // Two's-complement little-endian 16-byte encoding.
  const mask = (1n << 128n) - 1n;
  const u = v < 0n ? (v + (1n << 128n)) & mask : v;
  const out = new Uint8Array(16);
  let x = u;
  for (let i = 0; i < 16; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Action payload encoders
// ─────────────────────────────────────────────────────────────────────

export interface PercolatorOpenArgs {
  lpIdx: number;
  sizeE6: bigint;
  limitPriceE6: bigint;
  /** Set to 0n if the slab slot is already claimed for this user. */
  feePaymentIfInit: bigint;
}

export interface PercolatorCloseArgs {
  lpIdx: number;
  limitPriceE6: bigint;
}

/**
 * `PercolatorAction::OpenPosition` Borsh-encoded.
 * Layout: `tag(1) | lp_idx(u16 LE) | size_e6(i128 LE) | limit_price_e6(u64 LE) | fee_payment_if_init(u64 LE)` = 35 bytes.
 */
export function buildPercolatorOpenActionPayload(args: PercolatorOpenArgs): Uint8Array {
  return concat(
    new Uint8Array([TAG_OPEN_POSITION]),
    u16Le(args.lpIdx),
    i128Le(args.sizeE6),
    u64Le(args.limitPriceE6),
    u64Le(args.feePaymentIfInit),
  );
}

/**
 * `PercolatorAction::ClosePosition` Borsh-encoded.
 * Layout: `tag(1) | lp_idx(u16 LE) | limit_price_e6(u64 LE)` = 11 bytes.
 */
export function buildPercolatorCloseActionPayload(args: PercolatorCloseArgs): Uint8Array {
  return concat(
    new Uint8Array([TAG_CLOSE_POSITION]),
    u16Le(args.lpIdx),
    u64Le(args.limitPriceE6),
  );
}

/**
 * Wrap a percolator action with the 32-byte `viewing_pub_hash` prefix
 * the pool prepends for stateful adapters (PRD-33 §6.1).
 *
 * The pool fills this prefix from `pi.out_spending_pub` (Phase-9 public
 * input). Callers must pass the same hash value the proof bound, or the
 * adapter's `owner_pda` derivation won't match the pool's signing seeds.
 */
export function buildPercolatorPerUserPayload(
  viewingPubHash: Uint8Array | Buffer,
  inner: Uint8Array,
): Uint8Array {
  if (viewingPubHash.length !== VIEWING_PUB_HASH_PREFIX_LEN) {
    throw new RangeError(
      `viewing_pub_hash must be ${VIEWING_PUB_HASH_PREFIX_LEN} bytes, got ${viewingPubHash.length}`,
    );
  }
  const total = VIEWING_PUB_HASH_PREFIX_LEN + inner.length;
  if (total > PAYLOAD_MAX_LEN) {
    throw new RangeError(`per-user payload exceeds ${PAYLOAD_MAX_LEN} B (got ${total})`);
  }
  return concat(new Uint8Array(viewingPubHash), inner);
}

/**
 * Wrap an `action_payload` in the adapter's `execute` ix data:
 * `disc(8) | in_amount(u64) | min_out(u64) | len(u32) | action_payload`.
 *
 * For privatePerpOpen, `inAmount = margin`, `expectedOut = 0` (open
 * doesn't emit USDC). For privatePerpClose, `inAmount = 0`,
 * `expectedOut = expected_capital_after_pnl_e6` (caller's slippage cap).
 */
export function buildPercolatorExecuteIxData(params: {
  inAmount: bigint;
  expectedOut: bigint;
  actionPayload: Uint8Array;
}): Uint8Array {
  const lenLe = Buffer.alloc(4);
  lenLe.writeUInt32LE(params.actionPayload.length, 0);
  return concat(
    EXECUTE_DISC,
    u64Le(params.inAmount),
    u64Le(params.expectedOut),
    new Uint8Array(lenLe),
    params.actionPayload,
  );
}

// ─────────────────────────────────────────────────────────────────────
// PDA derivations
// ─────────────────────────────────────────────────────────────────────

/** `adapter_authority` PDA: seeds `["b402/v1", "adapter"]`. */
export function derivePercolatorAdapterAuthority(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEED_B402, SEED_ADAPTER],
    programId,
  );
}

/**
 * `owner_pda` PDA: seeds `["b402/v1", "perp-owner", viewing_pub_hash]`.
 *
 * Cross-adapter scoping property (PRD-33 §3.2): same `viewing_pub_hash`
 * derives a different pubkey here vs `b402-kamino-adapter`'s owner_pda
 * (different program_id + different second seed segment).
 */
export function derivePercolatorOwnerPda(
  programId: PublicKey,
  viewingPubHash: Uint8Array | Buffer,
): [PublicKey, number] {
  if (viewingPubHash.length !== 32) {
    throw new RangeError(`viewing_pub_hash must be 32 bytes, got ${viewingPubHash.length}`);
  }
  return PublicKey.findProgramAddressSync(
    [SEED_B402, SEED_PERP_OWNER, Buffer.from(viewingPubHash)],
    programId,
  );
}

/** `perp_mapping` PDA: seeds `["b402/v1", "perp-mapping", slab.key]`. */
export function derivePercolatorPerpMapping(
  programId: PublicKey,
  slab: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEED_B402, SEED_PERP_MAPPING, slab.toBuffer()],
    programId,
  );
}

// ─────────────────────────────────────────────────────────────────────
// remaining_accounts builder
// ─────────────────────────────────────────────────────────────────────

/**
 * Per-call accounts the percolator open/close handlers need at pinned
 * RA offsets. Caller resolves these off-chain (see slice 4-β SDK plus
 * the surfpool harness in slice 5).
 */
export interface PercolatorPerUserAccounts {
  /** `perp_mapping` PDA — derived from slab, owned by adapter, MUST be writable. */
  mapping: PublicKey;
  /** `owner_pda` — derived from viewing_pub_hash, MUST be writable (signs CPIs). */
  ownerPda: PublicKey;
  /** Per-user percolator USDC ATA owned by `owner_pda`. Writable. */
  userPercolatorAta: PublicKey;
  /** Slab account (percolator market state). Writable. */
  slab: PublicKey;
  /** Slab's USDC vault. Writable. */
  slabVault: PublicKey;
  /** Percolator program (target of CPI). */
  percolatorProgram: PublicKey;
  /** Sysvar clock. */
  clock: PublicKey;
  /** LP owner (counterparty wallet for the trade). */
  lpOwner: PublicKey;
  /** Oracle account percolator's TradeCpi reads. */
  oracle: PublicKey;
  /** Matcher program (CPI target inside percolator's TradeCpi). */
  matcherProgram: PublicKey;
  /** Matcher context account. */
  matcherContext: PublicKey;
  /** LP PDA inside the matcher. */
  lpPda: PublicKey;
  /**
   * Optional matcher-defined tail accounts appended after slot 12. The
   * matcher CPI variant percolator routes to may need extra accounts
   * (e.g. risk-engine reads). Slice 4-β's SDK will resolve these from
   * the matcher's `--describe` output.
   */
  matcherTail?: AccountMeta[];
}

/**
 * Build variadic `remaining_accounts` for both `OpenPosition` and
 * `ClosePosition`. RA layout sources of truth:
 *   - `programs/b402-percolator-adapter/src/actions/open.rs::RA_*`
 *   - `programs/b402-percolator-adapter/src/actions/close.rs` (re-exports the same constants)
 *
 * Slot indexes:
 *   0 mapping          — writable
 *   1 owner_pda        — writable (signed CPI)
 *   2 user_percolator_ata — writable
 *   3 slab             — writable
 *   4 slab_vault       — writable
 *   5 percolator_program
 *   6 clock
 *   7 lp_owner
 *   8 oracle
 *   9 matcher_program
 *  10 matcher_context  — writable
 *  11 lp_pda           — writable
 *  12+ matcher_tail (optional)
 */
export function buildPercolatorPerUserRemainingAccounts(
  perUser: PercolatorPerUserAccounts,
): AccountMeta[] {
  const head: AccountMeta[] = [
    { pubkey: perUser.mapping, isSigner: false, isWritable: true },              // 0  RA_MAPPING
    { pubkey: perUser.ownerPda, isSigner: false, isWritable: true },             // 1  RA_OWNER_PDA
    { pubkey: perUser.userPercolatorAta, isSigner: false, isWritable: true },    // 2  RA_USER_PERCOLATOR_ATA
    { pubkey: perUser.slab, isSigner: false, isWritable: true },                 // 3  RA_SLAB
    { pubkey: perUser.slabVault, isSigner: false, isWritable: true },            // 4  RA_SLAB_VAULT
    { pubkey: perUser.percolatorProgram, isSigner: false, isWritable: false },   // 5  RA_PERCOLATOR_PROGRAM
    { pubkey: perUser.clock, isSigner: false, isWritable: false },               // 6  RA_CLOCK
    { pubkey: perUser.lpOwner, isSigner: false, isWritable: false },             // 7  RA_LP_OWNER
    { pubkey: perUser.oracle, isSigner: false, isWritable: false },              // 8  RA_ORACLE
    { pubkey: perUser.matcherProgram, isSigner: false, isWritable: false },      // 9  RA_MATCHER_PROGRAM
    { pubkey: perUser.matcherContext, isSigner: false, isWritable: true },       // 10 RA_MATCHER_CONTEXT
    { pubkey: perUser.lpPda, isSigner: false, isWritable: true },                // 11 RA_LP_PDA
  ];
  return perUser.matcherTail ? [...head, ...perUser.matcherTail] : head;
}
