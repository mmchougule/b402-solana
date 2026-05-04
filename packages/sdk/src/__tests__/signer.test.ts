import { describe, it, expect, vi } from 'vitest';
import { Keypair, VersionedTransaction, PublicKey, TransactionMessage } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha256';
import {
  KeypairSigner,
  WalletAdapterSigner,
  isB402Signer,
  B402_SIGNER_DERIVATION_MESSAGE,
} from '../signer.js';
import { buildWallet } from '../wallet.js';

describe('KeypairSigner', () => {
  it('exposes the keypair pubkey', () => {
    const kp = Keypair.generate();
    const signer = new KeypairSigner(kp);
    expect(signer.publicKey.equals(kp.publicKey)).toBe(true);
  });

  it('seed = first 32 bytes of secretKey (back-compat with current SDK derivation)', () => {
    const kp = Keypair.generate();
    const signer = new KeypairSigner(kp);
    const seed = signer.getSeed();
    expect(seed).toEqual(kp.secretKey.slice(0, 32));
  });

  it('signTransaction adds the keypair signature to a versioned tx', async () => {
    const kp = Keypair.generate();
    const signer = new KeypairSigner(kp);
    const msg = new TransactionMessage({
      payerKey: kp.publicKey,
      recentBlockhash: '11111111111111111111111111111111',
      instructions: [],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    const signed = await signer.signTransaction(tx);
    expect(signed.signatures[0]).not.toEqual(new Uint8Array(64));
  });

  it('isB402Signer recognizes it', () => {
    const kp = Keypair.generate();
    expect(isB402Signer(new KeypairSigner(kp))).toBe(true);
    expect(isB402Signer(kp)).toBe(false);
    expect(isB402Signer(null)).toBe(false);
    expect(isB402Signer({})).toBe(false);
  });

  it('produces a wallet identical to legacy buildWallet(keypair.secretKey.slice(0,32))', async () => {
    const kp = Keypair.generate();
    const signer = new KeypairSigner(kp);
    const walletFromSigner = await buildWallet(signer.getSeed());
    const walletLegacy = await buildWallet(kp.secretKey.slice(0, 32));
    expect(walletFromSigner.spendingPriv).toEqual(walletLegacy.spendingPriv);
    expect(walletFromSigner.spendingPub).toEqual(walletLegacy.spendingPub);
    expect(walletFromSigner.viewingPriv).toEqual(walletLegacy.viewingPriv);
    expect(walletFromSigner.viewingPub).toEqual(walletLegacy.viewingPub);
  });
});

describe('WalletAdapterSigner', () => {
  function makeAdapter(opts?: { signMessageOverride?: Uint8Array }) {
    const kp = Keypair.generate();
    const fixedSig = opts?.signMessageOverride ?? new Uint8Array(64).fill(7);
    const adapter = {
      publicKey: kp.publicKey as PublicKey | null,
      signMessage: vi.fn(async (_msg: Uint8Array) => fixedSig),
      signTransaction: vi.fn(async <T>(tx: T): Promise<T> => tx),
    };
    return { adapter, kp, fixedSig };
  }

  it('fromAdapter calls signMessage exactly once with the canonical derivation message', async () => {
    const { adapter } = makeAdapter();
    await WalletAdapterSigner.fromAdapter(adapter as any);
    expect(adapter.signMessage).toHaveBeenCalledTimes(1);
    const callArg = adapter.signMessage.mock.calls[0][0];
    expect(new TextDecoder().decode(callArg)).toBe(B402_SIGNER_DERIVATION_MESSAGE);
  });

  it('seed = sha256(signMessage result).slice(0,32) — deterministic across re-derivations', async () => {
    const { adapter, fixedSig } = makeAdapter();
    const signer = await WalletAdapterSigner.fromAdapter(adapter as any);
    expect(signer.getSeed()).toEqual(sha256(fixedSig).slice(0, 32));

    // Same signature → same seed
    const { adapter: adapter2 } = makeAdapter({ signMessageOverride: fixedSig });
    const signer2 = await WalletAdapterSigner.fromAdapter(adapter2 as any);
    expect(signer2.getSeed()).toEqual(signer.getSeed());
  });

  it('different signatures yield different seeds', async () => {
    const sig1 = new Uint8Array(64).fill(1);
    const sig2 = new Uint8Array(64).fill(2);
    const { adapter: a1 } = makeAdapter({ signMessageOverride: sig1 });
    const { adapter: a2 } = makeAdapter({ signMessageOverride: sig2 });
    const s1 = await WalletAdapterSigner.fromAdapter(a1 as any);
    const s2 = await WalletAdapterSigner.fromAdapter(a2 as any);
    expect(s1.getSeed()).not.toEqual(s2.getSeed());
  });

  it('publicKey delegates to adapter', async () => {
    const { adapter, kp } = makeAdapter();
    const signer = await WalletAdapterSigner.fromAdapter(adapter as any);
    expect(signer.publicKey.equals(kp.publicKey)).toBe(true);
  });

  it('signTransaction delegates to adapter (does not use the derivation seed)', async () => {
    const { adapter } = makeAdapter();
    const signer = await WalletAdapterSigner.fromAdapter(adapter as any);
    const tx = { foo: 'bar' } as any;
    await signer.signTransaction(tx);
    expect(adapter.signTransaction).toHaveBeenCalledWith(tx);
  });

  it('throws if adapter has no signMessage', async () => {
    const adapter = { publicKey: Keypair.generate().publicKey, signTransaction: vi.fn() };
    await expect(
      WalletAdapterSigner.fromAdapter(adapter as any),
    ).rejects.toThrow(/signMessage/);
  });

  it('throws if adapter has no publicKey at derivation time', async () => {
    const adapter = { publicKey: null, signMessage: vi.fn(), signTransaction: vi.fn() };
    await expect(
      WalletAdapterSigner.fromAdapter(adapter as any),
    ).rejects.toThrow(/publicKey/);
  });

  it('isB402Signer recognizes it', async () => {
    const { adapter } = makeAdapter();
    const signer = await WalletAdapterSigner.fromAdapter(adapter as any);
    expect(isB402Signer(signer)).toBe(true);
  });

  it('signMessage signature is never persisted past construction', async () => {
    const { adapter, fixedSig } = makeAdapter();
    const signer = await WalletAdapterSigner.fromAdapter(adapter as any);
    // Verify the only persisted derivative is the seed; the raw sig is gone.
    const seed = signer.getSeed();
    expect(seed.length).toBe(32);
    expect(seed).not.toEqual(fixedSig.slice(0, 32));
    // Property check: nothing on the signer holds the raw sig
    const props = Object.values(signer as any);
    for (const v of props) {
      if (v instanceof Uint8Array && v.length === 64) {
        expect(v).not.toEqual(fixedSig);
      }
    }
  });
});

describe('canonical derivation message', () => {
  it('is stable — changing it would invalidate every existing user wallet', () => {
    expect(B402_SIGNER_DERIVATION_MESSAGE).toBe('b402-solana wallet derivation v1');
  });
});
