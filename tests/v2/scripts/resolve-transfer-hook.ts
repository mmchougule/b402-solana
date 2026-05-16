/**
 * Resolve a Token-2022 mint's transferHook extension to the full account set
 * the fork validator needs to clone from mainnet:
 *
 *   1. hookProgram               — the program registered in the mint's
 *                                  TransferHook extension.
 *   2. extraAccountMetasPda      — derived from [b"extra-account-metas", mint]
 *                                  under the hook program. Holds the TLV-
 *                                  encoded extra-meta list.
 *   3. extraAccounts[]           — every account referenced by that TLV
 *                                  (other than the literal source/mint/dest/
 *                                  authority which we already have).
 *
 * Output is JSON, consumed by start-pump-fork.sh:
 *   {
 *     "mint": "...",
 *     "hookProgram": "...",
 *     "extraAccountMetasPda": "...",
 *     "extraAccounts": ["...", "...", ...]
 *   }
 *
 * Usage:
 *   tsx tests/v2/scripts/resolve-transfer-hook.ts \
 *     --mint <pubkey> \
 *     --rpc  https://api.mainnet-beta.solana.com \
 *     --out-file /tmp/pump-hook.json
 */

import fs from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  getMint,
  getTransferHook,
  TOKEN_2022_PROGRAM_ID,
  ExtraAccountMetaAccountDataLayout,
  ExtraAccountMetaLayout,
} from "@solana/spl-token";

function argval(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
}

async function main() {
  const mintArg = argval("mint");
  const rpc = argval("rpc") ?? "https://api.mainnet-beta.solana.com";
  const out = argval("out-file") ?? "/tmp/transfer-hook-info.json";
  if (!mintArg) {
    console.error("Required: --mint <pubkey>");
    process.exit(1);
  }
  const mint = new PublicKey(mintArg);
  const conn = new Connection(rpc, "confirmed");

  const mintInfo = await getMint(conn, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
  const hook = getTransferHook(mintInfo);
  if (!hook || hook.programId.equals(PublicKey.default)) {
    console.error(`${mint.toBase58()} has no active transferHook — nothing to resolve.`);
    process.exit(2);
  }
  const hookProgram = hook.programId;

  const [extraMetasPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), mint.toBuffer()],
    hookProgram,
  );

  const acc = await conn.getAccountInfo(extraMetasPda, "confirmed");
  if (!acc) {
    console.error(
      `ExtraAccountMetaList PDA ${extraMetasPda.toBase58()} not initialized — ` +
        `the hook program hasn't published its required extras. This mint can't be swapped through us safely.`,
    );
    process.exit(3);
  }

  // The PDA's data layout (spl-tlv-account-resolution):
  //   discriminator (8) + extra_account_count (u32 LE) + entries[] (35 B each)
  // Each entry is an ExtraAccountMeta { discriminator (u8), address_config (32), is_signer (u8), is_writable (u8) }.
  // For our cloning purpose we just need to pull the "literal pubkey" entries.
  // address_config discriminator 0 = literal pubkey in the first 32 bytes.
  // Other discriminators reference seeds/ix-data and aren't cloneable directly.
  const data = acc.data;
  // anchor account discriminator + length prefix
  const HEADER = 8;
  const lenLE = data.readUInt32LE(HEADER);
  const COUNT_OFFSET = HEADER + 4;
  const ENTRY_SIZE = 35;
  const extraAccounts = new Set<string>();
  for (let i = 0; i < lenLE; i++) {
    const off = COUNT_OFFSET + i * ENTRY_SIZE;
    const disc = data.readUInt8(off);
    if (disc !== 0) continue; // skip PDA-derived entries; only literal pubkeys clone cleanly
    const pk = new PublicKey(data.slice(off + 1, off + 1 + 32));
    if (pk.equals(PublicKey.default)) continue;
    extraAccounts.add(pk.toBase58());
  }

  const result = {
    mint: mint.toBase58(),
    hookProgram: hookProgram.toBase58(),
    extraAccountMetasPda: extraMetasPda.toBase58(),
    extraAccounts: Array.from(extraAccounts),
  };
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(`Wrote ${out}`);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
