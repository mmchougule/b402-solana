import { Connection } from '@solana/web3.js';

const conn = new Connection('https://api.devnet.solana.com', 'confirmed');
const SHIELD = '22Yw2Rwx6jkS2MEGgcoLg1BXz5dQixHzrT2QiB9XDEeTxcoiSRvgwjMDVWD6kYhGxyZ7wiX1Tf6uWH5bXpBvPSpV';
const UNSHIELD = '5uc9DehMU38zR16vUFXFcf1KvyX3qob57d3qcChzBz3dxQQfLZxbvGhhi9Eih8qfhDVvc2jtbt5jRRYfpY3UVYEc';

async function inspect(label, sig) {
  const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
  if (!tx) return console.log(`${label}: not found`);
  console.log(`\n========== ${label} (${sig.slice(0,8)}…) ==========`);
  console.log(`slot:           ${tx.slot}`);
  console.log(`fee:            ${tx.meta.fee} lamports`);
  console.log(`status:         ${tx.meta.err ? 'FAIL' : 'ok'}`);
  const keys = tx.transaction.message.staticAccountKeys.map((k) => k.toBase58());
  console.log(`signers:`);
  const sigsCount = tx.transaction.signatures.length;
  for (let i = 0; i < sigsCount; i++) console.log(`  [${i}] ${keys[i]}`);
  console.log(`account keys (${keys.length}):`);
  keys.forEach((k, i) => console.log(`  [${i}] ${k}`));
  console.log(`token balance changes:`);
  const pre = tx.meta.preTokenBalances || [];
  const post = tx.meta.postTokenBalances || [];
  const all = new Set([...pre.map(b => b.accountIndex), ...post.map(b => b.accountIndex)]);
  for (const idx of all) {
    const p = pre.find(b => b.accountIndex === idx);
    const o = post.find(b => b.accountIndex === idx);
    const owner = (p?.owner || o?.owner)?.slice(0,8);
    const mint = (p?.mint || o?.mint)?.slice(0,8);
    const before = p?.uiTokenAmount?.amount || '0';
    const after = o?.uiTokenAmount?.amount || '0';
    if (before !== after) {
      console.log(`  acct[${idx}] ${keys[idx].slice(0,8)}…  owner=${owner}…  mint=${mint}…  ${before} → ${after}`);
    }
  }
  console.log(`logs (program execution):`);
  for (const line of (tx.meta.logMessages || []).slice(0, 8)) console.log(`  ${line.slice(0, 120)}`);
}

await inspect('SHIELD', SHIELD);
await inspect('UNSHIELD', UNSHIELD);
