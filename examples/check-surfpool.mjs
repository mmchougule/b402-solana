import { Connection, PublicKey } from '@solana/web3.js';
import { poolConfigPda, adapterRegistryPda, tokenConfigPda } from '@b402ai/solana';
const POOL = new PublicKey('42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y');
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const KUSDC = new PublicKey('B8V6WVjPxW1UGwVDfxH2d2r8SyT4cqn7dQRK6XneVa7D');
const conn = new Connection('http://127.0.0.1:8899', 'confirmed');
for (const [name, pk] of [
  ['pool_config', poolConfigPda(POOL)],
  ['adapter_registry', adapterRegistryPda(POOL)],
  ['USDC token_cfg', tokenConfigPda(POOL, USDC)],
  ['kUSDC token_cfg', tokenConfigPda(POOL, KUSDC)],
]) {
  const i = await conn.getAccountInfo(pk);
  console.log(name + ':', pk.toBase58(), i ? 'OK len=' + i.data.length : 'MISSING');
}
