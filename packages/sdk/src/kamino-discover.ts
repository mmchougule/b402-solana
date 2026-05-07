/**
 * On-chain discovery for Kamino markets + reserves.
 *
 * Markets and reserves are NOT derivable from a static seed/mint tuple —
 * Kamino allocates each Reserve account at init time and stores the
 * `lending_market` reference inside the Reserve struct (offset 32). The
 * only way to enumerate them is `getProgramAccounts(KLEND)` filtered by
 * the Reserve anchor discriminator.
 *
 * What this module gives you:
 *   - `discoverKaminoMarkets(connection)` → every LendingMarket on chain
 *   - `discoverKaminoReserves(connection, opts?)` → every Reserve, with
 *     parsed market + liquidityMint + collateral mint
 *   - `findKaminoReserveByMint(connection, mint, opts?)` → first reserve
 *     whose liquidityMint matches; optionally constrained to a market
 *
 * Caching: getProgramAccounts is heavy on shared mainnet RPC. Caller is
 * responsible for caching results (typical lifetime: ~minutes — markets
 * and reserves change rarely).
 *
 * What this module does NOT do:
 *   - APY / utilization / interest-model parsing (separate `kamino-apy`
 *     module would handle that, reading interestRate fields from each
 *     Reserve and applying Kamino's curve)
 *   - Volume / TVL ranking (off-chain analytics, not in this lib)
 *   - Picking the "best" market for a mint — caller's policy
 */

import { Connection, PublicKey } from '@solana/web3.js';

/** KLend program id (mainnet). Kamino's lending core program. */
export const KLEND_PROGRAM_ID = new PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');

/** Anchor disc for KLend `Reserve` accounts. */
export const RESERVE_DISCRIMINATOR = Uint8Array.from([
  43, 242, 204, 202, 26, 247, 59, 127,
]);

/** Anchor disc for KLend `LendingMarket` accounts. */
export const LENDING_MARKET_DISCRIMINATOR = Uint8Array.from([
  246, 114, 50, 98, 72, 157, 28, 120,
]);

/** Reserve account size (verified across mainnet reserves). */
export const RESERVE_ACCOUNT_SIZE = 8624;

/** LendingMarket account size (verified mainnet). */
export const LENDING_MARKET_ACCOUNT_SIZE = 4664;

/** Reserve struct field offsets (verified across multiple reserves). */
export const RESERVE_LENDING_MARKET_OFFSET = 32;
export const RESERVE_FARM_COLLATERAL_OFFSET = 64;
export const RESERVE_LIQUIDITY_MINT_OFFSET = 128;
/** TokenInfo.name (32-byte zero-padded ASCII symbol like "USDC\0…"). */
export const RESERVE_TOKEN_INFO_NAME_OFFSET = 5032;

/** Reserve.liquidity.available_amount (u64) — cash in the supply vault.
 *  This is liquid supply only; borrowed funds are not here. */
export const RESERVE_AVAILABLE_AMOUNT_OFFSET = 224;

/** Reserve.liquidity.borrowed_amount_sf (u128, Kamino's "scaled fraction"
 *  = raw_amount << 60). Add to available_amount for total supply. */
export const RESERVE_BORROWED_AMOUNT_SF_OFFSET = 232;
const KAMINO_FRACTION_SHIFT = 60n;

/** Read a 32-byte symbol field, trim trailing zeros. */
function readSymbol(data: Buffer): string {
  const buf = data.subarray(RESERVE_TOKEN_INFO_NAME_OFFSET, RESERVE_TOKEN_INFO_NAME_OFFSET + 32);
  const end = buf.indexOf(0);
  return buf.subarray(0, end < 0 ? 32 : end).toString('utf8');
}

export interface DiscoveredReserve {
  /** Reserve PDA (account address). */
  address: PublicKey;
  /** LendingMarket the reserve belongs to. */
  market: PublicKey;
  /** Liquidity mint (the token deposited). */
  liquidityMint: PublicKey;
  /** Symbol from on-chain TokenInfo.name (e.g. "USDC", "SOL"). */
  symbol: string;
  /** Reserve's farm-collateral pubkey, or PublicKey.default if no farm. */
  farmCollateral: PublicKey;
  /** Raw u64 of `liquidity.available_amount` — cash in supply vault. */
  availableAmount: bigint;
  /** Total supply in raw units (available + borrowed). The right depth
   *  metric for ranking — established markets have most of their funds
   *  borrowed, so available_amount alone underestimates them by 100x or
   *  more. */
  totalSupply: bigint;
  /** Raw account bytes — caller can run a richer parser (oracles, etc.). */
  data: Buffer;
}

export interface DiscoveredMarket {
  /** LendingMarket account address. */
  address: PublicKey;
  /** Raw account bytes. */
  data: Buffer;
}

/** All LendingMarket accounts owned by KLEND on the connected cluster.
 *  ~10-30 results on mainnet, sub-second on Helius / Triton. */
export async function discoverKaminoMarkets(
  connection: Connection,
): Promise<DiscoveredMarket[]> {
  const accounts = await connection.getProgramAccounts(KLEND_PROGRAM_ID, {
    commitment: 'confirmed',
    filters: [
      { dataSize: LENDING_MARKET_ACCOUNT_SIZE },
      { memcmp: { offset: 0, bytes: bs58Encode(LENDING_MARKET_DISCRIMINATOR) } },
    ],
  });
  return accounts.map((a) => ({
    address: a.pubkey,
    data: Buffer.from(a.account.data),
  }));
}

export interface DiscoverReservesOptions {
  /** Restrict to a specific market (e.g. "Main"). */
  market?: PublicKey;
}

/** Every Reserve account owned by KLEND, parsed for the fields we need
 *  to route a deposit/withdraw without re-reading the chain. */
export async function discoverKaminoReserves(
  connection: Connection,
  options: DiscoverReservesOptions = {},
): Promise<DiscoveredReserve[]> {
  const filters: Parameters<Connection['getProgramAccounts']>[1] = {
    commitment: 'confirmed',
    filters: [
      { dataSize: RESERVE_ACCOUNT_SIZE },
      { memcmp: { offset: 0, bytes: bs58Encode(RESERVE_DISCRIMINATOR) } },
    ],
  };
  if (options.market) {
    filters.filters!.push({
      memcmp: { offset: RESERVE_LENDING_MARKET_OFFSET, bytes: options.market.toBase58() },
    });
  }
  const accounts = await connection.getProgramAccounts(KLEND_PROGRAM_ID, filters);

  return accounts.map((a) => {
    const data = Buffer.from(a.account.data);
    const available = data.readBigUInt64LE(RESERVE_AVAILABLE_AMOUNT_OFFSET);
    // borrowed_amount_sf is u128 little-endian at offset 232. Read as two
    // u64s and combine. Kamino's scaled-fraction format means
    // raw_borrowed = sf >> 60.
    const borrowedLo = data.readBigUInt64LE(RESERVE_BORROWED_AMOUNT_SF_OFFSET);
    const borrowedHi = data.readBigUInt64LE(RESERVE_BORROWED_AMOUNT_SF_OFFSET + 8);
    const borrowedSf = borrowedLo | (borrowedHi << 64n);
    const borrowedRaw = borrowedSf >> KAMINO_FRACTION_SHIFT;
    return {
      address: a.pubkey,
      market: new PublicKey(data.subarray(RESERVE_LENDING_MARKET_OFFSET, RESERVE_LENDING_MARKET_OFFSET + 32)),
      liquidityMint: new PublicKey(data.subarray(RESERVE_LIQUIDITY_MINT_OFFSET, RESERVE_LIQUIDITY_MINT_OFFSET + 32)),
      symbol: readSymbol(data),
      farmCollateral: new PublicKey(data.subarray(RESERVE_FARM_COLLATERAL_OFFSET, RESERVE_FARM_COLLATERAL_OFFSET + 32)),
      availableAmount: available,
      totalSupply: available + borrowedRaw,
      data,
    };
  });
}

/** Pick the deepest reserve for a mint, returning the choice + the
 *  alternates (sorted desc by availableAmount). Used by
 *  private_lend / private_redeem to default to the largest-liquidity
 *  match while exposing the runner-ups in the response so the caller
 *  can switch markets next time.
 *
 *  Returns null if no reserve exists for the mint. */
export async function pickBestKaminoReserveByMint(
  connection: Connection,
  mint: PublicKey,
  options: DiscoverReservesOptions = {},
): Promise<{ best: DiscoveredReserve; alternates: DiscoveredReserve[] } | null> {
  const matches = await findAllKaminoReservesByMint(connection, mint, options);
  if (matches.length === 0) return null;
  // Sort by total supply (available + borrowed). Established markets have
  // most of their funds borrowed out, so available_amount alone would
  // unfairly favor low-utilization isolated markets.
  matches.sort((a, b) => (a.totalSupply > b.totalSupply ? -1 : a.totalSupply < b.totalSupply ? 1 : 0));
  return { best: matches[0], alternates: matches.slice(1) };
}

/** Find the first reserve (across all markets, or constrained to one)
 *  whose liquidityMint == `mint`. Returns null if no match.
 *
 *  When the mint is listed in multiple markets and the caller hasn't
 *  passed `options.market`, this returns whichever Kamino enumerated
 *  first — order isn't stable across RPC calls. Prefer
 *  `findAllKaminoReservesByMint` and let the caller / agent pick. */
export async function findKaminoReserveByMint(
  connection: Connection,
  mint: PublicKey,
  options: DiscoverReservesOptions = {},
): Promise<DiscoveredReserve | null> {
  const matches = await findAllKaminoReservesByMint(connection, mint, options);
  return matches[0] ?? null;
}

/** Every reserve whose liquidityMint == `mint`. Empty if unsupported.
 *
 *  Use this when the mint can appear in multiple markets (USDC, SOL,
 *  JLP, etc.) and the caller wants to surface the full picker / let the
 *  user choose by APY, market name, or other policy. */
export async function findAllKaminoReservesByMint(
  connection: Connection,
  mint: PublicKey,
  options: DiscoverReservesOptions = {},
): Promise<DiscoveredReserve[]> {
  const all = await discoverKaminoReserves(connection, options);
  return all.filter((r) => r.liquidityMint.equals(mint));
}

// — minimal base58 encoder for the memcmp filter without dragging bs58 in —
// stateless.js / @solana/web3.js already pull bs58 transitively, but keeping
// this import-free avoids a cross-package version pin.
function bs58Encode(bytes: Uint8Array): string {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  return '1'.repeat(zeros) + out;
}
