export { B402Solana } from './b402.js';
export {
  derivePendingInputsPda,
  buildCommitInputsIxData,
  buildCommitInputsIx,
  COMMIT_INPUTS_DISCRIMINATOR,
  PUBLIC_INPUT_COUNT_ADAPT,
  PENDING_INPUTS_SEED,
  VERSION_PREFIX as PRD35_VERSION_PREFIX,
} from './commit-inputs.js';
export {
  KeypairSigner,
  WalletAdapterSigner,
  isB402Signer,
  B402_SIGNER_DERIVATION_MESSAGE,
  type B402Signer,
  type WalletAdapterLike,
} from './signer.js';
export type {
  B402SolanaConfig,
  B402Status,
  ShieldRequest,
  UnshieldRequest,
  PrivateSwapRequest,
  PrivateSwapResult,
} from './b402.js';
export { B402Error, B402ErrorCode } from './errors.js';
export { buildWallet, type Wallet } from './wallet.js';
export { ClientMerkleTree, buildZeroCache, proveMostRecentLeaf, type MerkleProof } from './merkle.js';
export * as poseidon from './poseidon.js';
export * as noteEnc from './note-encryption.js';
export { deriveExcessRandom, computeExcessCommitment } from './excess.js';
export type { EncryptedNote } from './note-encryption.js';
export { NoteStore } from './note-store.js';
export { B402Indexer } from './indexer.js';
export type {
  B402IndexerConfig,
  IndexerProofResponse,
  IndexerSpentResponse,
  IndexerStateResponse,
} from './indexer.js';

// Action builders + on-chain helpers
export { shield, type ShieldParams, type ShieldResult } from './actions/shield.js';
export { unshield, type UnshieldParams, type UnshieldResult } from './actions/unshield.js';
export { Scanner, parseProgramDataLog, expectedCommitmentForOwner, type ScannerOptions } from './notes/scanner.js';

// Adapter helpers — Kamino lend/redeem.
export {
  buildKaminoDepositActionPayload,
  buildKaminoWithdrawActionPayload,
  buildKaminoExecuteIxData,
  buildKaminoDepositRemainingAccounts,
  buildKaminoWithdrawRemainingAccounts,
  type KaminoReserveAccounts,
  type KaminoPerUserAccounts,
} from './kamino.js';

// Adapter helpers — Percolator perp open/close.
export {
  buildPercolatorOpenActionPayload,
  buildPercolatorCloseActionPayload,
  buildPercolatorPerUserPayload,
  buildPercolatorExecuteIxData,
  buildPercolatorPerUserRemainingAccounts,
  derivePercolatorAdapterAuthority,
  derivePercolatorOwnerPda,
  derivePercolatorPerpMapping,
  type PercolatorOpenArgs,
  type PercolatorCloseArgs,
  type PercolatorPerUserAccounts,
  PERCOLATOR_MAX_ACCOUNTS_DEFAULT,
} from './percolator.js';

// Percolator method request shapes (B402Solana.privatePerpOpen / privatePerpClose).
export type {
  PrivatePerpOpenRequest,
  PrivatePerpCloseRequest,
} from './b402.js';

// Jupiter route helper — used internally by `b402.swap()` and exported
// for callers who want to pre-fetch a quote then call `privateSwap()`.
export {
  fetchJupiterRoute,
  type JupiterRouteRequest,
  type JupiterRouteResponse,
} from './jupiter-route.js';

// Kamino mainnet helpers — used internally by `b402.lend()` / `b402.redeem()`.
// Exported for advanced callers who want to compose Kamino flows manually
// (e.g. their own multi-mint sweeper or APY-comparison UI).
export {
  POOL as KAMINO_POOL,
  KAMINO_ADAPTER,
  KLEND,
  parseReserve,
  deriveAllPerUser,
  ensureAlt,
  ensurePerUserSetup,
  ensureAdapterScratchAtas,
  adapterAuthorityPda,
  buildDepositPayload,
  buildWithdrawPayload,
  buildAdapterIxData,
  buildDepositRemainingAccounts,
  buildWithdrawRemainingAccounts,
  type ParsedReserve,
  type PerUserAccounts,
} from './kamino-mainnet.js';

// On-chain reserve discovery (no static reserve map).
export {
  KLEND_PROGRAM_ID,
  RESERVE_DISCRIMINATOR,
  LENDING_MARKET_DISCRIMINATOR,
  RESERVE_ACCOUNT_SIZE,
  LENDING_MARKET_ACCOUNT_SIZE,
  RESERVE_LENDING_MARKET_OFFSET,
  RESERVE_FARM_COLLATERAL_OFFSET,
  RESERVE_LIQUIDITY_MINT_OFFSET,
  RESERVE_TOKEN_INFO_NAME_OFFSET,
  RESERVE_AVAILABLE_AMOUNT_OFFSET,
  RESERVE_BORROWED_AMOUNT_SF_OFFSET,
  discoverKaminoMarkets,
  discoverKaminoReserves,
  findKaminoReserveByMint,
  findAllKaminoReservesByMint,
  pickBestKaminoReserveByMint,
  type DiscoveredReserve,
  type DiscoveredMarket,
  type DiscoverReservesOptions,
} from './kamino-discover.js';

/** Solana hard tx-size cap. */
export const MAX_TX_SIZE = 1232;
/** Soft ceiling for adapter action_payload. Pool recomputes keccak over it. */
export const MAX_ACTION_PAYLOAD = 350;

export {
  poolConfigPda, treeStatePda, tokenConfigPda, vaultPda,
  adapterRegistryPda, treasuryPda, nullifierShardPda, shardPrefix,
} from './programs/pda.js';
export { fetchTreeState, decodeTreeState, type TreeStateView } from './programs/tree-state.js';
export {
  instructionDiscriminator, eventDiscriminator,
  concat, u16Le, u32Le, u64Le, vecU8,
} from './programs/anchor.js';
