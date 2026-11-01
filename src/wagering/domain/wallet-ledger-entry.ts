import { DomainError } from "../../shared/domain/domain-error";
import { Money } from "../../shared/domain/money";

export enum LedgerDirection {
  Debit = "DEBIT",
  Credit = "CREDIT",
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  walletVersion: number;
  createdAt: Date;
}

export class WalletLedgerEntry {
  private constructor(private readonly state: LedgerEntryState) {}

  static create(state: LedgerEntryState): WalletLedgerEntry {
    const entry = WalletLedgerEntry.rehydrate(state);
    if (
      !state.money.isPositive() ||
      state.balanceBefore.isNegative() ||
      state.balanceAfter.isNegative() ||
      !Number.isSafeInteger(state.walletVersion) ||
      state.walletVersion < 1 ||
      !Object.values(LedgerDirection).includes(state.direction) ||
      !entry.isBalanced()
    )
      throw new DomainError("Invalid ledger arithmetic or version");
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(Object.freeze({ ...state, createdAt: new Date(state.createdAt) }));
  }

  get id() {
    return this.state.id;
  }
  get walletId() {
    return this.state.walletId;
  }
  get transactionId() {
    return this.state.transactionId;
  }
  get direction() {
    return this.state.direction;
  }
  get money() {
    return this.state.money;
  }
  get balanceBefore() {
    return this.state.balanceBefore;
  }
  get balanceAfter() {
    return this.state.balanceAfter;
  }
  get walletVersion() {
    return this.state.walletVersion;
  }
  get createdAt() {
    return new Date(this.state.createdAt);
  }

  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
