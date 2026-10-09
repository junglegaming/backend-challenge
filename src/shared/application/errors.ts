/**
 * Application-level errors. Each has a stable `code` and a `kind` that drives the HTTP status and
 * the SQS ack/retry/DLQ decision consistently across entry points.
 */
export type ApplicationErrorKind =
  | "VALIDATION" // 400 / DLQ (permanent)
  | "NOT_FOUND" // 404 (reads) / 422 or DLQ (submissions)
  | "CONFLICT" // 409 / DLQ (permanent)
  | "UNPROCESSABLE" // 422 / DLQ
  | "TRANSIENT"; // 503 + Retry-After / visibility backoff

export abstract class ApplicationError extends Error {
  abstract readonly code: string;
  abstract readonly kind: ApplicationErrorKind;

  protected constructor(
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends ApplicationError {
  readonly code = "VALIDATION_ERROR";
  readonly kind = "VALIDATION";

  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

export class NotFoundError extends ApplicationError {
  readonly code: string;
  readonly kind = "NOT_FOUND";

  constructor(resource: string, id: string) {
    super(`${resource} ${id} not found`, { resource, id });
    this.code = `${resource.toUpperCase().replace(/\s+/g, "_")}_NOT_FOUND`;
  }
}

/** Submission targets a wallet that does not exist (nothing to lock, nothing persisted). */
export class WalletNotFoundForSubmissionError extends ApplicationError {
  readonly code = "WALLET_NOT_FOUND";
  readonly kind = "UNPROCESSABLE";

  constructor(walletId: string) {
    super(`wallet ${walletId} does not exist`, { walletId });
  }
}

/** Wallet opening in a valid ISO-4217 currency the operator has not enabled (SUPPORTED_CURRENCIES). */
export class CurrencyNotSupportedError extends ApplicationError {
  readonly code = "CURRENCY_NOT_SUPPORTED";
  readonly kind = "UNPROCESSABLE";

  constructor(currency: string, supported: readonly string[]) {
    super(`currency ${currency} is not enabled`, { currency, supported });
  }
}

export class IdempotencyConflictError extends ApplicationError {
  readonly code = "IDEMPOTENCY_CONFLICT";
  readonly kind = "CONFLICT";

  constructor(
    reason: "PAYLOAD_MISMATCH" | "EXTERNAL_ID_REUSED" | "INBOX_PAYLOAD_MISMATCH",
    details: Record<string, unknown>,
  ) {
    super(`idempotency conflict: ${reason}`, { reason, ...details });
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = "WALLET_ALREADY_EXISTS";
  readonly kind = "CONFLICT";

  constructor(playerId: string, currency: string) {
    super(`player ${playerId} already has a ${currency} wallet`, { playerId, currency });
  }
}

/** Retryable infrastructure failure: lock timeout, deadlock, serialization failure, connection loss. */
export class TransientInfrastructureError extends ApplicationError {
  readonly code = "TRANSIENT_FAILURE";
  readonly kind = "TRANSIENT";

  constructor(
    message: string,
    readonly reason: string,
    override readonly cause?: unknown,
  ) {
    super(message, { reason });
  }
}
