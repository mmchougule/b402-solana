import {
  Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
  ComputeBudgetProgram, SystemProgram, SYSVAR_CLOCK_PUBKEY,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount, createMintToInstruction,
} from '@solana/spl-token';
import fs from 'node:fs';
import os from 'node:os';

const CLI_ROOT = `${os.homedir()}/development/ai/percolator-cli`;

async function main() {
  const { encodeInitMarket, encodeKeeperCrank, encodeTopUpInsurance, encodeInitLP } =
    await import(`${CLI_ROOT}/dist-tsc/abi/instructions.js`);
  const {
    ACCOUNTS_INIT_MARKET, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_TOPUP_INSURANCE,
    ACCOUNTS_INIT_LP, buildAccountMetas,
  } = await import(`${CLI_ROOT}/dist-tsc/abi/accounts.js`);
  const { deriveVaultAuthority, deriveLpPda } = await import(`${CLI_ROOT}/dist-tsc/solana/pda.js`);
  const { buildIx } = await import(`${CLI_ROOT}/dist-tsc/runtime/tx.js`);

  // Override via env so the same script works across localnet/devnet/mainnet:
  //   RPC                  RPC URL (default localhost)
  //   PERCOLATOR_PROG_ID   percolator-prog deployment to bind this market to
  //   MATCHER_PROG_ID      matcher-prog deployment for the LP's matcher_context
  //   MINT_KEYPAIR_PATH    keypair file for the collateral mint
  //   PERCOLATOR_ADAPTER   b402 adapter pubkey (rarely overridden)
  //   OUTPUT_PATH          where to write the market.json (default /tmp/percolator-market.json)
  const PERCOLATOR_PROG = new PublicKey(process.env.PERCOLATOR_PROG_ID
    ?? 'DzLTTqyx7tFjwseeDTnu4f6c55H5abPgcohRVkNCS4Bn');
  const MATCHER_PROG = new PublicKey(process.env.MATCHER_PROG_ID
    ?? 'BoYEMRSe6cRw6jswHtApQVqjLf1PPakfuuDyxgWijYBU');
  const PERCOLATOR_ADAPTER = new PublicKey(process.env.PERCOLATOR_ADAPTER
    ?? '65NRt6GpeakqXhqvKcN3knohzKEZT37arUyQi3SZwfxv');
  const SLAB_SIZE = 1_755_376;
  const MATCHER_CTX_SIZE = 320;
  const RPC = process.env.RPC ?? 'http://127.0.0.1:8899';
  const conn = new Connection(RPC, 'confirmed');
  const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
    fs.readFileSync(`${os.homedir()}/.config/solana/id.json`, 'utf8'))));
  const MINT_KEYPAIR_PATH = process.env.MINT_KEYPAIR_PATH
    ?? '/tmp/local-mint-keypair.json';
  const mintKp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
    fs.readFileSync(MINT_KEYPAIR_PATH, 'utf8'))));
  const mint = mintKp.publicKey;
  const OUTPUT_PATH = process.env.OUTPUT_PATH ?? '/tmp/percolator-market.json';
  console.log(`init-percolator-market on ${RPC}`);
  console.log(`  percolator: ${PERCOLATOR_PROG.toBase58()}`);
  console.log(`  matcher   : ${MATCHER_PROG.toBase58()}`);
  console.log(`  mint      : ${mint.toBase58()}`);
  console.log(`  output    : ${OUTPUT_PATH}`);
  const cuLimit = (units: number) => ComputeBudgetProgram.setComputeUnitLimit({ units });

  // 1. Slab
  const slab = Keypair.generate();
  const rentSlab = await conn.getMinimumBalanceForRentExemption(SLAB_SIZE);
  console.log(`slab=${slab.publicKey.toBase58()} rent=${rentSlab}`);
  await sendAndConfirmTransaction(conn,
    new Transaction()
      .add(cuLimit(100_000))
      .add(SystemProgram.createAccount({
        fromPubkey: payer.publicKey, newAccountPubkey: slab.publicKey,
        lamports: rentSlab, space: SLAB_SIZE, programId: PERCOLATOR_PROG,
      })),
    [payer, slab], { commitment: 'confirmed' });

  // 2. Vault
  const [vaultPda] = deriveVaultAuthority(PERCOLATOR_PROG, slab.publicKey);
  const vaultAta = await getOrCreateAssociatedTokenAccount(conn, payer, mint, vaultPda, true);
  console.log(`vault_pda=${vaultPda.toBase58()} vault=${vaultAta.address.toBase58()}`);

  // 3. InitMarket
  const { defaultInitMarketArgs } = await import(`${CLI_ROOT}/scripts/_default-market.ts`);
  const initMarketData = encodeInitMarket(defaultInitMarketArgs(payer.publicKey, mint));
  await sendAndConfirmTransaction(conn,
    new Transaction()
      .add(cuLimit(1_400_000))
      .add(buildIx({
        programId: PERCOLATOR_PROG,
        keys: buildAccountMetas(ACCOUNTS_INIT_MARKET, [
          payer.publicKey, slab.publicKey, mint, vaultAta.address,
          SYSVAR_CLOCK_PUBKEY, slab.publicKey,
        ]),
        data: initMarketData,
      })),
    [payer], { commitment: 'confirmed' });
  console.log('▶ InitMarket ✓');

  // 4. Initial KeeperCrank (Hyperp dummy oracle = slab)
  const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
  await sendAndConfirmTransaction(conn,
    new Transaction()
      .add(cuLimit(400_000))
      .add(buildIx({
        programId: PERCOLATOR_PROG,
        keys: buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
          payer.publicKey, slab.publicKey, SYSVAR_CLOCK_PUBKEY, slab.publicKey,
        ]),
        data: crankData,
      })),
    [payer], { commitment: 'confirmed', skipPreflight: true });
  console.log('▶ KeeperCrank ✓');

  // 5. Mint admin tokens (we own the local mint authority).
  const adminAta = await getOrCreateAssociatedTokenAccount(conn, payer, mint, payer.publicKey);
  await sendAndConfirmTransaction(conn,
    new Transaction()
      .add(cuLimit(50_000))
      .add(createMintToInstruction(mint, adminAta.address, payer.publicKey, 1_000_000_000_000n)),
    [payer], { commitment: 'confirmed' });
  console.log(`▶ minted 1,000,000 tokens (6dp) to admin ATA ${adminAta.address.toBase58()}`);

  // 6. TopUpInsurance
  await sendAndConfirmTransaction(conn,
    new Transaction()
      .add(cuLimit(100_000))
      .add(buildIx({
        programId: PERCOLATOR_PROG,
        keys: buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, [
          payer.publicKey, slab.publicKey, adminAta.address,
          vaultAta.address, TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY,
        ]),
        data: encodeTopUpInsurance({ amount: '50000000' }), // 50 tokens
      })),
    [payer], { commitment: 'confirmed' });
  console.log('▶ TopUpInsurance 50 tokens ✓');

  // 7. Matcher context account (320B, owned by matcher)
  const matcherCtx = Keypair.generate();
  const matcherRent = await conn.getMinimumBalanceForRentExemption(MATCHER_CTX_SIZE);
  await sendAndConfirmTransaction(conn,
    new Transaction()
      .add(cuLimit(100_000))
      .add(SystemProgram.createAccount({
        fromPubkey: payer.publicKey, newAccountPubkey: matcherCtx.publicKey,
        lamports: matcherRent, space: MATCHER_CTX_SIZE, programId: MATCHER_PROG,
      })),
    [payer, matcherCtx], { commitment: 'confirmed' });
  console.log(`▶ matcher_ctx=${matcherCtx.publicKey.toBase58()}`);

  // 8. InitLP
  await sendAndConfirmTransaction(conn,
    new Transaction()
      .add(cuLimit(400_000))
      .add(buildIx({
        programId: PERCOLATOR_PROG,
        keys: buildAccountMetas(ACCOUNTS_INIT_LP, [
          payer.publicKey, slab.publicKey, adminAta.address,
          vaultAta.address, TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY,
        ]),
        data: encodeInitLP({
          matcherProgram: MATCHER_PROG, matcherContext: matcherCtx.publicKey,
          feePayment: '1000000',
        }),
      })),
    [payer], { commitment: 'confirmed' });
  console.log('▶ InitLP ✓');

  // 9. Find LP idx (passive matchers usually land at slot 0).
  const { fetchSlab, parseUsedIndices, parseAccount, AccountKind } =
    await import(`${CLI_ROOT}/src/solana/slab.ts`);
  const slabData = await fetchSlab(conn, slab.publicKey);
  let lpIdx = -1;
  for (const idx of parseUsedIndices(slabData)) {
    const acc = parseAccount(slabData, idx);
    if (acc && acc.kind === AccountKind.LP) { lpIdx = idx; break; }
  }
  if (lpIdx < 0) throw new Error('no LP found in slab after InitLP');
  const [lpPda] = deriveLpPda(PERCOLATOR_PROG, slab.publicKey, lpIdx);
  console.log(`▶ lp_idx=${lpIdx} lp_pda=${lpPda.toBase58()}`);

  // 10. Initialize matcher's vAMM (Passive, fee=5bps, spread=50bps).
  const matcherInitData = Buffer.alloc(66);
  matcherInitData[0] = 2;                          // VAMM tag
  matcherInitData[1] = 0;                          // Passive kind
  matcherInitData.writeUInt32LE(5, 2);             // trading_fee_bps
  matcherInitData.writeUInt32LE(50, 6);            // base_spread_bps
  matcherInitData.writeUInt32LE(200, 10);          // max_total_bps
  matcherInitData.writeUInt32LE(0, 14);            // impact_k_bps
  matcherInitData.writeBigUInt64LE(1_000_000_000n, 34); // max_fill_abs
  await sendAndConfirmTransaction(conn,
    new Transaction()
      .add(cuLimit(100_000))
      .add({
        programId: MATCHER_PROG,
        keys: [
          { pubkey: lpPda, isSigner: false, isWritable: false },
          { pubkey: matcherCtx.publicKey, isSigner: false, isWritable: true },
        ],
        data: matcherInitData,
      }),
    [payer], { commitment: 'confirmed' });
  console.log('▶ matcher init (Passive) ✓');

  const out = {
    rpc: 'http://127.0.0.1:8899',
    slab: slab.publicKey.toBase58(),
    vault: vaultAta.address.toBase58(),
    vault_pda: vaultPda.toBase58(),
    mint: mint.toBase58(),
    percolator_program: PERCOLATOR_PROG.toBase58(),
    matcher_program: MATCHER_PROG.toBase58(),
    matcher_context: matcherCtx.publicKey.toBase58(),
    percolator_adapter: PERCOLATOR_ADAPTER.toBase58(),
    lp_idx: lpIdx,
    lp_pda: lpPda.toBase58(),
    lp_owner: payer.publicKey.toBase58(),
    admin: payer.publicKey.toBase58(),
    admin_ata: adminAta.address.toBase58(),
  };
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(out, null, 2));
  console.log(`\nSUCCESS — market bootstrapped, ${OUTPUT_PATH} written`);
  console.log(JSON.stringify(out, null, 2));
}
main().catch((e) => { console.error(e); if (e?.logs) console.error(e.logs.join('\n')); process.exit(1); });
