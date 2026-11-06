/**
 * Stable, machine-readable failure taxonomy.
 *
 * Business codes accompany REJECTED transactions (terminal, deterministic outcome of the rules).
 * Infrastructure codes accompany FAILED transactions (terminal, auditable, operator attention).
 *
 * A terminal outcome is replayed for the same idempotency key, so "resubmit" always means a NEW
 * externalTransactionId / idempotency key.
 */
export enum FailureCode {
  // --- business (REJECTED)
  InsufficientFunds = 'INSUFFICIENT_FUNDS', // BET larger than the balance
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW', // ROLLBACK of a credit would make the balance negative
  ReferenceNotFound = 'REFERENCE_NOT_FOUND', // referenced transaction never arrived (retries/TTL exhausted)
  ReferenceMismatch = 'REFERENCE_MISMATCH', // reference belongs to another provider/player/wallet/currency/round
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND', // e.g. REFUND of a WIN, ROLLBACK of a LOSS
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED', // reference was rejected/failed, nothing to reverse
  AlreadyReversed = 'ALREADY_REVERSED', // reference already reversed by a REFUND/ROLLBACK
  AmountMismatch = 'AMOUNT_MISMATCH', // reversal amount differs from the reference amount
  CurrencyMismatch = 'CURRENCY_MISMATCH', // operation currency differs from the wallet currency
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH', // playerId does not own the wallet
  // --- infrastructure (FAILED)
  InternalError = 'INTERNAL_ERROR',
  RetriesExhausted = 'RETRIES_EXHAUSTED',
}

const BUSINESS_CODES: ReadonlySet<FailureCode> = new Set([
  FailureCode.InsufficientFunds,
  FailureCode.ReversalWouldOverdraw,
  FailureCode.ReferenceNotFound,
  FailureCode.ReferenceMismatch,
  FailureCode.InvalidReferenceKind,
  FailureCode.ReferenceNotProcessed,
  FailureCode.AlreadyReversed,
  FailureCode.AmountMismatch,
  FailureCode.CurrencyMismatch,
  FailureCode.WalletPlayerMismatch,
]);

export const isBusinessFailureCode = (code: FailureCode): boolean => BUSINESS_CODES.has(code);

/** What the provider should do next. */
export enum FailureAdvice {
  CorrectAndResubmit = 'CORRECT_AND_RESUBMIT', // fix the payload, send as a new transaction
  ResubmitLater = 'RESUBMIT_LATER', // may succeed later as a new transaction (e.g. after funds arrive)
  Abandon = 'ABANDON', // will never succeed; do not retry
}

export function failureAdvice(code: FailureCode): FailureAdvice {
  switch (code) {
    case FailureCode.ReferenceMismatch:
    case FailureCode.InvalidReferenceKind:
    case FailureCode.AmountMismatch:
    case FailureCode.CurrencyMismatch:
    case FailureCode.WalletPlayerMismatch:
      return FailureAdvice.CorrectAndResubmit;
    case FailureCode.InsufficientFunds:
    case FailureCode.ReversalWouldOverdraw:
    case FailureCode.InternalError:
      return FailureAdvice.ResubmitLater;
    case FailureCode.ReferenceNotFound:
    case FailureCode.ReferenceNotProcessed:
    case FailureCode.AlreadyReversed:
    case FailureCode.RetriesExhausted:
      return FailureAdvice.Abandon;
  }
}
