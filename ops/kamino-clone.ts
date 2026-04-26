/**
 * Enumerate Kamino mainnet accounts to clone into a solana-test-validator
 * fork, mirroring the `ops/jup-quote.ts` pattern. Output JSON:
 *
 *   {
 *     "programs":   [ KAMINO_LEND_PROGRAM, oraclesProgram, ... ],
 *     "data":       [ market, reserve, vaults, mints, oracle accounts, ... ],
 *     "constants":  { lendingMarket, usdcReserve, usdcMint, kUsdcMint, ... },
 *     "whale":      "<USDC whale pubkey, optional>"
 *   }
 *
 * Discovery flow:
 *   1. Fetch the lending market account (`--market <pubkey>`).
 *   2. Walk reserves owned by that market until we find the one whose
 *      `liquidity_mint == --underlying`. Parse out:
 *        - reserve pubkey
 *        - liquidity vault (token account holding USDC)
 *        - collateral mint (kUSDC)
 *        - collateral vault
 *        - fee receiver
 *        - oracle accounts (Pyth + Switchboard if both)
 *   3. Add lending_market_authority PDA (derived from market).
 *
 * Usage:
 *   tsx ops/kamino-clone.ts \
 *     --market 7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF \
 *     --underlying EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
 *     --whale <optional-usdc-whale-pubkey> \
 *     --out-file /tmp/kamino-clone.json
 */

import fs from 'node:fs';
import { Connection, PublicKey } from '@solana/web3.js';

const KAMINO_LEND_PROGRAM = new PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');
const PYTH_RECEIVER = new PublicKey('rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ');
const PYTH_LEGACY = new PublicKey('FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH');
const SWITCHBOARD_ON_DEMAND = new PublicKey('SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv');

const MAINNET_RPC = process.env.MAINNET_RPC ?? 'https://api.mainnet-beta.solana.com';

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : 'true';
      out[k] = v;
      if (v !== 'true') i++;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const marketKey = new PublicKey(args.market ?? '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF');
  const underlying = new PublicKey(args.underlying ?? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  const whale = args.whale ? new PublicKey(args.whale) : undefined;
  const outFile = args['out-file'] ?? '/tmp/kamino-clone.json';

  const conn = new Connection(MAINNET_RPC, 'confirmed');

  // Pull all reserves owned by Kamino + filter by lending market reference.
  // Reserve layout (from Kamino-Finance/klend): version(8)+last_update(...)+
  // lending_market(32)+farm_collateral(32)+farm_debt(32)+liquidity{...}+...
  // The lending_market field is at offset 8 + 16 = 24 (after disc + LastUpdate).
  // The liquidity.mint_pubkey is well past that — easier to fetch and parse.
  console.error(`▶ scanning Kamino reserves owned by market ${marketKey.toBase58()}...`);
  const reserves = await conn.getProgramAccounts(KAMINO_LEND_PROGRAM, {
    filters: [
      { dataSize: 8624 }, // KaminoReserve account size; verify if this changes
      { memcmp: { offset: 32, bytes: marketKey.toBase58() } }, // lending_market
    ],
  });
  console.error(`  found ${reserves.length} reserves`);

  // Find the one whose liquidity.mint == --underlying. The mint pubkey lives
  // inside the ReserveLiquidity struct at offset ~88 (size dependent).
  // Heuristic: scan reserve data for the underlying pubkey bytes; the first
  // 32-byte aligned hit at >= offset 64 is usually liquidity.mint.
  let target: { pubkey: PublicKey; data: Buffer } | undefined;
  const target_bytes = underlying.toBuffer();
  for (const r of reserves) {
    const d = r.account.data as Buffer;
    for (let off = 64; off < Math.min(d.length, 1024); off += 8) {
      if (d.subarray(off, off + 32).equals(target_bytes)) {
        target = { pubkey: r.pubkey, data: d };
        console.error(`  matched reserve ${r.pubkey.toBase58()} (mint @ +${off})`);
        break;
      }
    }
    if (target) break;
  }
  if (!target) throw new Error(`no reserve found for mint ${underlying.toBase58()}`);

  // Pull every 32-byte aligned non-zero pubkey from the matched reserve as
  // candidate accounts to clone. We can't perfectly identify each field
  // without the full Kamino IDL parsed, but cloning the union is safe.
  const candidates = new Set<string>();
  for (let off = 24; off + 32 <= target.data.length; off += 8) {
    const pk = new PublicKey(target.data.subarray(off, off + 32));
    if (pk.equals(PublicKey.default)) continue;
    candidates.add(pk.toBase58());
  }
  // Filter to accounts that actually exist on chain. RPC caps at 100 per
  // call, so chunk.
  const candidateKeys = Array.from(candidates).map((s) => new PublicKey(s));
  const liveAccounts: PublicKey[] = [];
  for (let i = 0; i < candidateKeys.length; i += 100) {
    const chunk = candidateKeys.slice(i, i + 100);
    const fetched = await conn.getMultipleAccountsInfo(chunk);
    chunk.forEach((k, j) => { if (fetched[j] !== null) liveAccounts.push(k); });
  }
  console.error(`  cloning ${liveAccounts.length} candidate accounts referenced by the reserve`);

  // The lending_market_authority PDA is seeds=[b"lma", market]
  const [lendingMarketAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from('lma'), marketKey.toBuffer()],
    KAMINO_LEND_PROGRAM,
  );

  const data: string[] = Array.from(
    new Set([
      marketKey.toBase58(),
      target.pubkey.toBase58(),
      lendingMarketAuthority.toBase58(),
      ...liveAccounts.map((k) => k.toBase58()),
    ]),
  );
  if (whale) data.push(whale.toBase58());

  // Programs: Kamino itself + Pyth receiver/legacy if any candidate is
  // owned by them (oracles).
  const programs = [KAMINO_LEND_PROGRAM.toBase58(), PYTH_RECEIVER.toBase58(), PYTH_LEGACY.toBase58(), SWITCHBOARD_ON_DEMAND.toBase58()];

  const out = {
    programs,
    data,
    constants: {
      kaminoLendProgram: KAMINO_LEND_PROGRAM.toBase58(),
      lendingMarket: marketKey.toBase58(),
      lendingMarketAuthority: lendingMarketAuthority.toBase58(),
      reserve: target.pubkey.toBase58(),
      underlyingMint: underlying.toBase58(),
    },
    whale: whale?.toBase58(),
  };
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.error(`▶ wrote ${outFile} (${data.length} data, ${programs.length} programs)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
