/**
 * Stable, machine-readable failure taxonomy persisted on REJECTED / FAILED
 * transactions and returned to providers. Values are part of the public
 * contract: never rename, only add.
 *
 * Provider guidance:
 *  - "do not resend, the decision is final": every REJECTED code
 *  - "fix the payload and send with a NEW external id": CURRENCY_MISMATCH,
 *    WALLET_PLAYER_MISMATCH, REFERENCE_* mismatches
 *  - FAILED codes are terminal infra failures kept for audit
 */
export enum FailureCode {
  // ---- balance rules
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** a reversal (ROLLBACK of a credit) would drive the balance negative */
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',

  // ---- wallet ownership
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',

  // ---- reference rules
  /** reference never arrived within the retry budget */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** reference exists but belongs to another player/wallet/currency/round */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** e.g. REFUND referencing a WIN */
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  /** reference ended REJECTED/FAILED, there is nothing to revert */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',

  // ---- FAILED (terminal infra, auditable)
  ProcessingError = 'PROCESSING_ERROR',
}
