import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { falconKeypair, sign } from 'rust-falcon';
import {
  createFalconIntentEnvelope,
  type FalconIntentRequest,
} from '../../sdk/src/falcon-intent.js';
import {
  MemoryFalconReplayStore,
  RustFalconVerifier,
  verifyFalconRelayRequest,
} from '../src/falcon-intent.js';
import type { RelayRequest } from '../src/validate.js';

function sampleIntentRequest(): FalconIntentRequest {
  return {
    label: 'adapt',
    clusterId: 'devnet',
    poolProgramId: new PublicKey('11111111111111111111111111111111'),
    ixData: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]),
    accountKeys: [
      { pubkey: '11111111111111111111111111111111', isSigner: true, isWritable: true },
      { pubkey: 'SysvarRent111111111111111111111111111111111', isSigner: false, isWritable: false },
    ],
    altAddresses: [new PublicKey('SysvarRent111111111111111111111111111111111')],
    computeUnitLimit: 1_400_000,
    relayerPubkey: new PublicKey('11111111111111111111111111111111'),
    expirySlot: 123456789n,
    nonce: new Uint8Array(32).fill(7),
  };
}

function toRelayRequest(
  intent: FalconIntentRequest,
  envelope: Awaited<ReturnType<typeof createFalconIntentEnvelope>>,
): RelayRequest {
  return {
    ixData: Buffer.from(intent.ixData).toString('base64'),
    accountKeys: intent.accountKeys,
    altAddresses: intent.altAddresses.map((pk) => pk.toBase58()),
    computeUnitLimit: intent.computeUnitLimit,
    falconPubkey: envelope.falconPubkey,
    falconSignature: envelope.falconSignature,
    falconExpirySlot: envelope.falconExpirySlot,
    falconNonce: envelope.falconNonce,
  };
}

describe('verifyFalconRelayRequest', () => {
  it('accepts a valid Falcon-signed relay request', async () => {
    const keypair = falconKeypair(randomBytes(48));
    const intent = sampleIntentRequest();
    const envelope = await createFalconIntentEnvelope(intent, {
      publicKey: keypair.public,
      sign(message) {
        return sign(message, keypair.secret, randomBytes(48)).sign;
      },
    });
    const req = toRelayRequest(intent, envelope);

    await expect(
      verifyFalconRelayRequest(
        req,
        {
          currentSlot: 123456788n,
          clusterId: 'devnet',
          poolProgramId: intent.poolProgramId,
          relayerPubkey: intent.relayerPubkey,
          computeUnitLimit: intent.computeUnitLimit,
        },
        new RustFalconVerifier(),
        new MemoryFalconReplayStore(),
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects a request whose ixData changed after signing', async () => {
    const keypair = falconKeypair(randomBytes(48));
    const intent = sampleIntentRequest();
    const envelope = await createFalconIntentEnvelope(intent, {
      publicKey: keypair.public,
      sign(message) {
        return sign(message, keypair.secret, randomBytes(48)).sign;
      },
    });
    const req = toRelayRequest(intent, envelope);
    req.ixData = Buffer.from(Uint8Array.from([9, 2, 3, 4, 5, 6, 7, 8])).toString('base64');

    await expect(
      verifyFalconRelayRequest(
        req,
        {
          currentSlot: 123456788n,
          clusterId: 'devnet',
          poolProgramId: intent.poolProgramId,
          relayerPubkey: intent.relayerPubkey,
          computeUnitLimit: intent.computeUnitLimit,
        },
        new RustFalconVerifier(),
        new MemoryFalconReplayStore(),
      ),
    ).rejects.toThrow(/invalid Falcon intent signature/);
  });

  it('rejects an expired request', async () => {
    const keypair = falconKeypair(randomBytes(48));
    const intent = sampleIntentRequest();
    const envelope = await createFalconIntentEnvelope(intent, {
      publicKey: keypair.public,
      sign(message) {
        return sign(message, keypair.secret, randomBytes(48)).sign;
      },
    });
    const req = toRelayRequest(intent, envelope);

    await expect(
      verifyFalconRelayRequest(
        req,
        {
          currentSlot: 123456790n,
          clusterId: 'devnet',
          poolProgramId: intent.poolProgramId,
          relayerPubkey: intent.relayerPubkey,
          computeUnitLimit: intent.computeUnitLimit,
        },
        new RustFalconVerifier(),
        new MemoryFalconReplayStore(),
      ),
    ).rejects.toThrow(/expired/);
  });

  it('rejects replay of the same pubkey and nonce', async () => {
    const keypair = falconKeypair(randomBytes(48));
    const intent = sampleIntentRequest();
    const envelope = await createFalconIntentEnvelope(intent, {
      publicKey: keypair.public,
      sign(message) {
        return sign(message, keypair.secret, randomBytes(48)).sign;
      },
    });
    const req = toRelayRequest(intent, envelope);
    const replayStore = new MemoryFalconReplayStore();
    const verifier = new RustFalconVerifier();
    const policy = {
      currentSlot: 123456788n,
      clusterId: 'devnet' as const,
      poolProgramId: intent.poolProgramId,
      relayerPubkey: intent.relayerPubkey,
      computeUnitLimit: intent.computeUnitLimit,
    };

    await verifyFalconRelayRequest(req, policy, verifier, replayStore);
    await expect(verifyFalconRelayRequest(req, policy, verifier, replayStore)).rejects.toThrow(/already used/);
  });
});
