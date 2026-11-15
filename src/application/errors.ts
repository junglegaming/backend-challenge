/**
 * Application-level error taxonomy. Every adapter (HTTP, SQS) maps these
 * categories the same way, so a provider never has to parse a message to know
 * whether it may resend:
 *
 *   category      HTTP  SQS consumer
 *   validation    400   permanent  -> DLQ
 *   not-found     404   business   -> ack
 *   conflict      409   permanent  -> DLQ
 *   transient     503   transient  -> retry with backoff, DLQ after max attempts
 *   integrity     500   permanent  -> DLQ (a database invariant fired: a bug)
 */
export type ErrorCategory = 'validation' | 'not-found' | 'conflict' | 'transient' | 'integrity';

export abstract class ApplicationError extends Error {
  abstract readonly category: ErrorCategory;

  protected constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends ApplicationError {
  readonly category = 'validation';
  constructor(message: string, details?: Record<string, unknown>) {
    super('INVALID_PAYLOAD', message, details);
  }
}

export class NotFoundError extends ApplicationError {
  readonly category = 'not-found';
  constructor(code: 'WALLET_NOT_FOUND' | 'TRANSACTION_NOT_FOUND', message: string) {
    super(code, message);
  }
}

export class ConflictError extends ApplicationError {
  readonly category = 'conflict';
  constructor(
    code: 'IDEMPOTENCY_KEY_CONFLICT' | 'EXTERNAL_TRANSACTION_CONFLICT' | 'WALLET_ALREADY_EXISTS' | 'INBOX_MESSAGE_CONFLICT',
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(code, message, details);
  }
}

export type TransientReason =
  | 'lock-timeout'
  | 'deadlock'
  | 'serialization'
  | 'optimistic-lock'
  | 'unique-race'
  | 'connection'
  | 'timeout'
  | 'broker';

export class TransientInfrastructureError extends ApplicationError {
  readonly category = 'transient';
  constructor(public readonly reason: TransientReason, message: string, options?: { cause?: unknown }) {
    super('TEMPORARILY_UNAVAILABLE', message);
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

/** Optimistic version guard failed (should never happen while the row lock is held). */
export class ConcurrencyConflictError extends TransientInfrastructureError {
  constructor(message: string) {
    super('optimistic-lock', message);
  }
}

/** A unique constraint fired while racing another writer; the operation can be retried. */
export class UniqueViolationError extends TransientInfrastructureError {
  constructor(public readonly constraint: string | undefined, options?: { cause?: unknown }) {
    super('unique-race', `Unique constraint violated: ${constraint ?? 'unknown'}`, options);
  }
}

export class IntegrityViolationError extends ApplicationError {
  readonly category = 'integrity';
  constructor(message: string, details?: Record<string, unknown>) {
    super('INTEGRITY_VIOLATION', message, details);
  }
}
