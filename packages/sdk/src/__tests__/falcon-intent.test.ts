import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
  computeFalconIntentHash,
  type FalconIntentRequest,
} from '../falcon-intent.js';

function sampleRequest(): FalconIntentRequest {
  return {
    label: 'adapt',
    clusterId: 'devnet',
    poolProgramId: new PublicKey('11111111111111111111111111111111'),
    ixData: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]),
    accountKeys: [
      { pubkey: 'RelayerPlaceholder1111111111111111111111111', isSigner: true, isWritable: true },
      { pubkey: 'SysvarRent111111111111111111111111111111111', isSigner: false, isWritable: false },
      { pubkey: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', isSigner: false, isWritable: false },
    ],
    altAddresses: [
      new PublicKey('SysvarRent111111111111111111111111111111111'),
      new PublicKey('11111111111111111111111111111111'),
    ],
    computeUnitLimit: 1_400_000,
    relayerPubkey: new PublicKey('11111111111111111111111111111111'),
    expirySlot: 123456789n,
    nonce: new Uint8Array(32).fill(3),
  };
}

describe('computeFalconIntentHash', () => {
  it('ignores the concrete pubkey in account slot 0', async () => {
    const a = sampleRequest();
    const b = sampleRequest();
    b.accountKeys[0] = {
      pubkey: 'SysvarC1ock11111111111111111111111111111111',
      isSigner: true,
      isWritable: true,
    };

    await expect(computeFalconIntentHash(a)).resolves.toBe(
      await computeFalconIntentHash(b),
    );
  });

  it('changes when a non-slot account changes', async () => {
    const a = sampleRequest();
    const b = sampleRequest();
    b.accountKeys[1] = {
      pubkey: 'SysvarC1ock11111111111111111111111111111111',
      isSigner: false,
      isWritable: false,
    };

    expect(await computeFalconIntentHash(a)).not.toBe(await computeFalconIntentHash(b));
  });

  it('is stable under ALT order changes', async () => {
    const a = sampleRequest();
    const b = sampleRequest();
    b.altAddresses = [...a.altAddresses].reverse();

    expect(await computeFalconIntentHash(a)).toBe(await computeFalconIntentHash(b));
  });

  it('changes when ixData changes', async () => {
    const a = sampleRequest();
    const b = sampleRequest();
    b.ixData = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 9]);

    expect(await computeFalconIntentHash(a)).not.toBe(await computeFalconIntentHash(b));
  });

  it('changes when compute limit, expiry, or nonce changes', async () => {
    const base = sampleRequest();

    const computeChanged = sampleRequest();
    computeChanged.computeUnitLimit = 1_399_999;
    expect(await computeFalconIntentHash(base)).not.toBe(await computeFalconIntentHash(computeChanged));

    const expiryChanged = sampleRequest();
    expiryChanged.expirySlot = 123456790n;
    expect(await computeFalconIntentHash(base)).not.toBe(await computeFalconIntentHash(expiryChanged));

    const nonceChanged = sampleRequest();
    nonceChanged.nonce = new Uint8Array(32).fill(4);
    expect(await computeFalconIntentHash(base)).not.toBe(await computeFalconIntentHash(nonceChanged));
  });
});
