export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {}
export class CurrencyMismatchError extends DomainError {}
export class InsufficientFundsError extends DomainError {}
export class InvalidTransactionStateError extends DomainError {}
export class InvalidTransactionInputError extends DomainError {}
