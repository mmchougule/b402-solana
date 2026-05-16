import { Keypair } from '@solana/web3.js';
import { B402Solana } from '@b402ai/solana';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const RPC = process.env.B402_RPC_URL;
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/solana/id.json'),'utf8'))));
const b402 = new B402Solana({ cluster:'mainnet', rpcUrl: RPC, keypair: kp });
await b402.ready();

console.time('balance(refresh:true)');
const r = await b402.balance({ refresh: true });
console.timeEnd('balance(refresh:true)');
console.log('balances:', r.balances.length, 'mints');
for (const b of r.balances) {
  console.log('  ', b.mint.slice(0,8), b.amount, '(' + b.depositCount + ' notes)');
}
process.exit(0);
