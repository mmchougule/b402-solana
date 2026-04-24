export { B402Solana } from './b402.js';
export type { B402SolanaConfig } from './b402.js';
export { B402Error, B402ErrorCode } from './errors.js';
export { buildWallet, type Wallet } from './wallet.js';
export { ClientMerkleTree, buildZeroCache, proveMostRecentLeaf, type MerkleProof } from './merkle.js';
export * as poseidon from './poseidon.js';
export * as noteEnc from './note-encryption.js';
export type { EncryptedNote } from './note-encryption.js';
export { NoteStore } from './note-store.js';

// Action builders + on-chain helpers
export { shield, type ShieldParams, type ShieldResult } from './actions/shield.js';
export { unshield, type UnshieldParams, type UnshieldResult } from './actions/unshield.js';
export {
  privateSwap, MAX_TX_SIZE, MAX_ACTION_PAYLOAD,
  type PrivateSwapParams, type PrivateSwapResult, type JupiterSwapInstruction,
} from './actions/privateSwap.js';
export { Scanner, parseProgramDataLog, expectedCommitmentForOwner, type ScannerOptions } from './notes/scanner.js';

export {
  poolConfigPda, treeStatePda, tokenConfigPda, vaultPda,
  adapterRegistryPda, treasuryPda, nullifierShardPda, shardPrefix,
} from './programs/pda.js';
export { fetchTreeState, decodeTreeState, type TreeStateView } from './programs/tree-state.js';
export {
  instructionDiscriminator, eventDiscriminator,
} from './programs/anchor.js';
