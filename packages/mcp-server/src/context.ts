/**
 * B402Context — boots a single B402Solana SDK instance from env, used by all
 * tool handlers. Lives for the duration of the MCP session.
 *
 * Zero-config defaults:
 *   B402_RPC_URL         mainnet: api.mainnet-beta, devnet: clusterApiUrl
 *   B402_CLUSTER         mainnet (alpha live; set devnet for risk-free testing)
 *   B402_KEYPAIR_PATH    ~/.config/solana/id.json
 *   B402_CIRCUITS_ROOT   bundled artifacts shipped inside this package
 *
 * All four env vars are optional. Override only when you need to point at a
 * private RPC, a different keypair, or your own circuit artifacts.
 *
 * Security:
 *   - The keypair is loaded from disk, never logged.
 *   - Tool responses include only public values (sigs, mint pubkeys,
 *     opaque deposit IDs). Never returns secret keys, viewing keys
 *     or note randomness.
 *   - Bundled circuit artifacts are throwaway-devnet-only (matches
 *     PRD-08); mainnet ceremony zkey ships in a future release.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Keypair, clusterApiUrl } from '@solana/web3.js';
import { B402Solana, type B402SolanaConfig } from '@b402ai/solana';
import { B402_ALT_MAINNET, B402_ALT_DEVNET } from '@b402ai/solana-shared';
import { PublicKey } from '@solana/web3.js';

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(p, 'utf8'))));
}

export interface B402Context {
  b402: B402Solana;
  cluster: B402SolanaConfig['cluster'];
  rpcUrl: string;
  b402AltMainnet?: PublicKey;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Resolve the bundled circuit artifacts dir inside this package.
 *  At runtime: dist/context.js → ../circuits/ */
function bundledCircuitsRoot(): string {
  return path.resolve(__dirname, '..', 'circuits');
}

function defaultRpc(cluster: B402SolanaConfig['cluster']): string {
  switch (cluster) {
    case 'mainnet': return 'https://api.mainnet-beta.solana.com';
    case 'devnet':  return clusterApiUrl('devnet');
    case 'localnet': return 'http://127.0.0.1:8899';
  }
}

export function loadContext(): B402Context {
  const clusterRaw = process.env.B402_CLUSTER ?? 'mainnet';
  if (!['mainnet', 'devnet', 'localnet'].includes(clusterRaw)) {
    throw new Error(`B402_CLUSTER must be mainnet|devnet|localnet; got "${clusterRaw}"`);
  }
  const cluster = clusterRaw as B402SolanaConfig['cluster'];

  const rpcUrl = process.env.B402_RPC_URL ?? defaultRpc(cluster);
  // Surface RPC choice to the user once at startup. Public mainnet RPC is
  // free but throttles aggressively (~40 RPS per IP). Power users / agents
  // running tight loops should set B402_RPC_URL to a private RPC.
  if (cluster === 'mainnet' && !process.env.B402_RPC_URL) {
    console.error(
      '[b402-solana] using public mainnet RPC (api.mainnet-beta.solana.com). '
      + 'For production agents set B402_RPC_URL to your Helius/Triton/QuickNode endpoint.',
    );
  }

  const keypairPath = path.resolve(
    process.env.B402_KEYPAIR_PATH ??
      path.join(os.homedir(), '.config/solana/id.json'),
  );
  if (!fs.existsSync(keypairPath)) {
    throw new Error(
      `keypair not found at ${keypairPath}\n  → run 'solana-keygen new' or set B402_KEYPAIR_PATH`,
    );
  }
  const keypair = loadKeypair(keypairPath);

  // Optional separate relayer keypair. When provided, the on-chain fee payer
  // for unshield + private_swap becomes this keypair instead of the user's
  // wallet — breaking the public link between depositor and withdrawal payer.
  // For shield, the user keypair must still sign (Anchor SPL transfer auth),
  // but the FEE payer is also the relayer when this is set.
  const relayerKeypairPath = process.env.B402_RELAYER_KEYPAIR_PATH;
  const relayer = relayerKeypairPath
    ? (() => {
        const p = path.resolve(relayerKeypairPath);
        if (!fs.existsSync(p)) {
          throw new Error(`relayer keypair not found at ${p}`);
        }
        return loadKeypair(p);
      })()
    : undefined;

  const circuitsRoot = path.resolve(
    process.env.B402_CIRCUITS_ROOT ?? bundledCircuitsRoot(),
  );
  const transactWasm = path.join(circuitsRoot, 'transact_js/transact.wasm');
  const transactZkey = path.join(circuitsRoot, 'ceremony/transact_final.zkey');
  const adaptWasm = path.join(circuitsRoot, 'adapt_js/adapt.wasm');
  const adaptZkey = path.join(circuitsRoot, 'ceremony/adapt_final.zkey');

  for (const p of [transactWasm, transactZkey]) {
    if (!fs.existsSync(p)) {
      throw new Error(
        `circuit artifact missing: ${p}\n  → reinstall @b402ai/solana-mcp or set B402_CIRCUITS_ROOT to a circuits/build directory`,
      );
    }
  }
  const haveAdapt = fs.existsSync(adaptWasm) && fs.existsSync(adaptZkey);

  // Default persist dir: ~/.config/b402-solana/notes/<cluster>/
  // One subdir per cluster so devnet and mainnet notes don't collide.
  // Override with B402_NOTES_DIR (or pass empty string to disable persistence).
  const notesPersistDir = process.env.B402_NOTES_DIR === ''
    ? undefined
    : path.resolve(
        process.env.B402_NOTES_DIR ??
          path.join(os.homedir(), '.config', 'b402-solana', 'notes', cluster),
      );

  // Hosted relayer URL — by default users route unshield + private_swap
  // through b402's hosted relayer so the on-chain fee payer is OUR wallet,
  // not the user's. This is the privacy property: user wallet never appears
  // on the unshield tx. Override with B402_RELAYER_HTTP_URL (or empty
  // string to disable, in which case unshield uses the local relayer
  // keypair if configured, otherwise the user's wallet).
  const defaultRelayerUrl: Record<typeof cluster, string | null> = {
    devnet: 'https://b402-solana-relayer-devnet-62092339396.us-central1.run.app',
    mainnet: 'https://b402-solana-relayer-mainnet-62092339396.us-central1.run.app',
    localnet: null,
  };
  // Local relayer keypair takes precedence — if user supplied one, never
  // route through the hosted HTTP relayer (which doesn't yet support v2's
  // multi-ix submissions). Empty-string and 'none' both disable explicitly.
  // Set B402_RELAYER_HTTP_URL=none to disable when using the user wallet
  // as both signer + fee payer.
  const httpRelayerEnv = process.env.B402_RELAYER_HTTP_URL;
  const httpRelayerDisabled =
    httpRelayerEnv === '' ||
    httpRelayerEnv === 'none' ||
    httpRelayerEnv === 'false' ||
    relayer !== undefined;
  const relayerHttpUrl = httpRelayerDisabled
    ? undefined
    : (httpRelayerEnv ?? defaultRelayerUrl[cluster] ?? undefined);
  // Default API key embedded so npm users don't need any env config; the
  // hosted relayer rate-limits per-key (5 req/min on this public tier).
  // Override via B402_RELAYER_API_KEY for higher-tier access.
  const defaultApiKey: Record<typeof cluster, string | null> = {
    devnet: 'kp_8a28d0e86074cde3',   // public devnet tier, 5 req/min
    mainnet: 'kp_53d31f4d4b758ea2',  // public mainnet tier, 5 req/min
    localnet: null,
  };
  const relayerApiKey = process.env.B402_RELAYER_API_KEY === ''
    ? undefined
    : (process.env.B402_RELAYER_API_KEY || defaultApiKey[cluster] || undefined);

  const b402 = new B402Solana({
    cluster,
    rpcUrl,
    keypair,
    proverArtifacts: { wasmPath: transactWasm, zkeyPath: transactZkey },
    ...(haveAdapt
      ? { adaptProverArtifacts: { wasmPath: adaptWasm, zkeyPath: adaptZkey } }
      : {}),
    ...(notesPersistDir ? { notesPersistDir } : {}),
    ...(relayer ? { relayer } : {}),
    ...(relayerHttpUrl ? { relayerHttpUrl } : {}),
    ...(relayerApiKey ? { relayerApiKey } : {}),
  });

  // Cluster-default ALT for unshield/swap. Empty constant = no default;
  // unshield will then build a per-call ALT (slower but works).
  const altStr = cluster === 'mainnet' ? B402_ALT_MAINNET : cluster === 'devnet' ? B402_ALT_DEVNET : '';
  const b402AltMainnet = altStr ? new PublicKey(altStr) : undefined;

  return { b402, cluster, rpcUrl, b402AltMainnet };
}
