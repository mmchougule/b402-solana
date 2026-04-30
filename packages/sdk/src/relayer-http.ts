/**
 * HTTP relayer client — posts assembled ixData to a remote @b402ai/solana-relayer.
 *
 * The remote service:
 *   1. Slots itself in as fee payer
 *   2. Forces account[0].pubkey to its own relayer pubkey (we just need to
 *      set isSigner+isWritable; the bytes get overwritten)
 *   3. Adds the ComputeBudget IX itself
 *   4. Signs + submits, returns the signature
 *
 * The caller still builds the proof + ixData locally — nothing about the
 * shielded note ever leaves the user's machine.
 */

import { PublicKey } from '@solana/web3.js';
import type { TransactionInstruction } from '@solana/web3.js';

export interface RelayerHttpClient {
  /** Pubkey of the remote relayer keypair (the on-chain fee payer). */
  pubkey: PublicKey;
  /** Submit an assembled instruction via the relayer service. */
  submit(opts: {
    label: 'shield' | 'unshield' | 'transact' | 'adapt';
    ix: TransactionInstruction;
    altAddresses?: PublicKey[];
    computeUnitLimit?: number;
    userSignature?: { signature: Uint8Array; pubkey: PublicKey };
    /** v2 sibling ixs (e.g. b402_nullifier::create_nullifier). Appended
     *  after the main pool ix in the same atomic tx. The relayer doesn't
     *  inspect them — pool's instructions-sysvar walk is the trust
     *  boundary. */
    additionalIxs?: TransactionInstruction[];
  }): Promise<{ signature: string; slot: number }>;
}

export interface RelayerHealth {
  ok: boolean;
  relayerPubkey: string;
  relayerLamports: number;
  rpcSlot: number;
  poolProgramId: string;
  uptimeSec: number;
}

/** Hit `/health` to discover the relayer's pubkey + sanity-check connectivity. */
export async function fetchRelayerHealth(url: string): Promise<RelayerHealth> {
  const resp = await fetch(`${trim(url)}/health`, {
    headers: { accept: 'application/json' },
  });
  if (!resp.ok) {
    throw new Error(`relayer /health ${resp.status} ${resp.statusText}`);
  }
  const h = (await resp.json()) as RelayerHealth;
  if (!h.ok || typeof h.relayerPubkey !== 'string') {
    throw new Error(`relayer /health malformed`);
  }
  return h;
}

/** Build a client bound to a specific URL + pre-discovered pubkey. */
export function makeRelayerHttpClient(opts: {
  url: string;
  pubkey: PublicKey;
  apiKey?: string;
}): RelayerHttpClient {
  const base = trim(opts.url);
  return {
    pubkey: opts.pubkey,
    async submit({ label, ix, altAddresses, computeUnitLimit, userSignature, additionalIxs }) {
      const accountKeys = ix.keys.map((k) => ({
        pubkey: k.pubkey.toBase58(),
        isSigner: k.isSigner,
        isWritable: k.isWritable,
      }));
      if (process.env.B402_DEBUG === '1') {
        // eslint-disable-next-line no-console
        console.error(`[b402 relayer-http] POST /relay/${label}`);
        for (let i = 0; i < accountKeys.length; i++) {
          const k = accountKeys[i];
          console.error(`  [${i}] ${k.pubkey} signer=${k.isSigner} writable=${k.isWritable}`);
        }
      }
      const body: Record<string, unknown> = {
        ixData: bytesToBase64(ix.data),
        accountKeys,
        altAddresses: (altAddresses ?? []).map((p) => p.toBase58()),
        computeUnitLimit: computeUnitLimit ?? 1_400_000,
      };
      if (userSignature) {
        body.userSignature = bytesToBase64(userSignature.signature);
        body.userPubkey = userSignature.pubkey.toBase58();
      }
      if (additionalIxs && additionalIxs.length > 0) {
        body.additionalIxs = additionalIxs.map((extra) => ({
          programId: extra.programId.toBase58(),
          ixData: bytesToBase64(extra.data),
          accountKeys: extra.keys.map((k) => ({
            pubkey: k.pubkey.toBase58(),
            isSigner: k.isSigner,
            isWritable: k.isWritable,
          })),
        }));
      }
      const resp = await fetch(`${base}/relay/${label}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`relayer /${label} ${resp.status} ${resp.statusText}: ${text}`);
      }
      return (await resp.json()) as { signature: string; slot: number };
    },
  };
}

function trim(u: string): string { return u.endsWith('/') ? u.slice(0, -1) : u; }

function bytesToBase64(b: Uint8Array): string {
  return Buffer.from(b).toString('base64');
}
