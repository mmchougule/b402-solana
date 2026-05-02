import { PublicKey } from '@solana/web3.js';
import {
  encodeFalconIntentMessage,
  type FalconIntentClusterId,
  type FalconIntentRequest,
} from '@b402ai/solana';
import { verify as verifyFalconSignature } from 'rust-falcon';
import { Errors } from './errors.js';
import type { RelayRequest } from './validate.js';

const FALCON_512_PUBKEY_LEN = 897;
const FALCON_512_SIGNATURE_MAX_LEN = 666;

export interface FalconRelayPolicy {
  currentSlot: bigint;
  clusterId: FalconIntentClusterId;
  poolProgramId: PublicKey;
  relayerPubkey: PublicKey;
  computeUnitLimit: number;
}

export interface FalconReplayStore {
  seen(key: string, currentSlot: bigint): boolean;
  remember(key: string, expirySlot: bigint): void;
}

export interface FalconSignatureVerifier {
  verify(message: Uint8Array, publicKey: Uint8Array, signature: Uint8Array): boolean;
}

export class RustFalconVerifier implements FalconSignatureVerifier {
  verify(message: Uint8Array, publicKey: Uint8Array, signature: Uint8Array): boolean {
    return verifyFalconSignature(signature, message, publicKey);
  }
}

export class MemoryFalconReplayStore implements FalconReplayStore {
  private readonly expiries = new Map<string, bigint>();

  seen(key: string, currentSlot: bigint): boolean {
    this.prune(currentSlot);
    return this.expiries.has(key);
  }

  remember(key: string, expirySlot: bigint): void {
    this.expiries.set(key, expirySlot);
  }

  private prune(currentSlot: bigint): void {
    for (const [key, expirySlot] of this.expiries) {
      if (expirySlot < currentSlot) {
        this.expiries.delete(key);
      }
    }
  }
}

export async function verifyFalconRelayRequest(
  req: RelayRequest,
  policy: FalconRelayPolicy,
  verifier: FalconSignatureVerifier,
  replayStore: FalconReplayStore,
): Promise<void> {
  const envelope = parseEnvelope(req);
  if (!envelope) return;

  if (envelope.expirySlot < policy.currentSlot) {
    throw Errors.badRequest(
      `falcon intent expired at slot ${envelope.expirySlot}; current slot ${policy.currentSlot}`,
    );
  }

  const replayKey = `${toBase64(envelope.publicKey)}:${toBase64(envelope.nonce)}`;
  if (replayStore.seen(replayKey, policy.currentSlot)) {
    throw Errors.badRequest('falcon intent nonce already used');
  }

  const message = await encodeFalconIntentMessage(toIntentRequest(req, policy, envelope));
  if (!verifier.verify(message, envelope.publicKey, envelope.signature)) {
    throw Errors.badRequest('invalid Falcon intent signature');
  }

  replayStore.remember(replayKey, envelope.expirySlot);
}

function parseEnvelope(req: RelayRequest): {
  publicKey: Uint8Array;
  signature: Uint8Array;
  expirySlot: bigint;
  nonce: Uint8Array;
} | null {
  if (!req.falconPubkey) return null;

  const publicKey = fromBase64(req.falconPubkey);
  const signature = fromBase64(req.falconSignature!);
  const nonce = fromBase64(req.falconNonce!);
  const expirySlot = BigInt(req.falconExpirySlot!);

  if (publicKey.length !== FALCON_512_PUBKEY_LEN) {
    throw Errors.badRequest(`falconPubkey must decode to ${FALCON_512_PUBKEY_LEN} bytes`);
  }
  if (signature.length === 0 || signature.length > FALCON_512_SIGNATURE_MAX_LEN) {
    throw Errors.badRequest(
      `falconSignature must decode to 1..${FALCON_512_SIGNATURE_MAX_LEN} bytes`,
    );
  }
  if (nonce.length !== 32) {
    throw Errors.badRequest('falconNonce must decode to 32 bytes');
  }

  return { publicKey, signature, expirySlot, nonce };
}

function toIntentRequest(
  req: RelayRequest,
  policy: FalconRelayPolicy,
  envelope: { expirySlot: bigint; nonce: Uint8Array },
): FalconIntentRequest {
  return {
    label: 'adapt',
    clusterId: policy.clusterId,
    poolProgramId: policy.poolProgramId,
    ixData: Uint8Array.from(Buffer.from(req.ixData, 'base64')),
    accountKeys: req.accountKeys,
    altAddresses: (req.altAddresses ?? []).map((value) => new PublicKey(value)),
    computeUnitLimit: req.computeUnitLimit ?? policy.computeUnitLimit,
    relayerPubkey: policy.relayerPubkey,
    expirySlot: envelope.expirySlot,
    nonce: envelope.nonce,
  };
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, 'base64'));
}

function toBase64(value: Uint8Array): string {
  return Buffer.from(value).toString('base64');
}
