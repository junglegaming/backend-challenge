import { DomainError } from "../../../shared/domain/domain-error";

export class InsufficientFundsError extends DomainError {
  readonly code = "INSUFFICIENT_FUNDS";

  constructor(
    readonly walletId: string,
    readonly balance: string,
    readonly requested: string,
  ) {
    super(`Wallet ${walletId} has insufficient funds`);
  }
}

export class InvalidLedgerEntryError extends DomainError {
  readonly code = "INVALID_LEDGER_ENTRY";

  constructor(reason: string) {
    super(`Invalid ledger entry: ${reason}`);
  }
}

export class InvalidWalletOperationError extends DomainError {
  readonly code = "INVALID_WALLET_OPERATION";

  constructor(reason: string) {
    super(reason);
  }
}
