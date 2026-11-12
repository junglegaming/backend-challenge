/**
 * Error hierarchy shared by the whole service.
 *
 * Every error carries a stable `code`. The HTTP layer and the SQS consumer
 * never inspect messages: they only look at the error *class* to decide the
 * response status or whether a message must be retried, acked or dead-lettered.
 *
 *   DomainError       -> invariant/contract violation detected by the domain
 *   ApplicationError  -> request cannot be fulfilled (not found, conflict, ...)
 *   TransientError    -> infrastructure hiccup; the same request may succeed later
 */

export abstract class AppError extends Error {
  abstract readonly code: string;

  protected constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Raised by domain objects when an input or invariant is invalid. */
export class DomainError extends AppError {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Money string is not a valid non-negative decimal with exactly 2 places. */
export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super("INVALID_MONEY", message);
  }
}

/** Arithmetic or comparison between two different currencies. */
export class CurrencyMismatchError extends DomainError {
  constructor(expected: string, received: string) {
    super("CURRENCY_MISMATCH", `Currency mismatch: expected ${expected}, received ${received}`);
  }
}

/** A debit would make the wallet balance negative. */
export class InsufficientFundsError extends DomainError {
  constructor() {
    super("INSUFFICIENT_FUNDS", "Insufficient funds");
  }
}

/**
 * Attempt to move a transaction out of a terminal state. This is a programming
 * error (the caller should have checked), never a regular business path.
 */
export class InvalidTransactionStateError extends DomainError {
  constructor(from: string, to: string) {
    super("INVALID_TRANSACTION_STATE", `Invalid transaction transition from ${from} to ${to}`);
  }
}

/** Ledger entry arithmetic does not add up (balanceBefore ± money != balanceAfter). */
export class UnbalancedLedgerEntryError extends DomainError {
  constructor() {
    super("UNBALANCED_LEDGER_ENTRY", "Ledger entry is not balanced");
  }
}

/** Request-level failures that are not domain invariants. */
export abstract class ApplicationError extends AppError {}

export class ValidationError extends ApplicationError {
  readonly code = "VALIDATION_ERROR";

  constructor(
    message: string,
    readonly details: ReadonlyArray<{ path: string; message: string }> = [],
  ) {
    super(message);
  }
}

export class NotFoundError extends ApplicationError {
  constructor(
    readonly code: "WALLET_NOT_FOUND" | "TRANSACTION_NOT_FOUND",
    message: string,
  ) {
    super(message);
  }
}

export class ConflictError extends ApplicationError {
  constructor(
    readonly code: "WALLET_ALREADY_EXISTS" | "IDEMPOTENCY_CONFLICT",
    message: string,
    readonly transactionId?: string,
  ) {
    super(message);
  }
}

/**
 * Temporary infrastructure failure (lock timeout, deadlock, connection loss,
 * SQS throttling). Safe to retry with the same Idempotency-Key.
 */
export class TransientError extends AppError {
  readonly code = "TRANSIENT_FAILURE";

  constructor(message: string, cause?: unknown) {
    super(message, { cause });
  }
}

