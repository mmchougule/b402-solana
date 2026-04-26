/**
 * Full Kamino deposit on mainnet-fork — direct calls to Kamino with the
 * exact account lists from @kamino-finance/klend-sdk@7.3.22.
 *
 * Once this is green, the same CPI sequence wires into b402_kamino_adapter.
 *
 * Flow:
 *   1. Read alice's USDC balance (pre-injected via --account in the fork
 *      bootstrapper). Confirm it's > 0.
 *   2. Init UserMetadata (Kamino's per-user metadata account).
 *   3. Init Obligation (Vanilla type — tag=0, id=0).
 *   4. Refresh reserve (already verified standalone).
 *   5. Deposit liquidity + create obligation collateral.
 *   6. Read alice's kUSDC balance. Confirm > 0.
 *
 * Pre-conditions before running:
 *   - Fork bootstrap script must:
 *     - Inject alice's USDC ATA with 100 USDC via --account
 *     - --warp-slot above cloned reserve last_update slot
 *     - --clone /tmp/kamino-clone.json
 */

import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey,
  Transaction, TransactionInstruction, sendAndConfirmTransaction,
  SystemProgram, LAMPORTS_PER_SOL, SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_RENT_PUBKEY,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, getAccount,
  createAssociatedTokenAccountIdempotentInstruction, ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import fs from 'node:fs';
import path from 'node:path';

const RPC = 'http://127.0.0.1:8899';
const KLEND = new PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');

// Discriminators verified against klend-sdk DISCRIMINATOR consts (2026-04-26).
const DISC_INIT_USER_METADATA = Buffer.from([117, 169, 176, 69, 197, 23, 15, 162]); // sha256("global:init_user_metadata")[..8]
const DISC_INIT_OBLIGATION    = Buffer.from([251, 10, 231, 76, 27, 11, 159, 96]);
const DISC_REFRESH_RESERVE    = Buffer.from([2, 218, 138, 235, 79, 201, 25, 102]);
const DISC_REFRESH_OBLIGATION = Buffer.from([33, 132, 147, 228, 151, 192, 72, 89]);
const DISC_DEPOSIT_RLOC       = Buffer.from([129, 199, 4, 2, 222, 39, 26, 46]);
// v2 ix takes farm accounts inline so no preceding refresh_farms_for_obligation_for_reserve required.
const DISC_DEPOSIT_RLOC_V2    = Buffer.from([216, 224, 191, 27, 204, 151, 102, 175]);
const DISC_INIT_OBL_FARMS     = Buffer.from([136, 63, 15, 186, 211, 152, 168, 164]);
const FARMS_PROGRAM_ID = new PublicKey('FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr');

function obligationFarmPda(farm: PublicKey, obligation: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('user'), farm.toBuffer(), obligation.toBuffer()],
    FARMS_PROGRAM_ID,
  )[0];
}

// Reserve struct offsets — reserved for parsing oracles + collateral mint /
// supply vault. See kamino-fork-direct-probe.ts for layout commentary.
function findUtf8(buf: Buffer, needle: string) {
  const b = Buffer.from(needle, 'utf8');
  for (let i = 0; i < buf.length - b.length; i++) {
    if (buf.subarray(i, i + b.length).equals(b)) return i;
  }
  return -1;
}

interface ReserveAccounts {
  reserve: PublicKey;
  liquidityMint: PublicKey;
  liquiditySupply: PublicKey;        // Kamino's USDC vault — PDA([reserve_liq_supply, market, mint])
  collateralMint: PublicKey;          // kUSDC mint — PDA([reserve_coll_mint, market, mint])
  collateralReserveDestSupply: PublicKey; // Kamino's collateral vault — PDA([reserve_coll_supply, market, mint])
  oracles: {
    pyth: PublicKey | null;
    switchboardPrice: PublicKey | null;
    switchboardTwap: PublicKey | null;
    scope: PublicKey | null;
  };
}

function reservePda(seedName: string, market: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(seedName), market.toBuffer(), mint.toBuffer()],
    KLEND,
  )[0];
}

function parseReserve(reserveAddr: PublicKey, market: PublicKey, data: Buffer): ReserveAccounts {
  // Reserve struct (klend master, offsets validated 2026-04-26):
  //   0..8:    discriminator
  //   8..16:   version (u64)
  //   16..32:  last_update (slot u64 + stale u8 + padding)
  //   32..64:  lending_market
  //   64..96:  farm_collateral
  //   96..128: farm_debt
  //   128..:   ReserveLiquidity
  //
  // ReserveLiquidity prefix:
  //   0..32:   mint_pubkey (liquidity mint)
  //   32..40:  mint_decimals (u8 + 7 padding)
  //   40..72:  supply_vault
  //   72..104: fee_vault
  //   ...
  //
  // Fields between fee_vault and `token_info` are u128/u64 numbers we
  // skip by locating the TokenInfo struct via its name string.
  // Reserve struct: disc(8) + version(8) + last_update(16) + lending_market(32)
  //                + farm_collateral(32) + farm_debt(32) = 128 bytes prefix
  // Then ReserveLiquidity:
  //   mint_pubkey(32) + supply_vault(32) + fee_vault(32) + ...
  const liquidityMint = new PublicKey(data.subarray(128, 160));
  const liquiditySupply = reservePda('reserve_liq_supply', market, liquidityMint);
  const collateralMint = reservePda('reserve_coll_mint',   market, liquidityMint);
  const collateralReserveDestSupply = reservePda('reserve_coll_supply', market, liquidityMint);

  // Find TokenInfo by name string — used to locate oracle pubkeys.
  let nameOff = findUtf8(data, 'USDC\0');
  if (nameOff < 0) nameOff = findUtf8(data, 'USD Coin');
  if (nameOff < 0) throw new Error('TokenInfo.name not found in reserve data');

  const tokenInfoOff = nameOff;
  const scopeOff = tokenInfoOff + 32 + 24 + 24;
  const swbOff = scopeOff + 52;
  const pythOff = swbOff + 68;
  const def = PublicKey.default;
  const readPk = (off: number) => {
    const pk = new PublicKey(data.subarray(off, off + 32));
    return pk.equals(def) ? null : pk;
  };

  return {
    reserve: reserveAddr,
    liquidityMint,
    liquiditySupply,
    collateralMint,
    collateralReserveDestSupply,
    oracles: {
      scope: readPk(scopeOff),
      switchboardPrice: readPk(swbOff),
      switchboardTwap: readPk(swbOff + 32),
      pyth: readPk(pythOff),
    },
  };
}

function obligationPda(user: PublicKey, market: PublicKey): PublicKey {
  // VanillaObligation seeds: [tag=0, id=0, user, market, default, default]
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from([0]),
      Buffer.from([0]),
      user.toBuffer(),
      market.toBuffer(),
      PublicKey.default.toBuffer(),
      PublicKey.default.toBuffer(),
    ],
    KLEND,
  )[0];
}

function userMetadataPda(user: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('user_meta'), user.toBuffer()],
    KLEND,
  )[0];
}

function lendingMarketAuthorityPda(market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('lma'), market.toBuffer()],
    KLEND,
  )[0];
}

async function main() {
  const clone = JSON.parse(fs.readFileSync('/tmp/kamino-clone.json', 'utf8'));
  const RESERVE = new PublicKey(clone.constants.reserve);
  const MARKET = new PublicKey(clone.constants.lendingMarket);
  const MARKET_AUTH = lendingMarketAuthorityPda(MARKET);

  // Alice — read keypair from disk so the fork bootstrap matches.
  const aliceKeyPath = process.env.ALICE_KEYPAIR ?? '/tmp/b402-alice.json';
  if (!fs.existsSync(aliceKeyPath)) {
    throw new Error(
      `alice keypair missing at ${aliceKeyPath}. ` +
      `run scripts/setup-kamino-fork.sh first (it generates alice + USDC ATA injection).`,
    );
  }
  const alice = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(aliceKeyPath, 'utf8'))));
  console.log(`▶ alice = ${alice.publicKey.toBase58()}`);

  const conn = new Connection(RPC, 'confirmed');
  const aliceBal = await conn.getBalance(alice.publicKey);
  if (aliceBal === 0) {
    const sig = await conn.requestAirdrop(alice.publicKey, 5 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, 'confirmed');
  }

  // Read the cloned reserve to extract every account we'll need.
  const reserveAcct = await conn.getAccountInfo(RESERVE);
  if (!reserveAcct) throw new Error('reserve not on fork — did you boot --clone /tmp/kamino-clone.json?');
  const r = parseReserve(RESERVE, MARKET, reserveAcct.data);
  console.log(`▶ reserve parsed:`);
  console.log(`    liquidity_mint    = ${r.liquidityMint.toBase58()}  (USDC)`);
  console.log(`    liquidity_supply  = ${r.liquiditySupply.toBase58()}  (Kamino USDC vault)`);
  console.log(`    collateral_mint   = ${r.collateralMint.toBase58()}  (kUSDC)`);
  console.log(`    coll_dest_supply  = ${r.collateralReserveDestSupply.toBase58()}`);
  console.log(`    scope_oracle      = ${r.oracles.scope?.toBase58() ?? '<none>'}`);

  const aliceUsdcAta = getAssociatedTokenAddressSync(r.liquidityMint, alice.publicKey);
  console.log(`▶ alice USDC ATA  = ${aliceUsdcAta.toBase58()}`);

  // Step 0: confirm alice's USDC ATA was injected with balance.
  try {
    const a = await getAccount(conn, aliceUsdcAta);
    console.log(`  alice USDC balance = ${a.amount.toString()}`);
    if (a.amount === 0n) throw new Error('alice has 0 USDC — run setup-kamino-fork.sh injection');
  } catch (e: any) {
    if (e.name === 'TokenAccountNotFoundError') {
      throw new Error(`alice USDC ATA missing — bootstrap injection failed`);
    }
    throw e;
  }

  // PDAs
  const userMeta = userMetadataPda(alice.publicKey);
  const obligation = obligationPda(alice.publicKey, MARKET);
  console.log(`▶ user_meta  PDA = ${userMeta.toBase58()}`);
  console.log(`▶ obligation PDA = ${obligation.toBase58()}`);

  // Step 1: init_user_metadata if not already.
  const umAcct = await conn.getAccountInfo(userMeta);
  if (!umAcct) {
    console.log(`▶ creating user_metadata...`);
    // init_user_metadata args: user_lookup_table: Pubkey
    // accounts: owner(signer), feePayer(signer), userMetadata, referrer_user_metadata?(opt),
    //           rent, systemProgram
    // Simplified: pass alice as owner+feePayer, no referrer.
    const ix = new TransactionInstruction({
      programId: KLEND,
      keys: [
        { pubkey: alice.publicKey,           isSigner: true,  isWritable: true  },  // owner
        { pubkey: alice.publicKey,           isSigner: true,  isWritable: true  },  // feePayer
        { pubkey: userMeta,                  isSigner: false, isWritable: true  },
        { pubkey: KLEND,                     isSigner: false, isWritable: false },  // referrer_user_metadata = None
        { pubkey: SYSVAR_RENT_PUBKEY,        isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId,   isSigner: false, isWritable: false },
      ],
      // user_lookup_table arg: 32 zeros (no LUT)
      data: Buffer.concat([DISC_INIT_USER_METADATA, Buffer.alloc(32)]),
    });
    const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
    try {
      const sig = await sendAndConfirmTransaction(
        conn, new Transaction().add(cuIx, ix), [alice], { skipPreflight: true, commitment: 'confirmed' },
      );
      console.log(`  ✓ user_metadata initialized — sig=${sig}`);
    } catch (e: any) {
      console.log(`  ✗ init_user_metadata failed`);
      const tx = await conn.getTransaction(e.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
      for (const l of tx?.meta?.logMessages ?? []) console.log(`    ${l}`);
      throw e;
    }
  } else {
    console.log(`▶ user_metadata already exists`);
  }

  // Step 2: init_obligation
  const obAcct = await conn.getAccountInfo(obligation);
  if (!obAcct) {
    console.log(`▶ creating obligation (Vanilla, tag=0, id=0)...`);
    const ix = new TransactionInstruction({
      programId: KLEND,
      keys: [
        { pubkey: alice.publicKey,           isSigner: true,  isWritable: true  }, // obligationOwner
        { pubkey: alice.publicKey,           isSigner: true,  isWritable: true  }, // feePayer
        { pubkey: obligation,                isSigner: false, isWritable: true  },
        { pubkey: MARKET,                    isSigner: false, isWritable: false },
        { pubkey: PublicKey.default,         isSigner: false, isWritable: false }, // seed1Account = default
        { pubkey: PublicKey.default,         isSigner: false, isWritable: false }, // seed2Account = default
        { pubkey: userMeta,                  isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY,        isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId,   isSigner: false, isWritable: false },
      ],
      // InitObligationArgs: tag(u8) + id(u8)
      data: Buffer.concat([DISC_INIT_OBLIGATION, Buffer.from([0, 0])]),
    });
    const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
    try {
      const sig = await sendAndConfirmTransaction(
        conn, new Transaction().add(cuIx, ix), [alice], { skipPreflight: true, commitment: 'confirmed' },
      );
      console.log(`  ✓ obligation initialized — sig=${sig}`);
    } catch (e: any) {
      console.log(`  ✗ init_obligation failed`);
      const tx = await conn.getTransaction(e.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
      for (const l of tx?.meta?.logMessages ?? []) console.log(`    ${l}`);
      throw e;
    }
  } else {
    console.log(`▶ obligation already exists`);
  }

  // Step 3: enroll the obligation in the reserve's collateral farm.
  // Reserve.farm_collateral is at offset 64..96 of the account data. If
  // non-zero, this reserve has a collateral farm and the obligation must
  // be enrolled before deposit_v2 will accept it.
  const reserveFarmCollateral = new PublicKey(reserveAcct.data.subarray(64, 96));
  const isFarmAttached = !reserveFarmCollateral.equals(PublicKey.default);
  let obligationFarm = PublicKey.default;
  if (isFarmAttached) {
    obligationFarm = obligationFarmPda(reserveFarmCollateral, obligation);
    const ofAcct = await conn.getAccountInfo(obligationFarm);
    if (!ofAcct) {
      console.log(`▶ enrolling obligation in collateral farm ${reserveFarmCollateral.toBase58().slice(0, 12)}...`);
      // mode: u8 — 0 = collateral, 1 = debt
      const ix = new TransactionInstruction({
        programId: KLEND,
        keys: [
          { pubkey: alice.publicKey,           isSigner: true,  isWritable: true  }, // payer
          { pubkey: alice.publicKey,           isSigner: false, isWritable: false }, // owner
          { pubkey: obligation,                isSigner: false, isWritable: true  },
          { pubkey: MARKET_AUTH,               isSigner: false, isWritable: false },
          { pubkey: RESERVE,                   isSigner: false, isWritable: true  },
          { pubkey: reserveFarmCollateral,     isSigner: false, isWritable: true  },
          { pubkey: obligationFarm,            isSigner: false, isWritable: true  },
          { pubkey: MARKET,                    isSigner: false, isWritable: false },
          { pubkey: FARMS_PROGRAM_ID,          isSigner: false, isWritable: false },
          { pubkey: SYSVAR_RENT_PUBKEY,        isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId,   isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([DISC_INIT_OBL_FARMS, Buffer.from([0])]), // mode = 0 (collateral)
      });
      const cuIx0 = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
      try {
        const sig = await sendAndConfirmTransaction(
          conn, new Transaction().add(cuIx0, ix), [alice], { skipPreflight: true, commitment: 'confirmed' },
        );
        console.log(`  ✓ obligation enrolled in farm — sig=${sig}`);
      } catch (e: any) {
        console.log(`  ✗ init_obligation_farms_for_reserve failed`);
        const tx = await conn.getTransaction(e.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
        for (const l of tx?.meta?.logMessages ?? []) console.log(`    ${l}`);
        throw e;
      }
    } else {
      console.log(`▶ obligation already enrolled in farm`);
    }
  }

  // Step 4: deposit_reserve_liquidity_and_obligation_collateral
  // Includes a refresh_reserve + refresh_obligation in the same tx (Kamino requires
  // these to be ordered correctly).
  const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 });

  const refreshReserveIx = new TransactionInstruction({
    programId: KLEND,
    keys: [
      { pubkey: RESERVE,                                    isSigner: false, isWritable: true  },
      { pubkey: MARKET,                                     isSigner: false, isWritable: false },
      { pubkey: r.oracles.pyth ?? KLEND,                    isSigner: false, isWritable: false },
      { pubkey: r.oracles.switchboardPrice ?? KLEND,        isSigner: false, isWritable: false },
      { pubkey: r.oracles.switchboardTwap ?? KLEND,         isSigner: false, isWritable: false },
      { pubkey: r.oracles.scope ?? KLEND,                   isSigner: false, isWritable: false },
    ],
    data: DISC_REFRESH_RESERVE,
  });

  const refreshObligationIx = new TransactionInstruction({
    programId: KLEND,
    keys: [
      { pubkey: MARKET,     isSigner: false, isWritable: false },
      { pubkey: obligation, isSigner: false, isWritable: true  },
    ],
    data: DISC_REFRESH_OBLIGATION,
  });

  const DEPOSIT_AMOUNT = 1_000_000n;  // 1 USDC (6 decimals)

  // v2 deposit ix bakes the farms accounts into the ix and removes the
  // preceding-ix sequence requirement that the v1 form has. Pass `None`
  // (sentinel = klend program ID) for both farm accounts since alice's
  // obligation is fresh and not yet enrolled in the reserve's farm.
  const depositIx = new TransactionInstruction({
    programId: KLEND,
    keys: [
      { pubkey: alice.publicKey,                  isSigner: true,  isWritable: true  }, // owner
      { pubkey: obligation,                       isSigner: false, isWritable: true  },
      { pubkey: MARKET,                           isSigner: false, isWritable: false },
      { pubkey: MARKET_AUTH,                      isSigner: false, isWritable: false },
      { pubkey: RESERVE,                          isSigner: false, isWritable: true  },
      { pubkey: r.liquidityMint,                  isSigner: false, isWritable: false },
      { pubkey: r.liquiditySupply,                isSigner: false, isWritable: true  },
      { pubkey: r.collateralMint,                 isSigner: false, isWritable: true  },
      { pubkey: r.collateralReserveDestSupply,    isSigner: false, isWritable: true  },
      { pubkey: aliceUsdcAta,                     isSigner: false, isWritable: true  },
      { pubkey: KLEND,                            isSigner: false, isWritable: false }, // placeholderUserDestColl
      { pubkey: TOKEN_PROGRAM_ID,                 isSigner: false, isWritable: false }, // collateral_token_program
      { pubkey: TOKEN_PROGRAM_ID,                 isSigner: false, isWritable: false }, // liquidity_token_program
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,       isSigner: false, isWritable: false },
      { pubkey: isFarmAttached ? obligationFarm : KLEND,           isSigner: false, isWritable: isFarmAttached },
      { pubkey: isFarmAttached ? reserveFarmCollateral : KLEND,    isSigner: false, isWritable: isFarmAttached },
      { pubkey: FARMS_PROGRAM_ID,                 isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      DISC_DEPOSIT_RLOC_V2,
      (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(DEPOSIT_AMOUNT, 0); return b; })(),
    ]),
  });

  console.log(`▶ submitting refresh+refresh+deposit_v2 (1 USDC)...`);
  try {
    const sig = await sendAndConfirmTransaction(
      conn,
      new Transaction().add(cuIx, refreshReserveIx, refreshObligationIx, depositIx),
      [alice],
      { skipPreflight: true, commitment: 'confirmed' },
    );
    console.log(`  ✅ deposit SUCCESS — sig=${sig}`);

    const after = await getAccount(conn, aliceUsdcAta);
    console.log(`▶ alice USDC after = ${after.amount.toString()} (was ${DEPOSIT_AMOUNT + after.amount})`);
    console.log(`▶ obligation account size after =`, (await conn.getAccountInfo(obligation))?.data.length);
    console.log(`\n🎉 Kamino deposit on mainnet-fork: GREEN`);
  } catch (e: any) {
    console.log(`  ✗ deposit failed — sig=${e.signature ?? '<no sig>'}`);
    const tx = await conn.getTransaction(e.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    for (const l of tx?.meta?.logMessages ?? []) console.log(`    ${l}`);
    throw e;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
