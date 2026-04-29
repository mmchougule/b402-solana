/**
 * Phase 3 — T3.1, T3.2, T3.3
 *
 * v2's nullifier IMT migration drops `nullifier_shard_prefix` from the
 * instruction argument list. PRD-30 §3.5 establishes that this argument
 * was never a circuit public input — only an instruction-side hint to the
 * pool. So the circuit, the proving key, and the deployed verifier
 * program MUST stay byte-identical between v1 and v2.
 *
 * If any of these tests fails, PRD-30's "no new ceremony needed" claim
 * is wrong and we have to revisit.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Repo-root-relative paths.
const REPO = join(__dirname, '..', '..', '..');
const R1CS = join(REPO, 'circuits/build/transact.r1cs');
const ZKEY = join(REPO, 'circuits/build/ceremony/transact_final.zkey');

// Captured at PRD-30 lock (2026-04-29) — the bytes that mainnet alpha
// shipped against. v2 must match them exactly.
const EXPECTED_R1CS_SHA256 =
  'dff1c715bc2023b4c0a84ac36cf513a761c274f2d7a6c72bef035f4e261972bf';
const EXPECTED_ZKEY_SHA256 =
  '0f2975e137582aa8a30855b3e0f4a1888538059ac8428232eee1d9d2eeae0506';

const VERIFIER_TRANSACT_ID = 'Afjbnv2Ekxa98jjRw33xPPhZabevek2uZxoE75kr6ZrK';
const VERIFIER_ADAPT_ID = '3Y2tyhNSaUiW5AcZcmFGRyTMdnroxHxc5GqFQPcMTZae';

function sha256Hex(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('Phase 3 — circuit unchanged across v1 → v2', () => {
  describe('T3.1 — r1cs is unchanged', () => {
    it('transact.r1cs SHA-256 matches v1', () => {
      // Sanity — the file exists.
      expect(statSync(R1CS).size).toBeGreaterThan(0);
      expect(sha256Hex(R1CS)).toBe(EXPECTED_R1CS_SHA256);
    });
  });

  describe('T3.2 — proving key (zkey) is unchanged', () => {
    it('transact_final.zkey SHA-256 matches v1', () => {
      expect(statSync(ZKEY).size).toBeGreaterThan(0);
      expect(sha256Hex(ZKEY)).toBe(EXPECTED_ZKEY_SHA256);
    });
  });

  describe('T3.3 — deployed verifier program IDs are unchanged', () => {
    it('verifier_transact ID is the v1 mainnet pubkey', () => {
      const lib = readFileSync(
        join(REPO, 'programs/b402-verifier-transact/src/lib.rs'),
        'utf8',
      );
      expect(lib).toContain(`declare_id!("${VERIFIER_TRANSACT_ID}")`);
    });

    it('verifier_adapt ID is the v1 mainnet pubkey', () => {
      const lib = readFileSync(
        join(REPO, 'programs/b402-verifier-adapt/src/lib.rs'),
        'utf8',
      );
      expect(lib).toContain(`declare_id!("${VERIFIER_ADAPT_ID}")`);
    });
  });
});
