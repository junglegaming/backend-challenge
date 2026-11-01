import {
  CurrencyMismatchError,
  DomainError,
  InsufficientFundsError,
} from "../../shared/domain/domain-error";
import { Money } from "../../shared/domain/money";
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

export interface WalletMovement {
  transactionId: string;
  entryId: string;
  money: Money;
  at: Date;
}

export class Wallet {
  private constructor(private readonly state: WalletState) {}

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    openingTransactionId: string;
    openingEntryId: string;
    at: Date;
  }): { wallet: Wallet; ledgerEntry?: WalletLedgerEntry } {
    if (props.initialBalance.isNegative())
      throw new DomainError("Initial balance cannot be negative");
    const wallet = Wallet.rehydrate({
      id: props.id,
      playerId: props.playerId,
      currency: props.initialBalance.currency,
      balance: props.initialBalance,
      version: 1,
      createdAt: props.at,
      updatedAt: props.at,
    });
    const ledgerEntry = props.initialBalance.isZero()
      ? undefined
      : WalletLedgerEntry.create({
          id: props.openingEntryId,
          walletId: props.id,
          transactionId: props.openingTransactionId,
          direction: LedgerDirection.Credit,
          money: props.initialBalance,
          balanceBefore: Money.zero(wallet.currency),
          balanceAfter: props.initialBalance,
          walletVersion: 1,
          createdAt: props.at,
        });
    return { wallet, ...(ledgerEntry ? { ledgerEntry } : {}) };
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet({
      ...state,
      createdAt: new Date(state.createdAt),
      updatedAt: new Date(state.updatedAt),
    });
  }

  get id() {
    return this.state.id;
  }
  get playerId() {
    return this.state.playerId;
  }
  get currency() {
    return this.state.currency;
  }
  get balance() {
    return this.state.balance;
  }
  get version() {
    return this.state.version;
  }
  get createdAt() {
    return new Date(this.state.createdAt);
  }
  get updatedAt() {
    return new Date(this.state.updatedAt);
  }

  debit(props: WalletMovement): WalletLedgerEntry | undefined {
    return this.move(props, LedgerDirection.Debit);
  }

  credit(props: WalletMovement): WalletLedgerEntry | undefined {
    return this.move(props, LedgerDirection.Credit);
  }

  private move(props: WalletMovement, direction: LedgerDirection): WalletLedgerEntry | undefined {
    if (props.money.currency !== this.currency)
      throw new CurrencyMismatchError("Currencies differ");
    if (props.money.isNegative()) throw new DomainError("Movement cannot be negative");
    if (props.money.isZero()) return undefined;
    const after =
      direction === LedgerDirection.Credit
        ? this.balance.add(props.money)
        : this.balance.subtract(props.money);
    if (after.isNegative()) throw new InsufficientFundsError("Insufficient funds");
    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore: this.balance,
      balanceAfter: after,
      walletVersion: this.version + 1,
      createdAt: props.at,
    });
    this.state.balance = after;
    this.state.version += 1;
    this.state.updatedAt = new Date(props.at);
    return entry;
  }
}
