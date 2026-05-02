import { PublicKey } from '@solana/web3.js';
import { keccak_256 } from '@noble/hashes/sha3';
import { frToLe, leToFrReduced } from '@b402ai/solana-shared';
import { poseidonTagged } from './poseidon.js';

export type FalconIntentLabel = 'adapt';
export type FalconIntentClusterId = 'mainnet' | 'devnet' | 'testnet' | 'localnet';

export interface FalconIntentAccountMetaInput {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

export interface FalconIntentRequest {
  label: FalconIntentLabel;
  clusterId: FalconIntentClusterId;
  poolProgramId: PublicKey;
  ixData: Uint8Array;
  accountKeys: FalconIntentAccountMetaInput[];
  altAddresses: PublicKey[];
  computeUnitLimit: number;
  relayerPubkey: PublicKey;
  expirySlot: bigint;
  nonce: Uint8Array;
}

export interface FalconIntentEnvelope {
  falconPubkey: string;
  falconSignature: string;
  falconExpirySlot: string;
  falconNonce: string;
}

export interface FalconIntentSigner {
  publicKey: Uint8Array;
  sign(message: Uint8Array): Promise<Uint8Array> | Uint8Array;
}

const CLUSTER_IDS: Record<FalconIntentClusterId, bigint> = {
  mainnet: 1n,
  devnet: 2n,
  testnet: 3n,
  localnet: 4n,
};

const ACTION_IDS: Record<FalconIntentLabel, bigint> = {
  adapt: 1n,
};

const ROLE_RELAYER_SLOT = 1;
const ROLE_ORDINARY = 0;

export async function computeFalconIntentHash(req: FalconIntentRequest): Promise<bigint> {
  validateFalconIntentRequest(req);

  const requestRoot = await poseidonTagged(
    'pqIntentReq',
    keccakFr(req.ixData),
    keccakFr(serializeAccountKeys(req.accountKeys)),
    keccakFr(serializeAltAddresses(req.altAddresses)),
  );

  const routingRoot = await poseidonTagged(
    'pqIntentRoute',
    pubkeyFr(req.relayerPubkey),
    BigInt(req.computeUnitLimit),
    req.expirySlot,
    leToFrReduced(req.nonce),
  );

  return poseidonTagged(
    'pqIntent',
    ACTION_IDS[req.label],
    CLUSTER_IDS[req.clusterId],
    pubkeyFr(req.poolProgramId),
    requestRoot,
    routingRoot,
  );
}

export async function encodeFalconIntentMessage(req: FalconIntentRequest): Promise<Uint8Array> {
  return frToLe(await computeFalconIntentHash(req));
}

export async function createFalconIntentEnvelope(
  req: FalconIntentRequest,
  signer: FalconIntentSigner,
): Promise<FalconIntentEnvelope> {
  const message = await encodeFalconIntentMessage(req);
  const signature = await signer.sign(message);
  return {
    falconPubkey: bytesToBase64(signer.publicKey),
    falconSignature: bytesToBase64(signature),
    falconExpirySlot: req.expirySlot.toString(),
    falconNonce: bytesToBase64(req.nonce),
  };
}

function serializeAccountKeys(accountKeys: FalconIntentAccountMetaInput[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < accountKeys.length; i++) {
    const key = accountKeys[i]!;
    const role = i === 0 ? ROLE_RELAYER_SLOT : ROLE_ORDINARY;
    const meta = new Uint8Array(i === 0 ? 3 : 35);
    meta[0] = role;
    meta[1] = key.isSigner ? 1 : 0;
    meta[2] = key.isWritable ? 1 : 0;
    if (i !== 0) {
      meta.set(new PublicKey(key.pubkey).toBytes(), 3);
    }
    chunks.push(meta);
  }
  return concatBytes(chunks);
}

function serializeAltAddresses(altAddresses: PublicKey[]): Uint8Array {
  const sorted = [...altAddresses]
    .map((pk) => pk.toBase58())
    .sort((a, b) => a.localeCompare(b))
    .map((b58) => new PublicKey(b58).toBytes());
  return concatBytes(sorted);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function pubkeyFr(pubkey: PublicKey): bigint {
  return leToFrReduced(pubkey.toBytes());
}

function keccakFr(bytes: Uint8Array): bigint {
  return leToFrReduced(keccak_256(bytes) as Uint8Array);
}

function validateFalconIntentRequest(req: FalconIntentRequest): void {
  if (req.accountKeys.length === 0) {
    throw new Error('Falcon intent requires at least one account key');
  }
  if (req.computeUnitLimit <= 0) {
    throw new Error('Falcon intent computeUnitLimit must be positive');
  }
  if (req.expirySlot < 0n) {
    throw new Error('Falcon intent expirySlot must be non-negative');
  }
  if (req.nonce.length !== 32) {
    throw new Error(`Falcon intent nonce must be 32 bytes, got ${req.nonce.length}`);
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
