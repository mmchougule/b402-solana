/**
 * PDA derivation for the b402 pool program.
 * Seeds match `programs/b402-pool/src/constants.rs` and the on-chain layout
 * documented in PRD-03 §3.3.
 */

import { PublicKey } from '@solana/web3.js';

const VERSION_PREFIX = new TextEncoder().encode('b402/v1');
const SEED_CONFIG    = new TextEncoder().encode('config');
const SEED_TOKEN     = new TextEncoder().encode('token');
const SEED_VAULT     = new TextEncoder().encode('vault');
const SEED_TREE      = new TextEncoder().encode('tree');
const SEED_NULL      = new TextEncoder().encode('null');
const SEED_ADAPTERS  = new TextEncoder().encode('adapters');
const SEED_TREASURY  = new TextEncoder().encode('treasury');

function pda(seeds: Uint8Array[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

export function poolConfigPda(programId: PublicKey): PublicKey {
  return pda([VERSION_PREFIX, SEED_CONFIG], programId);
}
export function treeStatePda(programId: PublicKey): PublicKey {
  return pda([VERSION_PREFIX, SEED_TREE], programId);
}
export function adapterRegistryPda(programId: PublicKey): PublicKey {
  return pda([VERSION_PREFIX, SEED_ADAPTERS], programId);
}
export function treasuryPda(programId: PublicKey): PublicKey {
  return pda([VERSION_PREFIX, SEED_TREASURY], programId);
}
export function tokenConfigPda(programId: PublicKey, mint: PublicKey): PublicKey {
  return pda([VERSION_PREFIX, SEED_TOKEN, mint.toBytes()], programId);
}
export function vaultPda(programId: PublicKey, mint: PublicKey): PublicKey {
  return pda([VERSION_PREFIX, SEED_VAULT, mint.toBytes()], programId);
}

/**
 * Nullifier shard PDA. Prefix = high 16 bits of the nullifier (LE encoding,
 * bytes 30-31). One shard per 16-bit prefix; up to 65,536 total.
 */
export function nullifierShardPda(programId: PublicKey, prefix: number): PublicKey {
  if (prefix < 0 || prefix > 0xffff) throw new Error('shard prefix out of range');
  const bytes = new Uint8Array(2);
  bytes[0] = prefix & 0xff;
  bytes[1] = (prefix >> 8) & 0xff;
  return pda([VERSION_PREFIX, SEED_NULL, bytes], programId);
}

/** Derive shard prefix from a nullifier's 32-byte LE encoding. */
export function shardPrefix(nullifierLeBytes: Uint8Array): number {
  if (nullifierLeBytes.length !== 32) throw new Error('expected 32 bytes');
  return nullifierLeBytes[30] | (nullifierLeBytes[31] << 8);
}
