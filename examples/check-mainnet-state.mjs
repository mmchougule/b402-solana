import { Connection, PublicKey } from '@solana/web3.js';
import { adapterRegistryPda, tokenConfigPda, poolConfigPda } from '@b402ai/solana';

const POOL = new PublicKey('42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y');
const KAMINO_ADAPTER = new PublicKey('2enwFgcGKJDqruHpCtvmhtxe3DYcV3k72VTvoGcdt2rX');
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const KUSDC = new PublicKey('B8V6WVjPxW1UGwVDfxH2d2r8SyT4cqn7dQRK6XneVa7D');

const RPC_URL = process.env.B402_RPC_URL;
if (!RPC_URL) {
  console.error('B402_RPC_URL required (mainnet RPC URL with api-key= for Helius/Triton).');
  process.exit(1);
}
const conn = new Connection(RPC_URL, 'confirmed');

const cfg = poolConfigPda(POOL);
console.log('pool_config PDA:', cfg.toBase58());
const cfgInfo = await conn.getAccountInfo(cfg);
console.log(`  pool_config: ${cfgInfo ? 'OK len=' + cfgInfo.data.length : 'MISSING'}`);

const reg = adapterRegistryPda(POOL);
console.log('adapter_registry PDA:', reg.toBase58());
const regInfo = await conn.getAccountInfo(reg);
if (!regInfo) {
  console.log('  registry: NOT INITIALIZED');
} else {
  const target = KAMINO_ADAPTER.toBuffer();
  let found = false;
  for (let i = 0; i + 32 <= regInfo.data.length; i++) {
    if (regInfo.data.subarray(i, i + 32).equals(target)) { found = true; break; }
  }
  console.log(`  registry data len=${regInfo.data.length}, kamino registered: ${found ? 'YES' : 'NO'}`);
  // Decode known registered adapters: skip 8-byte disc, then look for 32-byte pubkeys
  const known = {
    '3RHRcbinCmcj8JPBfVxb9FW76oh4r8y21aSx4JFy3yx7': 'jupiter',
    '89kw33YDcbXfiayVNauz599LaDm51EuU8amWydpjYKgp': 'mock',
    '2enwFgcGKJDqruHpCtvmhtxe3DYcV3k72VTvoGcdt2rX': 'kamino',
  };
  for (const [k, name] of Object.entries(known)) {
    const t = new PublicKey(k).toBuffer();
    let f = false;
    for (let i = 0; i + 32 <= regInfo.data.length; i++) {
      if (regInfo.data.subarray(i, i + 32).equals(t)) { f = true; break; }
    }
    console.log(`    ${name}: ${f ? 'registered' : '-'}`);
  }
}

for (const [name, mint] of [['USDC', USDC], ['kUSDC', KUSDC]]) {
  const p = tokenConfigPda(POOL, mint);
  const i = await conn.getAccountInfo(p);
  console.log(`${name} token_cfg ${p.toBase58()}: ${i ? 'OK len=' + i.data.length : 'MISSING'}`);
}
