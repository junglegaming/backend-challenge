import { DomainError } from '../shared/domain-error';

/** Invalid submission (maps to a 4xx payload error, never persisted as a business rejection). */
export class InvalidTransactionError extends DomainError {
  readonly code = 'INVALID_TRANSACTION';

  constructor(message: string) {
    super(message);
  }
}

/** Programming error: illegal state transition (e.g. touching a terminal transaction). */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';

  constructor(message: string) {
    super(message);
  }
}
