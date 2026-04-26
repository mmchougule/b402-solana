/**
 * Direct-to-Kamino refresh_reserve probe — verifies our adapter's
 * discriminator + account-list against real cloned mainnet Kamino state.
 *
 * Account list is the EXACT one Kamino's klend-sdk uses (verified
 * 2026-04-26 against @kamino-finance/klend-sdk@7.3.22):
 *
 *   1. reserve         (writable)
 *   2. lendingMarket   (read)
 *   3. pythOracle      (read; programAddress sentinel if None)
 *   4. switchboardPriceOracle (read; sentinel if None)
 *   5. switchboardTwapOracle  (read; sentinel if None)
 *   6. scopePrices            (read; sentinel if None)
 *
 * Oracle pubkeys come out of the reserve's TokenInfo struct.
 */

import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey,
  Transaction, TransactionInstruction, sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import fs from 'node:fs';

const RPC = 'http://127.0.0.1:8899';
const KAMINO_LEND_PROGRAM = new PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');

// sha256("global:refresh_reserve")[..8] — verified against klend-sdk DISCRIMINATOR
const DISC_REFRESH_RESERVE = Buffer.from([2, 218, 138, 235, 79, 201, 25, 102]);

/**
 * Reserve account layout offsets (klend master 2026-04-26).
 *
 * Reserve {
 *   version: u64           offset 0..8
 *   last_update: LastUpdate offset 8..24  (slot u64 + stale u8 + padding)
 *   lending_market: Pubkey  offset 24..56
 *   farm_collateral: Pubkey offset 56..88
 *   farm_debt: Pubkey       offset 88..120
 *   liquidity: ReserveLiquidity   offset 120..(120+ReserveLiquidity::LEN)
 *   ...
 * }
 *
 * ReserveLiquidity layout (relevant prefix, klend master):
 *   mint_pubkey: Pubkey       0..32
 *   supply_vault: Pubkey      32..64
 *   fee_vault: Pubkey         64..96
 *   ... lots of u64/u128 fields ...
 *   token_info: TokenInfo     somewhere in here
 *
 * Rather than statically decoding the struct (which drifts as Kamino
 * upgrades), grep the reserve's bytes for the `tokenInfoOffset` by
 * looking for the well-known token-name string ("USDC\0..." for the
 * USDC reserve) which sits at the start of TokenInfo.name[32].
 *
 * TokenInfo layout:
 *   name: [u8; 32]
 *   heuristic: PriceHeuristic { lower: u64, upper: u64, exp: u64 } = 24
 *   maxTwapDivergenceBps: u64
 *   maxAgePriceSeconds: u64
 *   maxAgeTwapSeconds: u64
 *   scopeConfiguration: ScopeConfiguration
 *   switchboardConfiguration: SwitchboardConfiguration
 *   pythConfiguration: PythConfiguration { price: Pubkey }
 *   blockPriceUsage: u8
 *   reserved: [u8; 7]
 *   padding: [u64; 19]
 */

function findUtf8(data: Buffer, needle: string): number {
  const b = Buffer.from(needle, 'utf8');
  for (let i = 0; i < data.length - b.length; i++) {
    if (data.subarray(i, i + b.length).equals(b)) return i;
  }
  return -1;
}

interface OraclePubkeys {
  pyth: PublicKey | null;
  switchboardPrice: PublicKey | null;
  switchboardTwap: PublicKey | null;
  scope: PublicKey | null;
}

function parseOracles(reserveData: Buffer): OraclePubkeys {
  // TokenInfo.name starts with the UTF-8 token name. For USDC main reserve,
  // that's "USDC\0...". Find it.
  let nameOff = findUtf8(reserveData, 'USDC\0');
  if (nameOff < 0) nameOff = findUtf8(reserveData, 'USD Coin');
  if (nameOff < 0) {
    // Fallback heuristic: scan for the pattern of 5 ASCII letters + null.
    for (let i = 0; i < reserveData.length - 32; i++) {
      const slice = reserveData.subarray(i, i + 8);
      const ascii = slice.every((b) => b === 0 || (b >= 0x20 && b < 0x7f));
      const hasNull = slice.indexOf(0) > 0;
      if (ascii && hasNull && reserveData[i] !== 0) { nameOff = i; break; }
    }
  }
  if (nameOff < 0) throw new Error('could not locate TokenInfo.name in reserve data');

  // After name(32) + heuristic(24) + 3*u64(24) = 80 bytes → ScopeConfiguration starts.
  // ScopeConfiguration:
  //   priceFeed: Pubkey      32 bytes
  //   priceChain: [u16; 4]   8 bytes
  //   twapChain: [u16; 4]    8 bytes
  //   twapEnabled: u8         1
  //   _pad: [u8; 3]           3
  // Total: 52 bytes
  // SwitchboardConfiguration:
  //   priceAggregator: Pubkey 32
  //   twapAggregator: Pubkey  32
  //   _pad: [u8; 4]            4
  // Total: 68 bytes
  // PythConfiguration:
  //   price: Pubkey           32
  // Total: 32 bytes
  const tokenInfoOff = nameOff;
  const scopeOff      = tokenInfoOff + 32 + 24 + 24;
  const swbOff        = scopeOff + 52;
  const pythOff       = swbOff + 68;

  const def = PublicKey.default;
  const readPk = (off: number) => {
    const pk = new PublicKey(reserveData.subarray(off, off + 32));
    return pk.equals(def) ? null : pk;
  };

  const scope = readPk(scopeOff);
  const swbPrice = readPk(swbOff);
  const swbTwap = readPk(swbOff + 32);
  const pyth = readPk(pythOff);

  return { pyth, switchboardPrice: swbPrice, switchboardTwap: swbTwap, scope };
}

async function main() {
  const clone = JSON.parse(fs.readFileSync('/tmp/kamino-clone.json', 'utf8'));
  const RESERVE = new PublicKey(clone.constants.reserve);
  const LENDING_MARKET = new PublicKey(clone.constants.lendingMarket);

  const conn = new Connection(RPC, 'confirmed');
  const reserveAcct = await conn.getAccountInfo(RESERVE);
  if (!reserveAcct) throw new Error('reserve not on fork');

  const oracles = parseOracles(reserveAcct.data);
  console.log(`▶ oracle pubkeys parsed from cloned reserve:`);
  console.log(`    pyth:               ${oracles.pyth?.toBase58() ?? '<none>'}`);
  console.log(`    switchboard.price:  ${oracles.switchboardPrice?.toBase58() ?? '<none>'}`);
  console.log(`    switchboard.twap:   ${oracles.switchboardTwap?.toBase58() ?? '<none>'}`);
  console.log(`    scope.priceFeed:    ${oracles.scope?.toBase58() ?? '<none>'}`);

  const alice = Keypair.generate();
  const sig0 = await conn.requestAirdrop(alice.publicKey, 5 * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig0, 'confirmed');

  // Build the EXACT klend-sdk account list. Sentinel = program address
  // when the optional oracle is None.
  const sentinel = KAMINO_LEND_PROGRAM;
  const keys = [
    { pubkey: RESERVE,                                          isSigner: false, isWritable: true  },
    { pubkey: LENDING_MARKET,                                   isSigner: false, isWritable: false },
    { pubkey: oracles.pyth ?? sentinel,                         isSigner: false, isWritable: false },
    { pubkey: oracles.switchboardPrice ?? sentinel,             isSigner: false, isWritable: false },
    { pubkey: oracles.switchboardTwap ?? sentinel,              isSigner: false, isWritable: false },
    { pubkey: oracles.scope ?? sentinel,                        isSigner: false, isWritable: false },
  ];

  const ix = new TransactionInstruction({
    programId: KAMINO_LEND_PROGRAM,
    keys,
    data: DISC_REFRESH_RESERVE,
  });

  const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  const tx = new Transaction().add(cuIx, ix);
  console.log(`▶ refresh_reserve with klend-sdk account list (6 fixed accounts)...`);

  try {
    const sig = await sendAndConfirmTransaction(conn, tx, [alice], {
      skipPreflight: true,
      commitment: 'confirmed',
    });
    console.log(`✅ refresh_reserve SUCCESS — sig=${sig}`);
    console.log(`   discriminator + account list verified against real Kamino bytecode`);
  } catch (e: any) {
    const sig = e.signature ?? '<no sig>';
    console.log(`▶ refresh_reserve reverted — sig=${sig}`);
    const txInfo = await conn.getTransaction(sig, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    const logs = txInfo?.meta?.logMessages ?? [];
    for (const line of logs) console.log(`    ${line}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
