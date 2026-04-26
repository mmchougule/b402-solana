/**
 * Build a solana-test-validator --account JSON for a pre-funded SPL
 * TokenAccount. Lets us inject alice's USDC ATA on a mainnet-fork without
 * needing to clone a real whale's keypair.
 *
 * Usage:
 *   tsx ops/inject-usdc-ata.ts \
 *     --owner <ALICE_PUBKEY> \
 *     --mint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
 *     --amount 100000000 \
 *     --out /tmp/alice-usdc-ata.json
 *
 *   solana-test-validator --account <ATA_PUBKEY> /tmp/alice-usdc-ata.json
 *
 * Output format matches `solana account --output json` so the validator
 * accepts it.
 */

import fs from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

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

function buildTokenAccountData(mint: PublicKey, owner: PublicKey, amount: bigint): Buffer {
  const buf = Buffer.alloc(165);
  let off = 0;
  mint.toBuffer().copy(buf, off);                      off += 32;
  owner.toBuffer().copy(buf, off);                     off += 32;
  buf.writeBigUInt64LE(amount, off);                   off += 8;
  // delegate: COption<Pubkey> = 4 + 32. None encoded as 0u32 + 32 zeros.
  buf.writeUInt32LE(0, off);                           off += 4;
  off += 32;                                            // zero-pubkey
  // state: AccountState (1 = Initialized)
  buf.writeUInt8(1, off);                              off += 1;
  // is_native: COption<u64> = 4 + 8. None.
  buf.writeUInt32LE(0, off);                           off += 4;
  buf.writeBigUInt64LE(0n, off);                       off += 8;
  // delegated_amount: u64
  buf.writeBigUInt64LE(0n, off);                       off += 8;
  // close_authority: COption<Pubkey> = 4 + 32. None.
  buf.writeUInt32LE(0, off);                           off += 4;
  off += 32;                                            // zero-pubkey
  if (off !== 165) throw new Error(`expected 165 bytes, wrote ${off}`);
  return buf;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const owner = new PublicKey(args.owner);
  const mint = new PublicKey(args.mint);
  const amount = BigInt(args.amount);
  const outFile = args.out ?? `/tmp/${owner.toBase58().slice(0, 8)}-${mint.toBase58().slice(0, 8)}-ata.json`;

  const ata = getAssociatedTokenAddressSync(mint, owner);
  const data = buildTokenAccountData(mint, owner, amount);

  // Mirrors `solana account --output json` shape. Note: rentEpoch is a
  // raw u64 number, not a JSON string. We hand-format the JSON so the
  // 18446744073709551615 literal isn't quoted (JS Number can't represent
  // it; JSON.stringify would lose precision or — if we used BigInt — quote
  // the value, which Solana's deserializer rejects).
  const dataB64 = data.toString('base64');
  const json = `{
  "pubkey": "${ata.toBase58()}",
  "account": {
    "lamports": 2039280,
    "data": ["${dataB64}", "base64"],
    "owner": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "executable": false,
    "rentEpoch": 18446744073709551615,
    "space": 165
  }
}
`;

  fs.writeFileSync(outFile, json);
  console.log(`▶ wrote ${outFile}`);
  console.log(`  ata     = ${ata.toBase58()}`);
  console.log(`  owner   = ${owner.toBase58()}`);
  console.log(`  mint    = ${mint.toBase58()}`);
  console.log(`  amount  = ${amount} raw units`);
  console.log(``);
  console.log(`solana-test-validator flag:`);
  console.log(`  --account ${ata.toBase58()} ${outFile}`);
}

main();
