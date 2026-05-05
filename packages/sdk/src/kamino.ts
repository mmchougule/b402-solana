/**
 * Kamino-specific helpers for `B402Solana.privateLend` / `privateRedeem`.
 *
 * The pool's `adapt_execute(_v2)` is generic — it forwards an opaque
 * `action_payload` and `remaining_accounts` block to the registered
 * adapter. These helpers build the Kamino-shaped versions of both, so
 * callers don't have to recreate them per-test or per-script.
 *
 * Layout sources of truth (kept in sync with the Rust adapter):
 *   - action_payload: `KaminoAction` Borsh enum in
 *     `programs/b402-kamino-adapter/src/lib.rs`
 *   - remaining_accounts: `ra_deposit_per_user` (20 entries) and
 *     `ra_withdraw_per_user` (13 entries) modules in the same file.
 *
 * Callers are still responsible for discovering the per-reserve account
 * pubkeys (oracle accounts, obligation PDA, etc.) — see `examples/`
 * for a reference implementation that parses a cloned reserve.
 */
import {
  PublicKey,
  SystemProgram,
  type AccountMeta,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

const SYSVAR_INSTRUCTIONS = new PublicKey('Sysvar1nstructions1111111111111111111111111');
const SYSVAR_RENT = new PublicKey('SysvarRent111111111111111111111111111111111');

// `KaminoAction` enum tags. Borsh: enum variants are encoded as a 1-byte
// discriminator (variant index in declaration order) followed by the
// fields. Keep in lockstep with the Rust enum.
const KAMINO_ACTION_DEPOSIT = 0;
const KAMINO_ACTION_WITHDRAW = 1;

// `execute` ix discriminator — sha256("global:execute")[..8].
const EXECUTE_DISC = Uint8Array.from([130, 221, 242, 154, 13, 193, 189, 29]);

function u64Le(v: bigint): Uint8Array {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v, 0);
  return new Uint8Array(b);
}

function u32Le(n: number): Uint8Array {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return new Uint8Array(b);
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

/** `KaminoAction::Deposit { reserve, in_amount, min_kt_out }` Borsh-encoded. */
export function buildKaminoDepositActionPayload(params: {
  reserve: PublicKey;
  inAmount: bigint;
  minKtOut: bigint;
}): Uint8Array {
  return concat(
    new Uint8Array([KAMINO_ACTION_DEPOSIT]),
    params.reserve.toBytes(),
    u64Le(params.inAmount),
    u64Le(params.minKtOut),
  );
}

/** `KaminoAction::Withdraw { reserve, kt_in, min_underlying_out }` Borsh-encoded. */
export function buildKaminoWithdrawActionPayload(params: {
  reserve: PublicKey;
  ktIn: bigint;
  minUnderlyingOut: bigint;
}): Uint8Array {
  return concat(
    new Uint8Array([KAMINO_ACTION_WITHDRAW]),
    params.reserve.toBytes(),
    u64Le(params.ktIn),
    u64Le(params.minUnderlyingOut),
  );
}

/**
 * Wrap an action_payload in the adapter's `execute` ix data:
 * `disc(8) | in_amount(u64) | min_out(u64) | len(u32) | action_payload`.
 *
 * For privateRedeem, pass `inAmount = ktIn` and `expectedOut = minUnderlyingOut`.
 */
export function buildKaminoExecuteIxData(params: {
  inAmount: bigint;
  expectedOut: bigint;
  actionPayload: Uint8Array;
}): Uint8Array {
  return concat(
    EXECUTE_DISC,
    u64Le(params.inAmount),
    u64Le(params.expectedOut),
    u32Le(params.actionPayload.length),
    params.actionPayload,
  );
}

/**
 * Reserve-related accounts the per-user Kamino actions need. Caller
 * resolves these by reading the cloned reserve account; see the
 * `parseReserve` helper in `tests/v2/e2e/v2_fork_lend.test.ts` for a
 * reference implementation.
 */
export interface KaminoReserveAccounts {
  reserve: PublicKey;
  lendingMarket: PublicKey;
  lendingMarketAuthority: PublicKey;
  reserveLiquiditySupply: PublicKey;
  reserveCollateralMint: PublicKey;
  reserveCollateralReserveDestSupply: PublicKey;
  reserveLiquidityMint: PublicKey;
  oracles: {
    pyth: PublicKey | null;
    switchboardPrice: PublicKey | null;
    switchboardTwap: PublicKey | null;
    scope: PublicKey | null;
  };
  /** Default::default() if no farm attached. */
  reserveFarmCollateral: PublicKey;
  /** Kamino farms program. */
  farmsProgram: PublicKey;
  /** kLend program — used as the sentinel/fallback for absent oracles +
   *  obligationFarm slot when the reserve has no farm attached. */
  klendProgram: PublicKey;
}

/** Per-user deposit-side accounts. The pool resolves owner_pda from the
 *  proof's spending pubkey, but the adapter also receives it explicitly
 *  at slot 19 (PRD-33 §3.3). */
export interface KaminoPerUserAccounts {
  /** Per-user `UserMetadata` PDA, derived from owner_pda. */
  userMetadata: PublicKey;
  /** Per-user `Obligation` PDA, derived from owner_pda + market. */
  obligation: PublicKey;
  /** Per-user farm-state PDA (only used if reserve has a farm attached). */
  obligationFarm: PublicKey;
  /** owner_pda — derived from the user's b402 spending pubkey hash. */
  ownerPda: PublicKey;
  /** Per-user USDC ATA owned by `ownerPda`. Kamino requires
   *  `userSourceLiquidity.owner == obligationOwner` on deposit, so the
   *  adapter routes USDC through this ATA. Caller MUST pre-create via
   *  `createAssociatedTokenAccountIdempotent` (rent ~0.002 SOL, charged
   *  on first deposit). */
  ownerUsdcAta: PublicKey;
}

/**
 * Build `ra_deposit_per_user` (20 entries) for the Kamino adapter.
 * Order MUST match `programs/b402-kamino-adapter/src/lib.rs::ra_deposit_per_user`.
 */
export function buildKaminoDepositRemainingAccounts(
  reserveAccts: KaminoReserveAccounts,
  perUser: KaminoPerUserAccounts,
): AccountMeta[] {
  const isFarmAttached = !reserveAccts.reserveFarmCollateral.equals(PublicKey.default);
  // When no farm is attached, BOTH the obligation_farm slot (14) and the
  // reserve_farm_state slot (15) get the klend program as a sentinel —
  // the adapter's `handle_deposit_per_user` skips the obligation_farms
  // ix entirely in that case but still expects two account slots.
  const obligationFarmSlot = isFarmAttached ? perUser.obligationFarm : reserveAccts.klendProgram;
  const reserveFarmStateSlot = isFarmAttached ? reserveAccts.reserveFarmCollateral : reserveAccts.klendProgram;
  return [
    { pubkey: reserveAccts.reserve, isSigner: false, isWritable: true },
    { pubkey: reserveAccts.lendingMarket, isSigner: false, isWritable: false },
    { pubkey: reserveAccts.lendingMarketAuthority, isSigner: false, isWritable: false },
    { pubkey: reserveAccts.reserveLiquiditySupply, isSigner: false, isWritable: true },
    { pubkey: reserveAccts.reserveCollateralMint, isSigner: false, isWritable: true },
    { pubkey: reserveAccts.reserveCollateralReserveDestSupply, isSigner: false, isWritable: true },
    { pubkey: reserveAccts.oracles.pyth ?? reserveAccts.klendProgram, isSigner: false, isWritable: false },
    { pubkey: reserveAccts.oracles.switchboardPrice ?? reserveAccts.klendProgram, isSigner: false, isWritable: false },
    { pubkey: reserveAccts.oracles.switchboardTwap ?? reserveAccts.klendProgram, isSigner: false, isWritable: false },
    { pubkey: reserveAccts.oracles.scope ?? reserveAccts.klendProgram, isSigner: false, isWritable: false },
    { pubkey: reserveAccts.reserveLiquidityMint, isSigner: false, isWritable: false },
    { pubkey: reserveAccts.farmsProgram, isSigner: false, isWritable: false },
    { pubkey: perUser.userMetadata, isSigner: false, isWritable: true },
    { pubkey: perUser.obligation, isSigner: false, isWritable: true },
    { pubkey: obligationFarmSlot, isSigner: false, isWritable: isFarmAttached },
    { pubkey: reserveFarmStateSlot, isSigner: false, isWritable: isFarmAttached },
    { pubkey: SYSVAR_INSTRUCTIONS, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT, isSigner: false, isWritable: false },
    // ownerPda must be WRITABLE — the kamino-adapter's
    // handle_deposit_per_user invokes signed CPIs into Kamino's
    // init_user_metadata + init_obligation, which require the obligation
    // owner as Anchor role-3 (signer + writable). Privilege can't escalate
    // inside a CPI, so the outer slot must start writable.
    { pubkey: perUser.ownerPda, isSigner: false, isWritable: true },
    // Per-user USDC ATA owned by ownerPda. Kamino's
    // DepositReserveLiquidityAndObligationCollateralV2 enforces
    // `userSourceLiquidity.owner == obligationOwner`; the adapter
    // SPL-transfers adapter_in_ta → this ATA pre-CPI. Caller MUST
    // pre-create via `createAssociatedTokenAccountIdempotent` before
    // submitting the lend.
    { pubkey: perUser.ownerUsdcAta, isSigner: false, isWritable: true },
  ];
}

/**
 * Build `ra_withdraw_per_user` (20 entries) for the Kamino adapter.
 * Order MUST match `programs/b402-kamino-adapter/src/lib.rs::ra_withdraw_per_user`.
 *
 * Slots 0-12: Kamino's `withdrawObligationCollateralAndRedeemReserveCollateral_v2`
 * V1 sub-account list. Slot 7 (`userDestinationLiquidity`) MUST be a USDC
 * ATA owned by `ownerPda` — Kamino enforces `token::authority == owner`.
 * Caller passes `perUser.ownerUsdcAta`. The adapter sweeps from there into
 * `adapter_out_ta` post-CPI so the pool's existing actual-out delta logic
 * sees the redeemed USDC.
 *
 * Slots 13-16: oracle accounts for `refresh_reserve` (KLEND program ID
 * sentinel for absent oracles).
 *
 * Slots 17-19: farm accounts for the `_v2` ix (CPI-callable variant of
 * the withdraw). Use KLEND sentinel for slots 17/18 when no farm.
 */
export function buildKaminoWithdrawRemainingAccounts(
  reserveAccts: KaminoReserveAccounts,
  perUser: KaminoPerUserAccounts,
): AccountMeta[] {
  const isFarmAttached = !reserveAccts.reserveFarmCollateral.equals(PublicKey.default);
  const obligationFarmSlot = isFarmAttached ? perUser.obligationFarm : reserveAccts.klendProgram;
  const reserveFarmStateSlot = isFarmAttached ? reserveAccts.reserveFarmCollateral : reserveAccts.klendProgram;
  return [
    { pubkey: reserveAccts.reserve, isSigner: false, isWritable: true },                          // 0
    { pubkey: perUser.obligation, isSigner: false, isWritable: true },                            // 1
    { pubkey: reserveAccts.lendingMarket, isSigner: false, isWritable: false },                   // 2
    { pubkey: reserveAccts.lendingMarketAuthority, isSigner: false, isWritable: false },          // 3
    { pubkey: reserveAccts.reserveCollateralReserveDestSupply, isSigner: false, isWritable: true },// 4
    { pubkey: reserveAccts.reserveCollateralMint, isSigner: false, isWritable: true },            // 5
    { pubkey: reserveAccts.reserveLiquiditySupply, isSigner: false, isWritable: true },           // 6
    { pubkey: perUser.ownerUsdcAta, isSigner: false, isWritable: true },                          // 7  user_destination_liquidity
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // collateral token program  // 8
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // liquidity token program   // 9
    { pubkey: SYSVAR_INSTRUCTIONS, isSigner: false, isWritable: false },                          // 10
    { pubkey: reserveAccts.reserveLiquidityMint, isSigner: false, isWritable: false },            // 11
    { pubkey: perUser.ownerPda, isSigner: false, isWritable: true },                              // 12  must be writable for owner_seeds-signed sweep
    // Oracle slots (KLEND sentinel for absent).
    { pubkey: reserveAccts.oracles.pyth ?? reserveAccts.klendProgram, isSigner: false, isWritable: false },             // 13
    { pubkey: reserveAccts.oracles.switchboardPrice ?? reserveAccts.klendProgram, isSigner: false, isWritable: false }, // 14
    { pubkey: reserveAccts.oracles.switchboardTwap ?? reserveAccts.klendProgram, isSigner: false, isWritable: false },  // 15
    { pubkey: reserveAccts.oracles.scope ?? reserveAccts.klendProgram, isSigner: false, isWritable: false },            // 16
    // Farm slots for V2 ix (KLEND sentinel for no-farm reserves).
    { pubkey: obligationFarmSlot, isSigner: false, isWritable: isFarmAttached },                  // 17
    { pubkey: reserveFarmStateSlot, isSigner: false, isWritable: isFarmAttached },                // 18
    { pubkey: reserveAccts.farmsProgram, isSigner: false, isWritable: false },                    // 19
  ];
}
