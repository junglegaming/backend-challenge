import { Money, type MoneyProps } from "../money/money";
import { CurrencyMismatchError, InsufficientFundsError, InvalidMoneyError } from "../shared/errors";
import { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Wallet aggregate root.
 *
 * Invariants owned here:
 *  - balance is never negative;
 *  - every balance change produces exactly one ledger entry (debit/credit
 *    return the entry, there is no other way to change the balance);
 *  - the operation currency must match the wallet currency;
 *  - `version` starts at 1 and increments only when the balance changes.
 *
 * Concurrency (lost updates) is handled by the persistence layer: the wallet
 * row is locked (SELECT ... FOR UPDATE) and updated with `WHERE version = ?`.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Opens a wallet with balance zero and version 1. A positive initial balance
   * must be applied through `openingCredit()` so that it gets a ledger entry.
   */
  static open(props: { id: string; playerId: string; currency: string; at: Date }): Wallet {
    return new Wallet(
      props.id,
      props.playerId,
      props.currency,
      Money.zero(props.currency),
      1,
      props.at,
      props.at,
    );
  }

  /** Rebuilds a wallet from persisted state. Does not re-validate. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** True when the wallet has enough balance to be debited `money`. */
  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  /** Removes `money` from the balance. Throws InsufficientFundsError if it would go negative. */
  debit(money: Money, transactionId: string, at: Date): WalletLedgerEntry {
    if (!this.canDebit(money)) {
      throw new InsufficientFundsError();
    }
    return this.apply(LedgerDirection.Debit, money, transactionId, at);
  }

  /** Adds `money` to the balance. */
  credit(money: Money, transactionId: string, at: Date): WalletLedgerEntry {
    this.assertSameCurrency(money);
    return this.apply(LedgerDirection.Credit, money, transactionId, at);
  }

  /**
   * Opening credit applied right after `open()`. It keeps version 1, as the
   * contract requires ("version starts at 1 after creation").
   */
  openingCredit(money: Money, transactionId: string, at: Date): WalletLedgerEntry {
    this.assertSameCurrency(money);
    const entry = WalletLedgerEntry.create({
      walletId: this.id,
      transactionId,
      direction: LedgerDirection.Credit,
      money,
      balanceBefore: this._balance,
      balanceAfter: this._balance.add(money),
      walletVersion: this._version,
      createdAt: at,
    });
    this._balance = entry.balanceAfter;
    this._updatedAt = at;
    return entry;
  }

  toJSON(): { id: string; playerId: string; balance: MoneyProps; version: number } {
    return {
      id: this.id,
      playerId: this.playerId,
      balance: this._balance.toJSON(),
      version: this._version,
    };
  }

  private apply(
    direction: LedgerDirection,
    money: Money,
    transactionId: string,
    at: Date,
  ): WalletLedgerEntry {
    if (!money.isPositive()) {
      throw new InvalidMoneyError("Balance movements must be strictly positive");
    }
    const balanceAfter =
      direction === LedgerDirection.Credit ? this._balance.add(money) : this._balance.subtract(money);
    const entry = WalletLedgerEntry.create({
      walletId: this.id,
      transactionId,
      direction,
      money,
      balanceBefore: this._balance,
      balanceAfter,
      walletVersion: this._version + 1,
      createdAt: at,
    });
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}

