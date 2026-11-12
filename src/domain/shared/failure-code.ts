/**
 * Stable, machine-readable codes attached to every REJECTED wager transaction.
 *
 * Providers rely on these values to decide what to do next, so they are part
 * of the public contract: never rename or reuse a code, only add new ones.
 *
 * Every code here is a *business* outcome: it is terminal, persisted with the
 * transaction and returned again on idempotent replays. Resending the same
 * payload will never change the result.
 */
export enum FailureCode {
  /** BET amount is greater than the current wallet balance. */
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  /**
   * A reversal (ROLLBACK of a WIN/REFUND) would drive the balance below zero.
   * Kept distinct from INSUFFICIENT_FUNDS because operationally it means the
   * player already spent money that the provider now wants back.
   */
  ReversalInsufficientFunds = "REVERSAL_INSUFFICIENT_FUNDS",
  /** Operation currency differs from the wallet currency. */
  CurrencyMismatch = "CURRENCY_MISMATCH",
  /** The wallet does not belong to the playerId sent by the provider. */
  PlayerMismatch = "PLAYER_MISMATCH",
  /** The referenced transaction never arrived within the retry window. */
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  /** The referenced transaction kind cannot be targeted by this operation. */
  ReferenceInvalidKind = "REFERENCE_INVALID_KIND",
  /** Reference belongs to another provider, player, wallet, currency or round. */
  ReferenceMismatch = "REFERENCE_MISMATCH",
  /** Reference exists but ended up REJECTED/FAILED, so it cannot be reversed. */
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  /** Reference was already reversed by a previous REFUND/ROLLBACK. */
  ReferenceAlreadyReversed = "REFERENCE_ALREADY_REVERSED",
  /** Reversal amount differs from the referenced amount (no partial reversals). */
  AmountMismatch = "AMOUNT_MISMATCH",
}

