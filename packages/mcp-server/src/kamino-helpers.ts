/**
 * Kamino-mainnet helpers shared by `private_lend` + `private_redeem` MCP tools.
 *
 * Encapsulates the per-user obligation derivation, reserve parsing,
 * lazy ALT bootstrap, and the SPL ATA pre-create that the kamino-adapter
 * requires. Mirrors `examples/mainnet-kamino-lend-demo.mjs` so tooling
 * stays in lockstep with the e2e harness.
 *
 * Mainnet-only. The reserve + market + adapter pubkeys below are mainnet
 * deployments.
 */

import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  type AccountMeta,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
} from '@solana/spl-token';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ── mainnet program IDs ───────────────────────────────────────────────────────
export const POOL = new PublicKey('42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y');
export const NULLIFIER = new PublicKey('2AnRZwWu6CTurZs1yQpqrcJWo4yRYL1xpeV78b2siweq');
export const VERIFIER_T = new PublicKey('Afjbnv2Ekxa98jjRw33xPPhZabevek2uZxoE75kr6ZrK');
export const VERIFIER_A = new PublicKey('3Y2tyhNSaUiW5AcZcmFGRyTMdnroxHxc5GqFQPcMTZae');
export const KAMINO_ADAPTER = new PublicKey('2enwFgcGKJDqruHpCtvmhtxe3DYcV3k72VTvoGcdt2rX');
export const KLEND = new PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');
export const FARMS_PROGRAM = new PublicKey('FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr');

// USDC mainnet + Kamino main-market USDC reserve
export const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
export const MARKET = new PublicKey('7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF');
export const RESERVE = new PublicKey('D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59');

// Light Protocol V2 + sysvars
export const LIGHT_SYSTEM_PROGRAM = new PublicKey('SySTEM1eSU2p4BGQfQpimFEWWSC1XDFeun3Nqzz3rT7');
export const ACCOUNT_COMPRESSION_PROGRAM = new PublicKey('compr6CUsB5m2jS4Y3831ztGSTnDpnKJTKS95d64XVq');
export const REGISTERED_PROGRAM_PDA = new PublicKey('35hkDgaAKwMCaxRz2ocSZ6NaUrtKkyNqU6c4RV3tYJRh');
export const ACCOUNT_COMPRESSION_AUTHORITY = new PublicKey('HwXnGK3tPkkVY6P439H2p68AxpeuWXd5PcrAxFpbmfbA');
export const ADDRESS_TREE = new PublicKey('amt2kaJA14v3urZbZvnc5v2np8jqvc4Z8zDep5wbtzx');
export const OUTPUT_QUEUE = new PublicKey('oq5oh5ZR3yGomuQgFduNDzjtGvVWfDRGLuDVjv9a96P');
export const SYSVAR_INSTRUCTIONS = new PublicKey('Sysvar1nstructions1111111111111111111111111');
export const SYSVAR_RENT = new PublicKey('SysvarRent111111111111111111111111111111111');
export const COMPUTE_BUDGET = new PublicKey('ComputeBudget111111111111111111111111111111');

const ALT_PROGRAM = new PublicKey('AddressLookupTab1e1111111111111111111111111');

// Adapter ix discriminator: sha256("global:execute")[..8]
const EXECUTE_DISC = Uint8Array.from([130, 221, 242, 154, 13, 193, 189, 29]);

// ── small helpers ─────────────────────────────────────────────────────────────
function findUtf8(buf: Buffer, needle: string): number {
  const b = Buffer.from(needle, 'utf8');
  for (let i = 0; i < buf.length - b.length; i++) {
    if (buf.subarray(i, i + b.length).equals(b)) return i;
  }
  return -1;
}

function reservePda(seed: string, market: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(seed), market.toBuffer(), mint.toBuffer()], KLEND,
  )[0];
}

export function lendingMarketAuthorityPda(market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('lma'), market.toBuffer()], KLEND)[0];
}

export function userMetadataPda(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('user_meta'), owner.toBuffer()], KLEND)[0];
}

export function obligationPda(owner: PublicKey, market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from([0]), Buffer.from([0]),
      owner.toBuffer(), market.toBuffer(),
      PublicKey.default.toBuffer(), PublicKey.default.toBuffer(),
    ], KLEND,
  )[0];
}

export function obligationFarmPda(farm: PublicKey, obligation: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('user'), farm.toBuffer(), obligation.toBuffer()], FARMS_PROGRAM,
  )[0];
}

export function deriveOwnerPda(adapter: PublicKey, hash: Buffer): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('b402/v1'), Buffer.from('adapter-owner'), hash], adapter,
  )[0];
}

export function spendingPubToHashBytes(spendingPub: bigint): Buffer {
  const buf = Buffer.alloc(32);
  let v = spendingPub;
  for (let i = 0; i < 32; i++) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

// ── reserve parsing ───────────────────────────────────────────────────────────
export interface ParsedReserve {
  liquidityMint: PublicKey;
  liquiditySupply: PublicKey;
  collateralMint: PublicKey;
  collateralReserveDestSupply: PublicKey;
  pyth: PublicKey | null;
  switchboardPrice: PublicKey | null;
  switchboardTwap: PublicKey | null;
  scope: PublicKey | null;
  reserveFarmCollateral: PublicKey;
}

/** Reserve struct field offsets shared with the SDK's kamino-discover. */
const RESERVE_LIQUIDITY_MINT_OFFSET = 128;
const RESERVE_FARM_COLLATERAL_OFFSET = 64;
const RESERVE_TOKEN_INFO_NAME_OFFSET = 5032;

/** Parse a Kamino reserve account into the per-reserve PDAs the adapter
 *  needs. Uses fixed struct offsets only — no string-anchor search, so
 *  it works for any mint (USDC, SOL, JitoSOL, BONK, …). The `market`
 *  argument is required because the per-reserve sub-PDAs (liquidity
 *  supply, collateral mint, etc.) are derived from `(market, mint)`. */
export function parseReserve(data: Buffer, market: PublicKey): ParsedReserve {
  const liquidityMint = new PublicKey(data.subarray(RESERVE_LIQUIDITY_MINT_OFFSET, RESERVE_LIQUIDITY_MINT_OFFSET + 32));
  const reserveFarmCollateral = new PublicKey(data.subarray(RESERVE_FARM_COLLATERAL_OFFSET, RESERVE_FARM_COLLATERAL_OFFSET + 32));
  const tokenInfoOff = RESERVE_TOKEN_INFO_NAME_OFFSET;
  // Within TokenInfo: name(32) + heuristic(24) + maxAgePriceSeconds(8) + maxAgeTwapSeconds(8) + scopeConfig(...)
  const scopeOff = tokenInfoOff + 32 + 24 + 24;
  const swbOff = scopeOff + 52;
  const pythOff = swbOff + 68;
  const def = PublicKey.default;
  const readPk = (off: number): PublicKey | null => {
    const pk = new PublicKey(data.subarray(off, off + 32));
    return pk.equals(def) ? null : pk;
  };
  return {
    liquidityMint,
    liquiditySupply: reservePda('reserve_liq_supply', market, liquidityMint),
    collateralMint: reservePda('reserve_coll_mint', market, liquidityMint),
    collateralReserveDestSupply: reservePda('reserve_coll_supply', market, liquidityMint),
    pyth: readPk(pythOff),
    switchboardPrice: readPk(swbOff),
    switchboardTwap: readPk(swbOff + 32),
    scope: readPk(scopeOff),
    reserveFarmCollateral,
  };
}

// ── per-user account bundle ──────────────────────────────────────────────────
export interface PerUserAccounts {
  ownerPda: PublicKey;
  userMetadata: PublicKey;
  obligation: PublicKey;
  obligationFarm: PublicKey;
  reserveFarmState: PublicKey;
  ownerUsdcAta: PublicKey;
  isFarmAttached: boolean;
}

export function deriveAllPerUser(
  spendingPub: bigint,
  reserve: ParsedReserve,
  market: PublicKey,
): PerUserAccounts {
  const hash = spendingPubToHashBytes(spendingPub);
  const ownerPda = deriveOwnerPda(KAMINO_ADAPTER, hash);
  const isFarmAttached = !reserve.reserveFarmCollateral.equals(PublicKey.default);
  const obl = obligationPda(ownerPda, market);
  return {
    ownerPda,
    userMetadata: userMetadataPda(ownerPda),
    obligation: obl,
    obligationFarm: isFarmAttached ? obligationFarmPda(reserve.reserveFarmCollateral, obl) : KLEND,
    reserveFarmState: isFarmAttached ? reserve.reserveFarmCollateral : KLEND,
    // Per-mint user ATA owned by ownerPda — was named `ownerUsdcAta` for the
    // initial USDC-only flow but works for any mint via `reserve.liquidityMint`.
    ownerUsdcAta: getAssociatedTokenAddressSync(reserve.liquidityMint, ownerPda, true),
    isFarmAttached,
  };
}

// ── ALT bootstrap ─────────────────────────────────────────────────────────────
/** Persist one ALT per (market, mint) tuple. Different markets/mints have
 *  disjoint reserve sub-PDAs; sharing one ALT across mints would force
 *  re-extends on every switch, eating the 256-entry ALT cap fast. */
function altPersistPathFor(market: PublicKey, mint: PublicKey): string {
  return path.join(
    os.homedir(),
    '.b402-solana',
    `kamino-mainnet-alt-${market.toBase58().slice(0, 8)}-${mint.toBase58().slice(0, 8)}.json`,
  );
}

/** Load (or create + extend) the persisted ALT for Kamino lend/redeem. The
 *  ALT contains all the static and per-user accounts that the lend/redeem
 *  txs reference; without it the txs exceed the 1232-byte cap. */
export async function ensureAlt(args: {
  conn: Connection;
  admin: Keypair;
  market: PublicKey;
  reserveAddr: PublicKey;
  reserve: ParsedReserve;
  perUser: PerUserAccounts;
  pendingInputsPda: PublicKey;
  adapterAuthority: PublicKey;
  adapterInTa: PublicKey;
  adapterOutTa: PublicKey;
  outMint: PublicKey;
  poolHelpers: {
    poolConfigPda: (pool: PublicKey) => PublicKey;
    adapterRegistryPda: (pool: PublicKey) => PublicKey;
    treeStatePda: (pool: PublicKey) => PublicKey;
    tokenConfigPda: (pool: PublicKey, mint: PublicKey) => PublicKey;
    vaultPda: (pool: PublicKey, mint: PublicKey) => PublicKey;
  };
  altPersistPath?: string;
}): Promise<PublicKey> {
  const persistPath = args.altPersistPath ?? altPersistPathFor(args.market, args.reserve.liquidityMint);
  fs.mkdirSync(path.dirname(persistPath), { recursive: true });

  const NULLIFIER_CPI_AUTHORITY = PublicKey.findProgramAddressSync(
    [Buffer.from('cpi_authority')], NULLIFIER,
  )[0];

  const inMint = args.reserve.liquidityMint;

  const altShared = [
    LIGHT_SYSTEM_PROGRAM, ACCOUNT_COMPRESSION_PROGRAM, REGISTERED_PROGRAM_PDA,
    ACCOUNT_COMPRESSION_AUTHORITY, ADDRESS_TREE, OUTPUT_QUEUE,
    NULLIFIER, NULLIFIER_CPI_AUTHORITY,
    POOL,
    args.poolHelpers.poolConfigPda(POOL),
    args.poolHelpers.adapterRegistryPda(POOL),
    args.poolHelpers.treeStatePda(POOL),
    args.poolHelpers.tokenConfigPda(POOL, inMint),
    args.poolHelpers.tokenConfigPda(POOL, args.outMint),
    args.poolHelpers.vaultPda(POOL, inMint),
    args.poolHelpers.vaultPda(POOL, args.outMint),
    VERIFIER_A,
    KAMINO_ADAPTER, args.adapterAuthority,
    args.adapterInTa, args.adapterOutTa,
    args.reserveAddr, args.market, lendingMarketAuthorityPda(args.market),
    args.reserve.liquiditySupply, args.reserve.collateralMint,
    args.reserve.collateralReserveDestSupply,
    args.reserve.pyth ?? KLEND, args.reserve.switchboardPrice ?? KLEND,
    args.reserve.switchboardTwap ?? KLEND, args.reserve.scope ?? KLEND,
    args.reserve.liquidityMint, FARMS_PROGRAM,
    SYSVAR_INSTRUCTIONS, COMPUTE_BUDGET, TOKEN_PROGRAM_ID,
    SystemProgram.programId, SYSVAR_RENT, KLEND,
  ];

  const perUserCandidates = [
    args.admin.publicKey,
    args.perUser.ownerPda, args.perUser.userMetadata,
    args.perUser.obligation, args.perUser.ownerUsdcAta,
    ...(args.perUser.isFarmAttached ? [args.perUser.obligationFarm] : []),
    ...(args.perUser.isFarmAttached && !args.perUser.reserveFarmState.equals(KLEND)
      ? [args.perUser.reserveFarmState] : []),
    args.pendingInputsPda,
  ];

  // Reuse persisted ALT if it still exists on chain.
  let altPubkey: PublicKey | null = null;
  let altIsFresh = false;
  if (fs.existsSync(persistPath)) {
    const persisted = new PublicKey(JSON.parse(fs.readFileSync(persistPath, 'utf8')).pubkey);
    const info = await args.conn.getAccountInfo(persisted, 'confirmed');
    if (info && info.owner.equals(ALT_PROGRAM)) {
      altPubkey = persisted;
    }
  }

  if (!altPubkey) {
    const slot = Math.max(1, (await args.conn.getSlot('confirmed')) - 50);
    const [createIx, fresh] = AddressLookupTableProgram.createLookupTable({
      authority: args.admin.publicKey, payer: args.admin.publicKey, recentSlot: slot,
    });
    altPubkey = fresh;
    altIsFresh = true;
    await sendAndConfirmTransaction(args.conn, new Transaction().add(createIx), [args.admin], { commitment: 'finalized' });
    // Wait for ALT to be finalized + visible.
    for (let i = 0; i < 60; i++) {
      const info = await args.conn.getAccountInfo(altPubkey, 'finalized');
      if (info && info.owner.equals(ALT_PROGRAM)) break;
      if (i === 59) throw new Error('ALT not visible after 60s');
      await new Promise((r) => setTimeout(r, 1000));
    }
    fs.writeFileSync(persistPath, JSON.stringify({ pubkey: altPubkey.toBase58() }, null, 2));
  }

  // Extend with whatever's missing. Static block only needs to be extended on
  // a fresh ALT; per-user PDAs always check.
  const altInfo = await args.conn.getAccountInfo(altPubkey, 'confirmed');
  const altDecoded = altInfo
    ? AddressLookupTableAccount.deserialize(altInfo.data).addresses
    : [];
  const haveInAlt = (pk: PublicKey) => altDecoded.some((a) => a.equals(pk));

  const targets: PublicKey[] = [];
  if (altIsFresh) targets.push(...altShared);
  for (const pk of perUserCandidates) {
    if (!haveInAlt(pk) && !targets.some((t) => t.equals(pk))) targets.push(pk);
  }

  if (targets.length > 0) {
    const CHUNK = 25;
    for (let i = 0; i < targets.length; i += CHUNK) {
      const ext = AddressLookupTableProgram.extendLookupTable({
        payer: args.admin.publicKey, authority: args.admin.publicKey, lookupTable: altPubkey,
        addresses: targets.slice(i, i + CHUNK),
      });
      await sendAndConfirmTransaction(args.conn, new Transaction().add(ext), [args.admin], { commitment: 'confirmed' });
    }
    // Brief wait so the next tx can resolve via the new entries.
    await new Promise((r) => setTimeout(r, 4000));
  }

  return altPubkey;
}

// ── per-user setup (ATA + adapter authority pre-fund) ────────────────────────
export async function ensurePerUserSetup(args: {
  conn: Connection;
  admin: Keypair;
  perUser: PerUserAccounts;
  reserve: ParsedReserve;
  adapterAuthority: PublicKey;
}): Promise<{ adapterFunded: boolean; ataCreated: boolean }> {
  // Adapter authority needs ~0.5 SOL on first lend to pay for Kamino
  // UserMetadata + Obligation account rent.
  let adapterFunded = false;
  const aaBal = await args.conn.getBalance(args.adapterAuthority);
  if (aaBal < 0.05 * LAMPORTS_PER_SOL) {
    await sendAndConfirmTransaction(args.conn,
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: args.admin.publicKey,
          toPubkey: args.adapterAuthority,
          lamports: 0.5 * LAMPORTS_PER_SOL,
        }),
      ),
      [args.admin], { commitment: 'confirmed' },
    );
    adapterFunded = true;
  }

  // Per-user USDC ATA owned by ownerPda. Required by Kamino's deposit_v2.
  let ataCreated = false;
  const ataInfo = await args.conn.getAccountInfo(args.perUser.ownerUsdcAta);
  if (!ataInfo) {
    const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
      args.admin.publicKey, args.perUser.ownerUsdcAta,
      args.perUser.ownerPda, args.reserve.liquidityMint,
    );
    await sendAndConfirmTransaction(args.conn, new Transaction().add(createAtaIx), [args.admin], { commitment: 'confirmed' });
    ataCreated = true;
  }

  return { adapterFunded, ataCreated };
}

/** Adapter scratch ATAs (USDC + kUSDC, owned by adapterAuthority). */
export async function ensureAdapterScratchAtas(args: {
  conn: Connection;
  admin: Keypair;
  adapterAuthority: PublicKey;
  inMint: PublicKey;
  outMint: PublicKey;
}): Promise<{ adapterInTa: PublicKey; adapterOutTa: PublicKey }> {
  const inAcc = await getOrCreateAssociatedTokenAccount(
    args.conn, args.admin, args.inMint, args.adapterAuthority, true,
  );
  const outAcc = await getOrCreateAssociatedTokenAccount(
    args.conn, args.admin, args.outMint, args.adapterAuthority, true,
  );
  return { adapterInTa: inAcc.address, adapterOutTa: outAcc.address };
}

// ── ix data builders (deposit / withdraw) ─────────────────────────────────────
function u32Le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; }
function u64Le(v: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(v, 0); return b; }

export function buildDepositPayload(reserve: PublicKey, inAmount: bigint): Buffer {
  // KaminoAction::Deposit { reserve, in_amount, min_kt_out=0 }
  return Buffer.concat([
    Buffer.from([0]),
    reserve.toBuffer(),
    u64Le(inAmount),
    u64Le(0n),
  ]);
}

export function buildWithdrawPayload(reserve: PublicKey, ktIn: bigint): Buffer {
  // KaminoAction::Withdraw { reserve, kt_in, min_underlying_out=0 }
  return Buffer.concat([
    Buffer.from([1]),
    reserve.toBuffer(),
    u64Le(ktIn),
    u64Le(0n),
  ]);
}

export function buildAdapterIxData(inAmount: bigint, expectedOut: bigint, payload: Buffer): Uint8Array {
  return new Uint8Array(Buffer.concat([
    Buffer.from(EXECUTE_DISC),
    u64Le(inAmount),
    u64Le(expectedOut),
    u32Le(payload.length),
    payload,
  ]));
}

// ── remaining_accounts builders ──────────────────────────────────────────────
export function buildDepositRemainingAccounts(args: {
  market: PublicKey;
  reserveAddr: PublicKey;
  reserve: ParsedReserve;
  perUser: PerUserAccounts;
}): AccountMeta[] {
  const { reserve, perUser } = args;
  const isFarm = perUser.isFarmAttached;
  return [
    { pubkey: args.reserveAddr, isSigner: false, isWritable: true },
    { pubkey: args.market, isSigner: false, isWritable: false },
    { pubkey: lendingMarketAuthorityPda(args.market), isSigner: false, isWritable: false },
    { pubkey: reserve.liquiditySupply, isSigner: false, isWritable: true },
    { pubkey: reserve.collateralMint, isSigner: false, isWritable: true },
    { pubkey: reserve.collateralReserveDestSupply, isSigner: false, isWritable: true },
    { pubkey: reserve.pyth ?? KLEND, isSigner: false, isWritable: false },
    { pubkey: reserve.switchboardPrice ?? KLEND, isSigner: false, isWritable: false },
    { pubkey: reserve.switchboardTwap ?? KLEND, isSigner: false, isWritable: false },
    { pubkey: reserve.scope ?? KLEND, isSigner: false, isWritable: false },
    { pubkey: reserve.liquidityMint, isSigner: false, isWritable: false },
    { pubkey: FARMS_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: perUser.userMetadata, isSigner: false, isWritable: true },
    { pubkey: perUser.obligation, isSigner: false, isWritable: true },
    { pubkey: perUser.obligationFarm, isSigner: false, isWritable: isFarm },
    { pubkey: perUser.reserveFarmState, isSigner: false, isWritable: isFarm },
    { pubkey: SYSVAR_INSTRUCTIONS, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT, isSigner: false, isWritable: false },
    { pubkey: perUser.ownerPda, isSigner: false, isWritable: true },           // 19
    { pubkey: perUser.ownerUsdcAta, isSigner: false, isWritable: true },       // 20
  ];
}

export function buildWithdrawRemainingAccounts(args: {
  market: PublicKey;
  reserveAddr: PublicKey;
  reserve: ParsedReserve;
  perUser: PerUserAccounts;
}): AccountMeta[] {
  const { reserve, perUser } = args;
  const isFarm = perUser.isFarmAttached;
  return [
    { pubkey: args.reserveAddr, isSigner: false, isWritable: true },                         // 0
    { pubkey: perUser.obligation, isSigner: false, isWritable: true },                       // 1
    { pubkey: args.market, isSigner: false, isWritable: false },                             // 2
    { pubkey: lendingMarketAuthorityPda(args.market), isSigner: false, isWritable: false },  // 3
    { pubkey: reserve.collateralReserveDestSupply, isSigner: false, isWritable: true },      // 4
    { pubkey: reserve.collateralMint, isSigner: false, isWritable: true },                   // 5
    { pubkey: reserve.liquiditySupply, isSigner: false, isWritable: true },                  // 6
    { pubkey: perUser.ownerUsdcAta, isSigner: false, isWritable: true },                     // 7
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },                        // 8
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },                        // 9
    { pubkey: SYSVAR_INSTRUCTIONS, isSigner: false, isWritable: false },                     // 10
    { pubkey: reserve.liquidityMint, isSigner: false, isWritable: false },                   // 11
    { pubkey: perUser.ownerPda, isSigner: false, isWritable: true },                         // 12
    { pubkey: reserve.pyth ?? KLEND, isSigner: false, isWritable: false },                   // 13
    { pubkey: reserve.switchboardPrice ?? KLEND, isSigner: false, isWritable: false },       // 14
    { pubkey: reserve.switchboardTwap ?? KLEND, isSigner: false, isWritable: false },        // 15
    { pubkey: reserve.scope ?? KLEND, isSigner: false, isWritable: false },                  // 16
    { pubkey: perUser.obligationFarm, isSigner: false, isWritable: isFarm },                 // 17
    { pubkey: perUser.reserveFarmState, isSigner: false, isWritable: isFarm },               // 18
    { pubkey: FARMS_PROGRAM, isSigner: false, isWritable: false },                           // 19
  ];
}

export function adapterAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('b402/v1'), Buffer.from('adapter')], KAMINO_ADAPTER,
  )[0];
}
