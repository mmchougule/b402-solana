/**
 * B402Context — boots a single B402Solana SDK instance from env, used by all
 * tool handlers. Lives for the duration of the MCP session.
 *
 * Env contract:
 *   B402_RPC_URL         required, e.g. https://api.devnet.solana.com
 *   B402_CLUSTER         'mainnet' | 'devnet' | 'localnet' (default 'devnet')
 *   B402_KEYPAIR_PATH    default ~/.config/solana/id.json
 *   B402_CIRCUITS_ROOT   required, absolute path to circuits/build/
 *
 * Security:
 *   - The keypair is loaded from disk, never logged.
 *   - Tool responses include only public values (sigs, mint pubkeys, commitments).
 *   - Prover wasm/zkey paths are resolved with path.resolve and existence-checked
 *     before instantiation.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Keypair } from '@solana/web3.js';
import { B402Solana, type B402SolanaConfig } from '@b402ai/solana';

export interface B402Context {
  b402: B402Solana;
  cluster: B402SolanaConfig['cluster'];
}

export function loadContext(): B402Context {
  const rpcUrl = mustEnv('B402_RPC_URL');
  const clusterRaw = process.env.B402_CLUSTER ?? 'devnet';
  if (!['mainnet', 'devnet', 'localnet'].includes(clusterRaw)) {
    throw new Error(`B402_CLUSTER must be mainnet|devnet|localnet; got "${clusterRaw}"`);
  }
  const cluster = clusterRaw as B402SolanaConfig['cluster'];

  const keypairPath = path.resolve(
    process.env.B402_KEYPAIR_PATH ??
      path.join(os.homedir(), '.config/solana/id.json'),
  );
  if (!fs.existsSync(keypairPath)) {
    throw new Error(`keypair not found at ${keypairPath} — set B402_KEYPAIR_PATH`);
  }
  const keypair = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(keypairPath, 'utf8'))),
  );

  const circuitsRoot = path.resolve(mustEnv('B402_CIRCUITS_ROOT'));
  const transactWasm = path.join(circuitsRoot, 'transact_js/transact.wasm');
  const transactZkey = path.join(circuitsRoot, 'ceremony/transact_final.zkey');
  const adaptWasm = path.join(circuitsRoot, 'adapt_js/adapt.wasm');
  const adaptZkey = path.join(circuitsRoot, 'ceremony/adapt_final.zkey');
  for (const p of [transactWasm, transactZkey]) {
    if (!fs.existsSync(p)) {
      throw new Error(`prover artifact missing: ${p} — set B402_CIRCUITS_ROOT correctly`);
    }
  }
  // adapt artifacts are optional — only required if private_swap is called
  const haveAdapt = fs.existsSync(adaptWasm) && fs.existsSync(adaptZkey);

  const b402 = new B402Solana({
    cluster,
    rpcUrl,
    keypair,
    proverArtifacts: { wasmPath: transactWasm, zkeyPath: transactZkey },
    ...(haveAdapt
      ? { adaptProverArtifacts: { wasmPath: adaptWasm, zkeyPath: adaptZkey } }
      : {}),
  });

  return { b402, cluster };
}

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`required env ${name} not set`);
  return v;
}
