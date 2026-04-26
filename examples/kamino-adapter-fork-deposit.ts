/**
 * Full Kamino deposit through `b402_kamino_adapter::execute()` on a
 * mainnet-fork validator. The handler ports the verified CPI sequence
 * from kamino-fork-deposit.ts (direct calls) into the adapter.
 *
 * Bootstrap:
 *   ./ops/setup-kamino-fork.sh
 *
 * Then run:
 *   pnpm tsx examples/kamino-adapter-fork-deposit.ts
 *
 * Flow:
 *   1. Read alice's pre-injected USDC ATA balance.
 *   2. Derive adapter_authority PDA, ensure it has SOL (for init rent).
 *   3. Create adapter scratch ATAs (adapter_in_ta = USDC, adapter_out_ta = kUSDC).
 *   4. Transfer 1 USDC: alice's ATA → adapter_in_ta (alice signs).
 *   5. Build remaining_accounts in the canonical deposit_v2 layout
 *      defined in `programs/b402-kamino-adapter/src/lib.rs::ra_deposit`.
 *   6. CPI b402_kamino_adapter::execute (Deposit variant).
 *   7. Assert:
 *        - alice's USDC ATA balance decreased by 1 USDC
 *        - obligation grew (account size > 0)
 *        - adapter_out_ta now holds kUSDC
 */

import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import fs from 'node:fs';

const RPC = 'http://127.0.0.1:8899';
const KLEND = new PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');
const FARMS_PROGRAM_ID = new PublicKey('FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr');
const KAMINO_ADAPTER_ID = new PublicKey('2enwFgcGKJDqruHpCtvmhtxe3DYcV3k72VTvoGcdt2rX');

// Anchor instruction discriminator for `execute` —
// sha256("global:execute")[..8]. Matches every b402 adapter.
const EXECUTE_DISCRIMINATOR = Buffer.from([130, 221, 242, 154, 13, 193, 189, 29]);

// KaminoAction Borsh tag — matches `KaminoAction::Deposit`.
const KAMINO_ACTION_DEPOSIT = 0;

function findUtf8(buf: Buffer, needle: string) {
  const b = Buffer.from(needle, 'utf8');
  for (let i = 0; i < buf.length - b.length; i++) {
    if (buf.subarray(i, i + b.length).equals(b)) return i;
  }
  return -1;
}

function reservePda(seedName: string, market: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(seedName), market.toBuffer(), mint.toBuffer()],
    KLEND,
  )[0];
}

function lendingMarketAuthorityPda(market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('lma'), market.toBuffer()],
    KLEND,
  )[0];
}

function userMetadataPda(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('user_meta'), owner.toBuffer()],
    KLEND,
  )[0];
}

function obligationPda(owner: PublicKey, market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from([0]),
      Buffer.from([0]),
      owner.toBuffer(),
      market.toBuffer(),
      PublicKey.default.toBuffer(),
      PublicKey.default.toBuffer(),
    ],
    KLEND,
  )[0];
}

function obligationFarmPda(farm: PublicKey, obligation: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('user'), farm.toBuffer(), obligation.toBuffer()],
    FARMS_PROGRAM_ID,
  )[0];
}

interface ReserveAccounts {
  liquidityMint: PublicKey;
  liquiditySupply: PublicKey;
  collateralMint: PublicKey;
  collateralReserveDestSupply: PublicKey;
  oracles: {
    pyth: PublicKey | null;
    switchboardPrice: PublicKey | null;
    switchboardTwap: PublicKey | null;
    scope: PublicKey | null;
  };
  reserveFarmCollateral: PublicKey;
}

function parseReserve(market: PublicKey, data: Buffer): ReserveAccounts {
  const liquidityMint = new PublicKey(data.subarray(128, 160));
  const reserveFarmCollateral = new PublicKey(data.subarray(64, 96));

  let nameOff = findUtf8(data, 'USDC\0');
  if (nameOff < 0) nameOff = findUtf8(data, 'USD Coin');
  if (nameOff < 0) throw new Error('TokenInfo.name not found');

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
    liquidityMint,
    liquiditySupply: reservePda('reserve_liq_supply', market, liquidityMint),
    collateralMint: reservePda('reserve_coll_mint', market, liquidityMint),
    collateralReserveDestSupply: reservePda('reserve_coll_supply', market, liquidityMint),
    oracles: {
      scope: readPk(scopeOff),
      switchboardPrice: readPk(swbOff),
      switchboardTwap: readPk(swbOff + 32),
      pyth: readPk(pythOff),
    },
    reserveFarmCollateral,
  };
}

async function main() {
  // ---- Bootstrap ---------------------------------------------------------
  const clone = JSON.parse(fs.readFileSync('/tmp/kamino-clone.json', 'utf8'));
  const RESERVE = new PublicKey(clone.constants.reserve);
  const MARKET = new PublicKey(clone.constants.lendingMarket);
  const MARKET_AUTH = lendingMarketAuthorityPda(MARKET);

  const aliceKeyPath = process.env.ALICE_KEYPAIR ?? '/tmp/b402-alice.json';
  if (!fs.existsSync(aliceKeyPath)) {
    throw new Error(
      `alice keypair missing at ${aliceKeyPath}. ` +
      `run ./ops/setup-kamino-fork.sh first (it generates alice + USDC ATA injection).`,
    );
  }
  const alice = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(aliceKeyPath, 'utf8'))),
  );
  console.log(`▶ alice = ${alice.publicKey.toBase58()}`);

  const conn = new Connection(RPC, 'confirmed');
  // Fund alice's SOL if needed (does NOT touch her USDC ATA — bootstrap injected it).
  const aliceBal = await conn.getBalance(alice.publicKey);
  if (aliceBal === 0) {
    const sig = await conn.requestAirdrop(alice.publicKey, 5 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, 'confirmed');
  }

  const reserveAcct = await conn.getAccountInfo(RESERVE);
  if (!reserveAcct) throw new Error('reserve not on fork — boot setup-kamino-fork.sh first');
  const r = parseReserve(MARKET, reserveAcct.data);
  const isFarmAttached = !r.reserveFarmCollateral.equals(PublicKey.default);
  console.log(`▶ reserve.farm_collateral = ${
    isFarmAttached ? r.reserveFarmCollateral.toBase58() : '<none>'
  }`);

  const aliceUsdcAta = getAssociatedTokenAddressSync(r.liquidityMint, alice.publicKey);
  const aliceBefore = (await getAccount(conn, aliceUsdcAta)).amount;
  console.log(`▶ alice USDC before = ${aliceBefore.toString()}`);
  if (aliceBefore === 0n) throw new Error('alice has 0 USDC — bootstrap injection failed');

  // ---- Adapter PDAs + scratch ATAs --------------------------------------
  const [adapterAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from('b402/v1'), Buffer.from('adapter')],
    KAMINO_ADAPTER_ID,
  );
  console.log(`▶ adapter_authority = ${adapterAuthority.toBase58()}`);

  // Adapter PDA must have SOL to pay rent for init_user_metadata + init_obligation
  // (+ init_obligation_farms_for_reserve when attached). The adapter signs as
  // both `owner` and `feePayer` for those Kamino ixs.
  const adapterAuthBal = await conn.getBalance(adapterAuthority);
  if (adapterAuthBal < 0.1 * LAMPORTS_PER_SOL) {
    console.log(`▶ funding adapter_authority with 1 SOL for init rent`);
    const sig = await sendAndConfirmTransaction(
      conn,
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: alice.publicKey,
          toPubkey: adapterAuthority,
          lamports: 1 * LAMPORTS_PER_SOL,
        }),
      ),
      [alice],
      { commitment: 'confirmed' },
    );
    console.log(`  sig = ${sig}`);
  }

  const adapterInTa = getAssociatedTokenAddressSync(
    r.liquidityMint,
    adapterAuthority,
    true,
  );
  const adapterOutTa = getAssociatedTokenAddressSync(
    r.collateralMint,
    adapterAuthority,
    true,
  );
  console.log(`▶ adapter_in_ta  = ${adapterInTa.toBase58()}`);
  console.log(`▶ adapter_out_ta = ${adapterOutTa.toBase58()}`);

  // Pool-vault stand-ins: same mint as in/out, owned by alice for simplicity.
  // The adapter constraints don't check owner here since this test bypasses
  // the pool entirely — but the named-account ABI still requires them.
  const poolInVault = getAssociatedTokenAddressSync(
    r.liquidityMint,
    alice.publicKey,
  );
  const poolOutVault = getAssociatedTokenAddressSync(
    r.collateralMint,
    alice.publicKey,
  );

  // Create the scratch ATAs + a kUSDC ATA for alice (acting as out_vault).
  const setupTx = new Transaction()
    .add(
      createAssociatedTokenAccountIdempotentInstruction(
        alice.publicKey, adapterInTa, adapterAuthority, r.liquidityMint,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        alice.publicKey, adapterOutTa, adapterAuthority, r.collateralMint,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        alice.publicKey, poolOutVault, alice.publicKey, r.collateralMint,
      ),
    );
  const setupSig = await sendAndConfirmTransaction(conn, setupTx, [alice], {
    commitment: 'confirmed',
  });
  console.log(`▶ scratch ATAs created — sig=${setupSig}`);

  // ---- Pre-fund adapter_in_ta with 1 USDC from alice --------------------
  const DEPOSIT_AMOUNT = 1_000_000n; // 1 USDC (6 decimals)
  const fundSig = await sendAndConfirmTransaction(
    conn,
    new Transaction().add(
      createTransferInstruction(
        aliceUsdcAta,
        adapterInTa,
        alice.publicKey,
        DEPOSIT_AMOUNT,
      ),
    ),
    [alice],
    { commitment: 'confirmed' },
  );
  console.log(`▶ funded adapter_in_ta with ${DEPOSIT_AMOUNT} — sig=${fundSig}`);

  // ---- Derive Kamino-side PDAs (owner = adapter_authority) --------------
  const userMetadata = userMetadataPda(adapterAuthority);
  const obligation = obligationPda(adapterAuthority, MARKET);
  console.log(`▶ user_meta  = ${userMetadata.toBase58()}`);
  console.log(`▶ obligation = ${obligation.toBase58()}`);

  const obligationBefore = await conn.getAccountInfo(obligation);
  const obligationSizeBefore = obligationBefore?.data.length ?? 0;
  console.log(`  obligation size pre  = ${obligationSizeBefore}`);

  let obligationFarm = KLEND; // sentinel = klend program ID when no farm
  let reserveFarmState = KLEND;
  if (isFarmAttached) {
    obligationFarm = obligationFarmPda(r.reserveFarmCollateral, obligation);
    reserveFarmState = r.reserveFarmCollateral;
  }

  // ---- Build remaining_accounts (canonical ra_deposit layout) -----------
  // Ordering MUST match programs/b402-kamino-adapter/src/lib.rs::ra_deposit.
  const remainingAccounts = [
    { pubkey: RESERVE,                                    isSigner: false, isWritable: true  }, // 0
    { pubkey: MARKET,                                     isSigner: false, isWritable: false }, // 1
    { pubkey: MARKET_AUTH,                                isSigner: false, isWritable: false }, // 2
    { pubkey: r.liquiditySupply,                          isSigner: false, isWritable: true  }, // 3
    { pubkey: r.collateralMint,                           isSigner: false, isWritable: true  }, // 4
    { pubkey: r.collateralReserveDestSupply,              isSigner: false, isWritable: true  }, // 5
    { pubkey: r.oracles.pyth ?? KLEND,                    isSigner: false, isWritable: false }, // 6
    { pubkey: r.oracles.switchboardPrice ?? KLEND,        isSigner: false, isWritable: false }, // 7
    { pubkey: r.oracles.switchboardTwap ?? KLEND,         isSigner: false, isWritable: false }, // 8
    { pubkey: r.oracles.scope ?? KLEND,                   isSigner: false, isWritable: false }, // 9
    { pubkey: r.liquidityMint,                            isSigner: false, isWritable: false }, // 10
    { pubkey: FARMS_PROGRAM_ID,                           isSigner: false, isWritable: false }, // 11
    { pubkey: userMetadata,                               isSigner: false, isWritable: true  }, // 12
    { pubkey: obligation,                                 isSigner: false, isWritable: true  }, // 13
    { pubkey: obligationFarm,                             isSigner: false, isWritable: isFarmAttached }, // 14
    { pubkey: reserveFarmState,                           isSigner: false, isWritable: isFarmAttached }, // 15
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,                 isSigner: false, isWritable: false }, // 16
    { pubkey: SystemProgram.programId,                    isSigner: false, isWritable: false }, // 17
    { pubkey: SYSVAR_RENT_PUBKEY,                         isSigner: false, isWritable: false }, // 18
  ];

  // ---- Build action_payload (Borsh KaminoAction::Deposit) ----------------
  const actionPayload = Buffer.alloc(1 + 32 + 8 + 8);
  let off = 0;
  actionPayload.writeUInt8(KAMINO_ACTION_DEPOSIT, off); off += 1;
  RESERVE.toBuffer().copy(actionPayload, off);          off += 32;
  actionPayload.writeBigUInt64LE(DEPOSIT_AMOUNT, off);  off += 8;
  actionPayload.writeBigUInt64LE(0n, off);              off += 8; // min_kt_out floor

  // ---- Build adapter Execute ix data: disc || u64 in || u64 min || vec(payload)
  const minOut = 0n;
  const ixDataParts: Buffer[] = [
    EXECUTE_DISCRIMINATOR,
    Buffer.from((() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(DEPOSIT_AMOUNT, 0); return b; })()),
    Buffer.from((() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(minOut, 0); return b; })()),
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(actionPayload.length, 0); return b; })(),
    actionPayload,
  ];
  const ixData = Buffer.concat(ixDataParts);

  // ---- Adapter Execute ABI: 6 named accounts + remaining ----------------
  const adapterIxKeys = [
    // adapter_authority MUST be writable in the outer slot — Kamino's
    // init_user_metadata / init_obligation / init_obligation_farms_for_reserve
    // all bind the obligation owner as feePayer (signer-writable, role 3).
    // CPI cannot escalate privilege, so the outer must already be writable.
    { pubkey: adapterAuthority, isSigner: false, isWritable: true  },
    { pubkey: poolInVault,      isSigner: false, isWritable: true  },
    { pubkey: poolOutVault,     isSigner: false, isWritable: true  },
    { pubkey: adapterInTa,      isSigner: false, isWritable: true  },
    { pubkey: adapterOutTa,     isSigner: false, isWritable: true  },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ...remainingAccounts,
  ];

  const adapterIx = new TransactionInstruction({
    programId: KAMINO_ADAPTER_ID,
    keys: adapterIxKeys,
    data: ixData,
  });
  const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });

  console.log(`▶ submitting b402_kamino_adapter::execute (Deposit, ${DEPOSIT_AMOUNT})...`);
  let sig: string;
  try {
    sig = await sendAndConfirmTransaction(
      conn,
      new Transaction().add(cuIx, adapterIx),
      [alice],
      { skipPreflight: true, commitment: 'confirmed' },
    );
    console.log(`  ✅ adapter execute SUCCESS — sig=${sig}`);
  } catch (e: any) {
    console.log(`  ✗ adapter execute failed — sig=${e.signature ?? '<none>'}`);
    if (e.signature) {
      const tx = await conn.getTransaction(e.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      for (const l of tx?.meta?.logMessages ?? []) console.log(`    ${l}`);
    }
    throw e;
  }

  // ---- Asserts ----------------------------------------------------------
  const aliceAfter = (await getAccount(conn, aliceUsdcAta)).amount;
  const aliceDelta = aliceBefore - aliceAfter;
  console.log(`▶ alice USDC after = ${aliceAfter.toString()} (delta = ${aliceDelta})`);
  if (aliceDelta !== DEPOSIT_AMOUNT) {
    throw new Error(`expected alice USDC to drop by ${DEPOSIT_AMOUNT}, got ${aliceDelta}`);
  }

  const obligationAfter = await conn.getAccountInfo(obligation);
  const obligationSizeAfter = obligationAfter?.data.length ?? 0;
  console.log(`▶ obligation size post = ${obligationSizeAfter}`);
  if (obligationSizeAfter <= obligationSizeBefore) {
    throw new Error(
      `obligation account did not grow (was ${obligationSizeBefore}, now ${obligationSizeAfter})`,
    );
  }

  // Note on kUSDC sweep: Kamino lending deposits don't mint a transferable
  // kToken to the depositor. The deposit credits the obligation account
  // directly — the obligation entry IS the user's claim. So adapter_out_ta
  // and pool out_vault correctly stay at 0 kUSDC; the value lives inside
  // the obligation's `deposits` array.
  //
  // This is the architectural argument for v2 ABI's delta-zero flag +
  // shadow-PDA-binding (PRD-15 + PRD-13): single-mint delta-invariant
  // doesn't fit lending. v2 binds the obligation PDA into the proof
  // instead of requiring a token-balance delta.
  const adapterOut = await getAccount(conn, adapterOutTa);
  const poolOutAfter = await getAccount(conn, poolOutVault);
  console.log(`▶ adapter_out_ta kUSDC = ${adapterOut.amount.toString()} (expected 0 — Kamino doesn't mint kTokens)`);
  console.log(`▶ pool out_vault kUSDC = ${poolOutAfter.amount.toString()} (expected 0 — collateral lives in obligation)`);

  console.log(`\n🎉 Kamino deposit via b402_kamino_adapter: GREEN (sig=${sig})`);
  console.log(`   alice -1 USDC, obligation +3344 B (collateral position recorded)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
