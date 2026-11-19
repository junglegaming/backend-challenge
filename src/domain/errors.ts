/** Códigos estáveis de rejeição, legíveis por máquina. Documentados em ARCHITECTURE.md. */
export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  AlreadyReversed = 'ALREADY_REVERSED',
  AmountMismatch = 'AMOUNT_MISMATCH',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  InternalError = 'INTERNAL_ERROR',
}

export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Entrada que nunca deveria ter passado da borda (HTTP 400 / DLQ). */
export class ValidationError extends DomainError {}
export class InvalidMoneyError extends ValidationError {}
export class CurrencyMismatchError extends DomainError {}
export class InsufficientFundsError extends DomainError {}
/** Transição a partir de estado terminal: erro de programação, não caminho de negócio. */
export class InvalidTransactionStateError extends DomainError {}
export class UnbalancedLedgerEntryError extends DomainError {}
