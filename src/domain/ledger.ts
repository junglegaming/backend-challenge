import { DomainError, Money } from './money';
export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}
export class WalletLedgerEntry {
  private constructor(
    readonly id: string,
    readonly walletId: string,
    readonly transactionId: string,
    readonly direction: LedgerDirection,
    readonly money: Money,
    readonly balanceBefore: Money,
    readonly balanceAfter: Money,
    readonly createdAt: Date,
  ) {}
  static create(p: {
    id: string;
    walletId: string;
    transactionId: string;
    direction: LedgerDirection;
    money: Money;
    balanceBefore: Money;
    balanceAfter: Money;
    createdAt: Date;
  }) {
    const expected =
      p.direction === LedgerDirection.Credit
        ? p.balanceBefore.add(p.money)
        : p.balanceBefore.subtract(p.money);
    if (!expected.equals(p.balanceAfter))
      throw new DomainError('UNBALANCED_LEDGER', 'Ledger movement does not reconcile');
    return new WalletLedgerEntry(
      p.id,
      p.walletId,
      p.transactionId,
      p.direction,
      p.money,
      p.balanceBefore,
      p.balanceAfter,
      p.createdAt,
    );
  }
  static rehydrate(p: {
    id: string;
    walletId: string;
    transactionId: string;
    direction: LedgerDirection;
    money: Money;
    balanceBefore: Money;
    balanceAfter: Money;
    createdAt: Date;
  }) {
    return new WalletLedgerEntry(
      p.id,
      p.walletId,
      p.transactionId,
      p.direction,
      p.money,
      p.balanceBefore,
      p.balanceAfter,
      p.createdAt,
    );
  }
  isBalanced() {
    try {
      return (
        this.direction === LedgerDirection.Credit
          ? this.balanceBefore.add(this.money)
          : this.balanceBefore.subtract(this.money)
      ).equals(this.balanceAfter);
    } catch {
      return false;
    }
  }
}
