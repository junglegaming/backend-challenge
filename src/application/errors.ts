/** Errors raised by use cases (not business rejections: those are persisted outcomes, not exceptions). */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The request itself is malformed (missing header, bad id format...). */
export class InvalidRequestError extends ApplicationError {
  readonly code = 'INVALID_REQUEST';

  constructor(message: string) {
    super(message);
  }
}

/** Same idempotency key with a different payload, or same provider transaction under another key. */
export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_CONFLICT';

  constructor(message: string) {
    super(message);
  }
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND';

  constructor(walletId: string) {
    super(`wallet ${walletId} not found`);
  }
}

export class TransactionNotFoundError extends ApplicationError {
  readonly code = 'TRANSACTION_NOT_FOUND';

  constructor(description: string) {
    super(`transaction ${description} not found`);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(playerId: string, currency: string) {
    super(`player ${playerId} already has a ${currency} wallet`);
  }
}

export class PermanentMessageError extends ApplicationError {
  readonly code = 'PERMANENT_MESSAGE_FAILURE';

  constructor(message: string) {
    super(message);
  }
}

/** Infrastructure hiccup (connection, lock timeout, deadlock...): nothing was committed, retrying is safe. */
export class TransientInfrastructureError extends ApplicationError {
  readonly code = 'TRANSIENT_INFRASTRUCTURE_FAILURE';

  constructor(message: string, options?: { cause: unknown }) {
    super(message);
    if (options) this.cause = options.cause;
  }
}
