export class B402Error extends Error {
  constructor(
    public readonly code: B402ErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(`${code}: ${message}`);
    this.name = 'B402Error';
  }
}

export enum B402ErrorCode {
  InvalidSeed              = 'INVALID_SEED',
  NoSpendableNotes         = 'NO_SPENDABLE_NOTES',
  ProofGenerationFailed    = 'PROOF_GEN_FAILED',
  WitnessGenerationFailed  = 'WITNESS_GEN_FAILED',
  TokenNotWhitelisted      = 'TOKEN_NOT_WHITELISTED',
  NullifierAlreadySpent    = 'NULLIFIER_SPENT',
  RootExpired              = 'ROOT_EXPIRED',
  ProofVerifyFailed        = 'PROOF_VERIFY_FAILED',
  SlippageExceeded         = 'SLIPPAGE_EXCEEDED',
  AdapterFailed            = 'ADAPTER_FAILED',
  RelayerUnreachable       = 'RELAYER_UNREACHABLE',
  RpcError                 = 'RPC_ERROR',
  TxTimeout                = 'TX_TIMEOUT',
  RelayerFeeTooHigh        = 'RELAYER_FEE_TOO_HIGH',
  InsufficientBalance      = 'INSUFFICIENT_BALANCE',
  InvalidRecipient         = 'INVALID_RECIPIENT',
  AmountOutOfRange         = 'AMOUNT_OUT_OF_RANGE',
  NotImplemented           = 'NOT_IMPLEMENTED',
  InvalidConfig            = 'INVALID_CONFIG',
}
