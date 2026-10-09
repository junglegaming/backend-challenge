/**
 * Stable, machine-readable failure taxonomy. Each code tells the provider what to do next:
 *  - FIX:   the request is wrong for this wallet/reference; resending the same payload will never succeed.
 *  - FINAL: a legitimate business outcome; do not resend (resending replays the same rejection).
 */
export enum FailureCode {
  // Balance
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  ReversalInsufficientFunds = "REVERSAL_INSUFFICIENT_FUNDS",
  // Wallet consistency
  CurrencyMismatch = "CURRENCY_MISMATCH",
  WalletPlayerMismatch = "WALLET_PLAYER_MISMATCH",
  // Reference resolution
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  ReferenceMismatch = "REFERENCE_MISMATCH",
  ReferenceAmountMismatch = "REFERENCE_AMOUNT_MISMATCH",
  ReferenceKindNotAllowed = "REFERENCE_KIND_NOT_ALLOWED",
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  ReferenceAlreadyReversed = "REFERENCE_ALREADY_REVERSED",
  // Infrastructure (only for FAILED)
  InfraPermanentFailure = "INFRA_PERMANENT_FAILURE",
}

export type FailureAction = "FIX" | "FINAL";

export const FAILURE_CODE_CATALOG: Readonly<
  Record<FailureCode, { action: FailureAction; description: string }>
> = {
  [FailureCode.InsufficientFunds]: { action: "FINAL", description: "BET amount exceeds the wallet balance." },
  [FailureCode.ReversalInsufficientFunds]: {
    action: "FINAL",
    description: "Reversal (ROLLBACK of a credit) would make the balance negative; requires manual handling.",
  },
  [FailureCode.CurrencyMismatch]: {
    action: "FIX",
    description: "Operation currency differs from the wallet currency.",
  },
  [FailureCode.WalletPlayerMismatch]: { action: "FIX", description: "walletId does not belong to playerId." },
  [FailureCode.ReferenceNotFound]: {
    action: "FINAL",
    description: "Referenced transaction never arrived within the retry window.",
  },
  [FailureCode.ReferenceMismatch]: {
    action: "FIX",
    description: "Reference belongs to another player, wallet, currency or round.",
  },
  [FailureCode.ReferenceAmountMismatch]: {
    action: "FIX",
    description: "REFUND/ROLLBACK amount differs from the referenced amount (partial reversal unsupported).",
  },
  [FailureCode.ReferenceKindNotAllowed]: {
    action: "FIX",
    description: "Reference kind not allowed (REFUND→BET; ROLLBACK→BET|WIN|REFUND; WIN/LOSS→BET).",
  },
  [FailureCode.ReferenceNotProcessed]: {
    action: "FINAL",
    description: "Referenced transaction is REJECTED or FAILED and cannot be reversed or settled.",
  },
  [FailureCode.ReferenceAlreadyReversed]: {
    action: "FINAL",
    description: "Referenced transaction was already reversed by a PROCESSED REFUND or ROLLBACK.",
  },
  [FailureCode.InfraPermanentFailure]: {
    action: "FINAL",
    description: "Non-recoverable infrastructure failure; kept as FAILED for audit.",
  },
};
