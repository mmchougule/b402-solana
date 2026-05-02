/**
 * falcon-intent-roundtrip — single-file demo of the Falcon-intent flow.
 *
 * Exercises the relayed-privateSwap authorization surface end-to-end without
 * a Solana RPC, a deployed pool, or proving artifacts. The aim is to make
 * what the SDK signs and what the relayer verifies bit-for-bit obvious.
 *
 *   1. Generate a Falcon-512 keypair (rust-falcon).
 *   2. Build a sample privateSwap intent (synthetic ix bytes — same shape
 *      `B402Solana.privateSwap` would assemble).
 *   3. SDK: createFalconIntentEnvelope → { pubkey, signature, expirySlot, nonce }.
 *   4. Relayer: verifyFalconRelayRequest must accept the unmodified body.
 *   5. Tamper one byte of ixData → relayer rejects with `invalid Falcon intent signature`.
 *   6. Replay the same envelope → relayer rejects with `already used`.
 *   7. Skew currentSlot past expirySlot → relayer rejects with `expired`.
 *
 * Run:
 *   pnpm --filter=@b402ai/solana-examples falcon-intent-roundtrip
 */

import { randomBytes } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { falconKeypair, sign as falconSign } from 'rust-falcon';
import {
  createFalconIntentEnvelope,
  type FalconIntentRequest,
} from '@b402ai/solana';
import {
  MemoryFalconReplayStore,
  RustFalconVerifier,
  verifyFalconRelayRequest,
  type FalconRelayPolicy,
} from '@b402ai/solana-relayer/falcon-intent';

interface RelayBody {
  ixData: string;
  accountKeys: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  altAddresses?: string[];
  computeUnitLimit?: number;
  falconPubkey: string;
  falconSignature: string;
  falconExpirySlot: string;
  falconNonce: string;
}

const POOL_PROGRAM_ID = new PublicKey('42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y');
const RELAYER_PUBKEY = new PublicKey('11111111111111111111111111111111');

function buildSampleIntent(): FalconIntentRequest {
  return {
    label: 'adapt',
    clusterId: 'devnet',
    poolProgramId: POOL_PROGRAM_ID,
    ixData: Uint8Array.from(randomBytes(512)),
    accountKeys: [
      { pubkey: RELAYER_PUBKEY.toBase58(), isSigner: true, isWritable: true },
      { pubkey: '11111111111111111111111111111111', isSigner: false, isWritable: false },
      { pubkey: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', isSigner: false, isWritable: false },
      { pubkey: 'SysvarRent111111111111111111111111111111111', isSigner: false, isWritable: false },
    ],
    altAddresses: [new PublicKey('SysvarRent111111111111111111111111111111111')],
    computeUnitLimit: 1_400_000,
    relayerPubkey: RELAYER_PUBKEY,
    expirySlot: 1_000n,
    nonce: Uint8Array.from(randomBytes(32)),
  };
}

function toRelayBody(intent: FalconIntentRequest, env: Awaited<ReturnType<typeof createFalconIntentEnvelope>>): RelayBody {
  return {
    ixData: Buffer.from(intent.ixData).toString('base64'),
    accountKeys: intent.accountKeys,
    altAddresses: intent.altAddresses.map((p) => p.toBase58()),
    computeUnitLimit: intent.computeUnitLimit,
    falconPubkey: env.falconPubkey,
    falconSignature: env.falconSignature,
    falconExpirySlot: env.falconExpirySlot,
    falconNonce: env.falconNonce,
  };
}

async function main(): Promise<void> {
  console.log('▶ generating Falcon-512 keypair…');
  const keypair = falconKeypair(randomBytes(48));
  console.log(`  pubkey ${keypair.public.length}B, secret ${keypair.secret.length}B`);

  const intent = buildSampleIntent();
  console.log(`▶ intent ixData=${intent.ixData.length}B accounts=${intent.accountKeys.length} expirySlot=${intent.expirySlot}`);

  const signer = {
    publicKey: keypair.public,
    sign(message: Uint8Array): Uint8Array {
      return falconSign(message, keypair.secret, randomBytes(48)).sign;
    },
  };

  const envelope = await createFalconIntentEnvelope(intent, signer);
  const sigBytes = Buffer.from(envelope.falconSignature, 'base64');
  console.log(`  envelope: signature=${sigBytes.length}B (compressed Falcon-512), nonce=32B`);

  const policy: FalconRelayPolicy = {
    currentSlot: 999n,
    clusterId: 'devnet',
    poolProgramId: POOL_PROGRAM_ID,
    relayerPubkey: RELAYER_PUBKEY,
    computeUnitLimit: 1_400_000,
  };
  const verifier = new RustFalconVerifier();
  const replayStore = new MemoryFalconReplayStore();

  // Step 1: clean round-trip.
  const body = toRelayBody(intent, envelope);
  await verifyFalconRelayRequest(body, policy, verifier, replayStore);
  console.log('✓ clean envelope accepted');

  // Step 2: tamper with ixData.
  const tampered = toRelayBody(intent, envelope);
  const tamperedBytes = Buffer.from(tampered.ixData, 'base64');
  tamperedBytes[0] ^= 0xff;
  tampered.ixData = tamperedBytes.toString('base64');
  await mustReject('tampered ixData', () =>
    verifyFalconRelayRequest(tampered, policy, verifier, new MemoryFalconReplayStore()),
    /invalid Falcon intent signature/,
  );

  // Step 3: replay the original envelope (same store as step 1).
  await mustReject('replay of nonce', () =>
    verifyFalconRelayRequest(body, policy, verifier, replayStore),
    /already used/,
  );

  // Step 4: expired (currentSlot > expirySlot).
  const expiredPolicy: FalconRelayPolicy = { ...policy, currentSlot: 1_001n };
  await mustReject('expired intent', () =>
    verifyFalconRelayRequest(toRelayBody(intent, envelope), expiredPolicy, verifier, new MemoryFalconReplayStore()),
    /expired/,
  );

  console.log('');
  console.log('✅ Falcon-intent SDK ↔ relayer round-trip — sign, verify, tamper, replay, expire');
}

async function mustReject(label: string, fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const msg = (e as Error).message;
    if (!pattern.test(msg)) {
      throw new Error(`expected ${label} rejection to match ${pattern}, got: ${msg}`);
    }
    console.log(`✓ ${label} rejected: ${msg}`);
    return;
  }
  throw new Error(`${label} did not reject`);
}

main().then(() => process.exit(0), (e) => { console.error('\n❌', e); process.exit(1); });
