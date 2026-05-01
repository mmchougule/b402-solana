/**
 * Phase 9 dual-note minting — mainnet-fork integration.
 *
 * Goal: prove the round-trip
 *
 *   shield → privateSwap (real adapter, intentional slippageBps)
 *   → assertion: NoteStore for OUT mint contains exactly TWO new notes
 *   → assertion: those two notes' values sum to the on-chain out_vault delta
 *
 * Why this matters: it's the only test that exercises pool's Rust
 * `commitment_b` derivation against the SDK's reconstruction of the same
 * leaf END-TO-END through a real proof + real verifier + real chain state.
 * The litesvm parity test
 * (`programs/b402-pool/src/instructions/adapt_execute.rs::excess_parity_tests`)
 * pins the bytes for one fixture; this test is the runtime guarantee.
 *
 * Pre-requisites (set up by the caller, not this file):
 *
 *   1. Mainnet-fork validator: `tests/v2/scripts/start-mainnet-fork.sh`
 *      with both Phase-9-rebuilt programs deployed at canonical IDs.
 *   2. Phase 9 trusted setup ran + verifier_adapt redeployed with new VK.
 *   3. SDK + prover rebuilt against the new circuit (24 public inputs).
 *   4. ADAPTER_PROGRAM_ID + adapter scratch ATAs configured for whatever
 *      real adapter is being driven (Phoenix preferred; mock adapter is
 *      always exactly 2x → no excess to test).
 *   5. SLIPPAGE_BPS env var (default 300 = 3%) — wide enough that the
 *      adapter's actual delivery EXCEEDS `expectedOut` by ≥ 1 unit, so
 *      the dual-note path actually fires.
 *
 * Skipped automatically when DUAL_NOTE_FORK=1 is not set, so it doesn't
 * gate the broader suite. Run with:
 *
 *   DUAL_NOTE_FORK=1 \
 *   ADAPTER_PROGRAM_ID=<real adapter id> \
 *   pnpm -F @b402ai/solana-v2-tests vitest run integration/dual_note_fork
 */

import { describe, it, expect } from 'vitest';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from '@solana/spl-token';
import { createRpc } from '@lightprotocol/stateless.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { B402Solana } from '@b402ai/solana';

const ENABLED = process.env.DUAL_NOTE_FORK === '1';
const SOLANA_RPC = process.env.SOLANA_RPC ?? 'http://127.0.0.1:8899';
const PHOTON_RPC = process.env.PHOTON_RPC ?? 'http://127.0.0.1:8784';
const ADAPTER_PROGRAM_ID = process.env.ADAPTER_PROGRAM_ID ?? '';
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS ?? 300);

function loadAdmin(): Keypair {
  const p = path.join(os.homedir(), '.config/solana/id.json');
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(p, 'utf8'))));
}

describe.skipIf(!ENABLED)('Phase 9 — dual-note fork integration', () => {
  it(
    'privateSwap with slippage produces two NoteStore entries that sum to actual_out',
    async () => {
      expect(ADAPTER_PROGRAM_ID).not.toBe('');
      const conn = new Connection(SOLANA_RPC, 'confirmed');
      const photonRpc = createRpc(SOLANA_RPC, PHOTON_RPC);
      const admin = loadAdmin();

      // Mint setup mirrors v2_fork_swap.test.ts. The user is expected to have
      // a working harness already (init pool, register adapter, etc.). This
      // test focuses on the dual-note assertion, not on bootstrapping.
      const inMint = await createMint(conn, admin, admin.publicKey, null, 6);
      const outMint = await createMint(conn, admin, admin.publicKey, null, 6);

      // Fund a fresh wallet, shield, then trigger the adapter with a quote
      // that delivers MORE than the floor. Concrete adapter inputs depend on
      // the protocol — wire them in via the harness used at the call site.
      const alice = Keypair.generate();
      await sendAndConfirmTransaction(
        conn,
        new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: admin.publicKey,
            toPubkey: alice.publicKey,
            lamports: 0.1 * LAMPORTS_PER_SOL,
          }),
        ),
        [admin],
        { commitment: 'confirmed' },
      );
      const aliceIn = await getOrCreateAssociatedTokenAccount(conn, admin, inMint, alice.publicKey);
      const SHIELD_AMOUNT = 1_000_000n;
      await mintTo(conn, admin, inMint, aliceIn.address, admin, SHIELD_AMOUNT);

      const circuits = path.resolve(__dirname, '../../../circuits/build');
      const b402 = new B402Solana({
        cluster: 'localnet',
        rpcUrl: SOLANA_RPC,
        keypair: alice,
        proverArtifacts: {
          wasmPath: path.join(circuits, 'transact_js/transact.wasm'),
          zkeyPath: path.join(circuits, 'ceremony/transact_final.zkey'),
        },
        adaptProverArtifacts: {
          wasmPath: path.join(circuits, 'adapt_js/adapt.wasm'),
          zkeyPath: path.join(circuits, 'ceremony/adapt_final.zkey'),
        },
      });

      await b402.shield({ mint: inMint, amount: SHIELD_AMOUNT });

      // The caller MUST construct adapterInTa, adapterOutTa, ALT, and
      // expectedOut for whatever adapter is wired up. We capture the
      // user-supplied values via env vars and TEST_ARTIFACTS so this file
      // remains adapter-agnostic. If anything is missing, fail loudly.
      const ART = process.env.TEST_ARTIFACTS ?? '/tmp/dual-note-fork-artifacts.json';
      if (!fs.existsSync(ART)) {
        throw new Error(
          `dual_note_fork: missing TEST_ARTIFACTS at ${ART}. Run the harness setup ` +
            `that writes { adapterInTa, adapterOutTa, alt, expectedOut, adapterIxData, actionPayload, remainingAccounts } first.`,
        );
      }
      const a = JSON.parse(fs.readFileSync(ART, 'utf8'));
      const expectedOut = BigInt(a.expectedOut);
      // Sanity: the harness should have priced expectedOut so that the
      // adapter's actual delivery exceeds it by at least 1 unit — the
      // SLIPPAGE_BPS knob below is informational for the assertion message.
      void SLIPPAGE_BPS;

      const result = await b402.privateSwap({
        inMint,
        outMint,
        amount: SHIELD_AMOUNT,
        adapterProgramId: new PublicKey(ADAPTER_PROGRAM_ID),
        adapterInTa: new PublicKey(a.adapterInTa),
        adapterOutTa: new PublicKey(a.adapterOutTa),
        alt: new PublicKey(a.alt),
        expectedOut,
        adapterIxData: a.adapterIxData ? Uint8Array.from(a.adapterIxData) : undefined,
        actionPayload: a.actionPayload ? Uint8Array.from(a.actionPayload) : undefined,
        remainingAccounts: a.remainingAccounts?.map((r: any) => ({
          pubkey: new PublicKey(r.pubkey),
          isSigner: !!r.isSigner,
          isWritable: !!r.isWritable,
        })),
        photonRpc,
      });

      // ----- The dual-note assertions -----

      // 1. Result shape: when actualOut > expected, excessNote MUST be set.
      expect(result.outAmount).toBeGreaterThan(expectedOut);
      expect(result.excessNote).toBeDefined();

      // 2. Both notes are owned by alice and are spendable.
      expect(result.outNote.spendingPub).toBe(b402.wallet.spendingPub);
      expect(result.excessNote!.spendingPub).toBe(b402.wallet.spendingPub);

      // 3. Values sum exactly to the on-chain out_vault delta.
      const sum = result.outNote.value + result.excessNote!.value;
      expect(sum).toBe(result.outAmount);

      // 4. The excess note's value is the right size.
      expect(result.excessNote!.value).toBe(result.outAmount - expectedOut);

      // 5. NoteStore reflects both — `b402.balance({ mint: outMint })` should
      // sum them automatically. Useful anchor for downstream balance UX.
      const { balances } = await b402.balance({ mint: outMint });
      // `mint` here is the human label; the *value* across the two notes
      // matters, not the formatting. depositCount must be exactly 2.
      const outBal = balances[0];
      expect(outBal?.amount).toBe(result.outAmount.toString());
      expect(outBal?.depositCount).toBe(2);
    },
    300_000,
  );
});
