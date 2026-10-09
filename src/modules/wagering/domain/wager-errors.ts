import { DomainError } from "../../../shared/domain/domain-error";
import { WagerTransactionStatus } from "./wager-transaction-kind";

/** Programming error: a terminal transaction cannot transition. */
export class InvalidTransactionStateError extends DomainError {
  readonly code = "INVALID_TRANSACTION_STATE";

  constructor(
    readonly transactionId: string,
    readonly from: WagerTransactionStatus,
    readonly to: WagerTransactionStatus,
  ) {
    super(`Transaction ${transactionId} cannot transition from ${from} to ${to}`);
  }
}

/** Contract-level invalid transaction (e.g. REFUND without reference). Maps to HTTP 400 / DLQ. */
export class InvalidWagerTransactionError extends DomainError {
  readonly code = "INVALID_WAGER_TRANSACTION";

  constructor(reason: string) {
    super(reason);
  }
}
