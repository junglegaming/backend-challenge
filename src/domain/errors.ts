import type { FailureCode } from './failure-code';

/**
 * Base class for every error raised by the domain. Domain errors are never
 * transient: retrying the same input produces the same error.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Invalid value supplied to a value object or factory (bad input contract). */
export class InvalidValueError extends DomainError {
  readonly code = 'INVALID_VALUE';
  constructor(message: string) {
    super(message);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';
  constructor(expected: string, received: string) {
    super(`Currency mismatch: expected ${expected}, received ${received}`);
  }
}

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';
  constructor() {
    super('Insufficient funds');
  }
}

/** Ledger arithmetic does not close (balanceBefore ± money !== balanceAfter). */
export class UnbalancedLedgerEntryError extends DomainError {
  readonly code = 'UNBALANCED_LEDGER_ENTRY';
  constructor() {
    super('Ledger entry is not balanced');
  }
}

/**
 * Attempt to transition a transaction that is already terminal. This is a
 * programming error, not a business path.
 */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';
  constructor(from: string, to: string) {
    super(`Invalid transaction transition ${from} -> ${to}`);
  }
}

/** A business rule rejected the operation; carries the stable failure code. */
export class BusinessRuleViolation extends DomainError {
  readonly code = 'BUSINESS_RULE_VIOLATION';
  constructor(public readonly failureCode: FailureCode, message?: string) {
    super(message ?? failureCode);
  }
}
