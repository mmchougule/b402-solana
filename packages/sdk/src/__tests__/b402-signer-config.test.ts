/**
 * Config-level invariants for the new B402Signer plumbing.
 *
 * Goal: callers pre-0.0.18 pass `keypair: Keypair`; that path must
 * continue to work bit-for-bit (same wallet derivation, same publicKey,
 * same pubkey-on-tx behavior). Callers post-0.0.18 may pass
 * `signer: B402Signer` and skip Keypair plumbing entirely.
 */
import { describe, it, expect, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { B402Solana } from '../b402.js';
import { KeypairSigner, WalletAdapterSigner } from '../signer.js';

function makeAdapterMock() {
  const kp = Keypair.generate();
  const adapter = {
    publicKey: kp.publicKey as PublicKey | null,
    signMessage: vi.fn(async () => new Uint8Array(64).fill(13)),
    signTransaction: vi.fn(async <T>(tx: T): Promise<T> => tx),
  };
  return { adapter, kp };
}

describe('B402Solana config back-compat', () => {
  it('legacy keypair path is preserved — signer.publicKey == keypair.publicKey', () => {
    const kp = Keypair.generate();
    const b402 = new B402Solana({ cluster: 'devnet', keypair: kp });
    expect(b402.signer.publicKey.equals(kp.publicKey)).toBe(true);
  });

  it('legacy keypair path: getSeed returns secretKey[0..32]', () => {
    const kp = Keypair.generate();
    const b402 = new B402Solana({ cluster: 'devnet', keypair: kp });
    expect(b402.signer.getSeed()).toEqual(kp.secretKey.slice(0, 32));
  });

  it('legacy keypair path: b402.keypair stays accessible (existing consumers)', () => {
    const kp = Keypair.generate();
    const b402 = new B402Solana({ cluster: 'devnet', keypair: kp });
    expect(b402.keypair).toBe(kp);
  });

  it('new signer path: accept B402Signer directly', async () => {
    const { adapter, kp } = makeAdapterMock();
    const signer = await WalletAdapterSigner.fromAdapter(adapter as any);
    const b402 = new B402Solana({ cluster: 'devnet', signer });
    expect(b402.signer.publicKey.equals(kp.publicKey)).toBe(true);
  });

  it('new signer path: b402.keypair is null when not Keypair-backed', async () => {
    const { adapter } = makeAdapterMock();
    const signer = await WalletAdapterSigner.fromAdapter(adapter as any);
    const b402 = new B402Solana({ cluster: 'devnet', signer });
    expect(b402.keypair).toBeNull();
  });

  it('passing both keypair AND signer throws — caller must pick one', async () => {
    const kp = Keypair.generate();
    const { adapter } = makeAdapterMock();
    const signer = await WalletAdapterSigner.fromAdapter(adapter as any);
    expect(() => new B402Solana({
      cluster: 'devnet', keypair: kp, signer,
    } as any)).toThrow(/keypair.*signer|signer.*keypair/i);
  });

  it('passing neither throws — caller must pick one', () => {
    expect(() => new B402Solana({ cluster: 'devnet' } as any)).toThrow(
      /keypair|signer/i,
    );
  });

  it('explicit KeypairSigner wraps Keypair without re-wrapping', () => {
    const kp = Keypair.generate();
    const ks = new KeypairSigner(kp);
    const b402 = new B402Solana({ cluster: 'devnet', signer: ks });
    expect(b402.signer).toBe(ks);
    // KeypairSigner exposes the underlying Keypair via getSeed and publicKey
    expect(b402.signer.publicKey.equals(kp.publicKey)).toBe(true);
  });

  it('ready() builds the same wallet from KeypairSigner and legacy keypair path', async () => {
    const kp = Keypair.generate();
    const a = new B402Solana({ cluster: 'devnet', keypair: kp });
    const b = new B402Solana({ cluster: 'devnet', signer: new KeypairSigner(kp) });
    await a.ready();
    await b.ready();
    expect(a.wallet.spendingPub).toEqual(b.wallet.spendingPub);
    expect(a.wallet.viewingPub).toEqual(b.wallet.viewingPub);
  });
});
