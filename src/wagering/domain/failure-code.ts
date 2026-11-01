export const FailureCode = {
  InsufficientFunds: "INSUFFICIENT_FUNDS",
  ReversalInsufficientFunds: "REVERSAL_INSUFFICIENT_FUNDS",
  AmountNotPositive: "AMOUNT_NOT_POSITIVE",
  WalletNotFound: "WALLET_NOT_FOUND",
  PlayerWalletMismatch: "PLAYER_WALLET_MISMATCH",
  CurrencyMismatch: "CURRENCY_MISMATCH",
  ReferenceNotFound: "REFERENCE_NOT_FOUND",
  ReferenceScopeMismatch: "REFERENCE_SCOPE_MISMATCH",
  ReferenceKindNotAllowed: "REFERENCE_KIND_NOT_ALLOWED",
  ReferenceNotProcessed: "REFERENCE_NOT_PROCESSED",
  ReferenceAmountMismatch: "REFERENCE_AMOUNT_MISMATCH",
  ReferenceAlreadyReversed: "REFERENCE_ALREADY_REVERSED",
  PermanentProcessingError: "PERMANENT_PROCESSING_ERROR",
} as const;
export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];
