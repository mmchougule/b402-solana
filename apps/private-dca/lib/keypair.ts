/**
 * Keypair loader for the DCA demo. Two modes:
 *
 *   1. Path from env (`B402_DCA_PRIVATE_KEYPAIR` / `B402_DCA_PUBLIC_KEYPAIR`)
 *      - production-style, user-managed file.
 *   2. Local file under `apps/private-dca/.wallets/` (gitignored)
 *      - convenience for fresh demo wallets. Auto-generated on first
 *        run if no env override is set. Filename is fixed per role.
 *
 * NEVER overwrite an existing keypair on disk — see user feedback
 * `feedback_never_overwrite_wallets.md`. We only write the file
 * when it doesn't already exist.
 */
import { Keypair } from '@solana/web3.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const WALLET_DIR = path.resolve(new URL('.', import.meta.url).pathname, '..', '.wallets');

export type Role = 'private' | 'public';

function defaultPath(role: Role): string {
  return path.join(WALLET_DIR, `${role}-dca.json`);
}

export function loadOrCreateKeypair(role: Role): {
  keypair: Keypair;
  path: string;
  freshlyCreated: boolean;
} {
  const envVar = role === 'private' ? 'B402_DCA_PRIVATE_KEYPAIR' : 'B402_DCA_PUBLIC_KEYPAIR';
  const envPath = process.env[envVar];
  const target = envPath ?? defaultPath(role);

  if (fs.existsSync(target)) {
    const raw = JSON.parse(fs.readFileSync(target, 'utf8')) as number[];
    return {
      keypair: Keypair.fromSecretKey(new Uint8Array(raw)),
      path: target,
      freshlyCreated: false,
    };
  }
  if (!fs.existsSync(WALLET_DIR)) fs.mkdirSync(WALLET_DIR, { recursive: true });
  const kp = Keypair.generate();
  fs.writeFileSync(target, JSON.stringify(Array.from(kp.secretKey)));
  fs.chmodSync(target, 0o600);
  return { keypair: kp, path: target, freshlyCreated: true };
}
