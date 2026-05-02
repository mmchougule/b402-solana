/**
 * agent-delegated-private-swap — Falcon-signed constraints for private agentic
 * Solana execution.
 *
 * The pattern: Alice doesn't sign the swap. Alice signs a Falcon intent that
 * pins what an agent (relayer, bot, MPC service, custodian) is allowed to
 * submit on her behalf. The intent binds the exact ixData, account-meta
 * sequence, ALT set, fee recipient, expiry slot, and nonce. The agent
 * constructs the relay request, attaches Alice's Falcon envelope, sends. The
 * relayer reconstructs the canonical intent hash from the request body it
 * received plus its own routing context, verifies the Falcon signature, and
 * either submits or rejects — before paying any fees.
 *
 * What this demo runs in-process (no RPC, no pool, no proving artifacts):
 *
 *   1. Alice generates a Falcon-512 keypair (`rust-falcon`).
 *   2. Alice and the agent agree on the swap intent: amount, min_out,
 *      fee_recipient, adapter route, expiry slot, nonce.
 *   3. The agent builds a privateSwap-shaped ixData payload at the exact byte
 *      offsets the b402 pool program expects (so when the agent tries to
 *      deviate, the byte mutation lands at a semantically-named field).
 *   4. Alice signs the canonical intent hash; the envelope carries her Falcon
 *      pubkey, signature, expiry slot, and nonce.
 *   5. Clean path: relayer rebuilds the hash, verifies, accepts.
 *
 *   Adversarial paths — each one is a thing an untrusted agent might try and
 *   each one is rejected before the relayer signs anything:
 *
 *     A. Agent lowers `min_out` (steal slippage on Alice's swap).
 *        Mutation: u64 LE at offset 548 of ixData.
 *        Result: relayer rejects with `invalid Falcon intent signature`.
 *
 *     B. Agent redirects the fee recipient pubkey to itself.
 *        Mutation: 32-byte pubkey at offset 562 of ixData.
 *        Result: relayer rejects with `invalid Falcon intent signature`.
 *
 *     C. Agent replays a previously-honoured intent on a fresh request.
 *        Mutation: none — same envelope, same nonce.
 *        Result: relayer rejects with `falcon intent nonce already used`.
 *
 *     D. Agent waits past expiry slot, then submits.
 *        Mutation: relayer's currentSlot moves past `falconExpirySlot`.
 *        Result: relayer rejects with `falcon intent expired`.
 *
 * Run:
 *   pnpm --filter=@b402ai/solana-examples agent-delegated-private-swap
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

// Offsets into a privateSwap `adapt_execute` ixData payload, derived from
// `packages/sdk/src/b402.ts::privateSwap` poolIxParts assembly. These are
// the bytes the named adversarial cases below mutate.
const OFFSET_EXPECTED_OUT = 548; // u64 LE — proof-bound min_out floor
const OFFSET_FEE_RECIPIENT = 562; // 32 B  — relayer fee recipient pubkey

/**
 * Build a synthetic ixData buffer with the privateSwap layout. The contents
 * past the discriminator are random — the relayer never parses the structure,
 * only hashes the raw bytes. What matters for the demo is that the offsets
 * for `expected_out` and `fee_recipient` match what a real privateSwap call
 * would produce.
 */
function buildPrivateSwapIxData(opts: {
  expectedOut: bigint;
  feeRecipient: PublicKey;
}): Uint8Array {
  const ixData = new Uint8Array(700);
  // Fill with random padding so the demo is reproducible byte-for-byte
  // across runs only when seeded; here we just want a realistic shape.
  ixData.set(randomBytes(ixData.length));

  // expected_out: u64 LE at offset 548.
  const view = new DataView(ixData.buffer);
  view.setBigUint64(OFFSET_EXPECTED_OUT, opts.expectedOut, true);

  // fee_recipient: 32-byte pubkey at offset 562.
  ixData.set(opts.feeRecipient.toBytes(), OFFSET_FEE_RECIPIENT);

  return ixData;
}

interface AgentIntent {
  amount: bigint;
  minOut: bigint;
  feeRecipient: PublicKey;
  expirySlot: bigint;
  nonce: Uint8Array;
}

function buildIntent(spec: AgentIntent): FalconIntentRequest {
  const ixData = buildPrivateSwapIxData({
    expectedOut: spec.minOut,
    feeRecipient: spec.feeRecipient,
  });
  return {
    label: 'adapt',
    clusterId: 'devnet',
    poolProgramId: POOL_PROGRAM_ID,
    ixData,
    accountKeys: [
      { pubkey: RELAYER_PUBKEY.toBase58(), isSigner: true, isWritable: true },
      { pubkey: '11111111111111111111111111111111', isSigner: false, isWritable: false },
      { pubkey: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', isSigner: false, isWritable: false },
      { pubkey: 'SysvarRent111111111111111111111111111111111', isSigner: false, isWritable: false },
    ],
    altAddresses: [new PublicKey('SysvarRent111111111111111111111111111111111')],
    computeUnitLimit: 1_400_000,
    relayerPubkey: RELAYER_PUBKEY,
    expirySlot: spec.expirySlot,
    nonce: spec.nonce,
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
  console.log('▶ Alice generates Falcon-512 keypair (her agent-authorization key)');
  const aliceKeypair = falconKeypair(randomBytes(48));
  console.log(`  pubkey ${aliceKeypair.public.length}B, secret ${aliceKeypair.secret.length}B`);

  const alicesIntent: AgentIntent = {
    amount: 1_000_000_000n, // 1000 USDC in 6 decimals
    minOut: 5_000_000_000n, // 5 SOL in 9 decimals — Alice's slippage floor
    feeRecipient: RELAYER_PUBKEY, // Alice's chosen fee recipient
    expirySlot: 1_000n,
    nonce: Uint8Array.from(randomBytes(32)),
  };
  console.log(`▶ intent: swap up to ${alicesIntent.amount} units IN, min_out=${alicesIntent.minOut}, expirySlot=${alicesIntent.expirySlot}`);
  console.log(`  fee_recipient=${alicesIntent.feeRecipient.toBase58().slice(0, 8)}…  nonce=${Buffer.from(alicesIntent.nonce).toString('hex').slice(0, 16)}…`);

  const intent = buildIntent(alicesIntent);

  const aliceSigner = {
    publicKey: aliceKeypair.public,
    sign(message: Uint8Array): Uint8Array {
      return falconSign(message, aliceKeypair.secret, randomBytes(48)).sign;
    },
  };

  const envelope = await createFalconIntentEnvelope(intent, aliceSigner);
  const sigBytes = Buffer.from(envelope.falconSignature, 'base64');
  console.log(`  Alice signs canonical intent hash → envelope: ${sigBytes.length}B compressed Falcon-512`);

  const policy: FalconRelayPolicy = {
    currentSlot: 999n,
    clusterId: 'devnet',
    poolProgramId: POOL_PROGRAM_ID,
    relayerPubkey: RELAYER_PUBKEY,
    computeUnitLimit: 1_400_000,
  };
  const verifier = new RustFalconVerifier();
  const replayStore = new MemoryFalconReplayStore();

  // --- Clean path: agent submits Alice's intent unchanged.
  console.log('');
  console.log('▶ clean path: agent forwards Alice\'s intent verbatim');
  const honestBody = toRelayBody(intent, envelope);
  await verifyFalconRelayRequest(honestBody, policy, verifier, replayStore);
  console.log('✓ relayer accepted');

  // --- Adversarial A: agent lowers min_out to steal slippage.
  console.log('');
  console.log('▶ attack A: agent lowers min_out from 5,000,000,000 to 1 (steal slippage)');
  const lowMinOutBody = toRelayBody(intent, envelope);
  const lowMinOutBytes = Buffer.from(lowMinOutBody.ixData, 'base64');
  new DataView(lowMinOutBytes.buffer, lowMinOutBytes.byteOffset, lowMinOutBytes.byteLength)
    .setBigUint64(OFFSET_EXPECTED_OUT, 1n, true);
  lowMinOutBody.ixData = lowMinOutBytes.toString('base64');
  await mustReject(
    'agent lowering min_out',
    () => verifyFalconRelayRequest(lowMinOutBody, policy, verifier, new MemoryFalconReplayStore()),
    /invalid Falcon intent signature/,
  );

  // --- Adversarial B: agent redirects fee_recipient to itself.
  console.log('');
  console.log('▶ attack B: agent redirects fee_recipient to its own pubkey');
  const malicious = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const feeStealBody = toRelayBody(intent, envelope);
  const feeStealBytes = Buffer.from(feeStealBody.ixData, 'base64');
  feeStealBytes.set(malicious.toBytes(), OFFSET_FEE_RECIPIENT);
  feeStealBody.ixData = feeStealBytes.toString('base64');
  await mustReject(
    'agent redirecting fee_recipient',
    () => verifyFalconRelayRequest(feeStealBody, policy, verifier, new MemoryFalconReplayStore()),
    /invalid Falcon intent signature/,
  );

  // --- Adversarial C: agent replays a previously-accepted intent.
  console.log('');
  console.log('▶ attack C: agent replays the same envelope to double-execute');
  await mustReject(
    'agent replaying intent',
    () => verifyFalconRelayRequest(honestBody, policy, verifier, replayStore),
    /already used/,
  );

  // --- Adversarial D: agent submits past expiry.
  console.log('');
  console.log('▶ attack D: agent submits past expirySlot (1000), currentSlot=1001');
  const expiredPolicy: FalconRelayPolicy = { ...policy, currentSlot: 1_001n };
  await mustReject(
    'agent submitting past expiry',
    () =>
      verifyFalconRelayRequest(
        toRelayBody(intent, envelope),
        expiredPolicy,
        verifier,
        new MemoryFalconReplayStore(),
      ),
    /expired/,
  );

  console.log('');
  console.log('✅ Falcon-bound agent delegation: clean accept + 4 named attacks rejected');
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
