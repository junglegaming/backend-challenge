import { Money } from '../shared/money';
import { LedgerDirection } from './ledger-direction';
import { InvalidLedgerEntryError } from './wallet.errors';

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type LedgerEntryState = CreateLedgerEntryProps;

/** Immutable by construction: only readonly fields, no transitions, frozen instance. */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (!props.id || !props.walletId || !props.transactionId) {
      throw new InvalidLedgerEntryError('id, walletId and transactionId are required');
    }
    if (!Object.values(LedgerDirection).includes(props.direction)) {
      throw new InvalidLedgerEntryError(`unknown direction ${String(props.direction)}`);
    }
    const { money, balanceBefore, balanceAfter } = props;
    if (money.currency !== balanceBefore.currency || money.currency !== balanceAfter.currency) {
      throw new InvalidLedgerEntryError('money, balanceBefore and balanceAfter must share the same currency');
    }
    if (!money.isPositive()) {
      throw new InvalidLedgerEntryError('ledger entry amount must be positive');
    }
    if (balanceBefore.isNegative() || balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError('balances must not be negative');
    }
    if (!WalletLedgerEntry.arithmeticHolds(props.direction, money, balanceBefore, balanceAfter)) {
      throw new InvalidLedgerEntryError('balanceBefore ± money must equal balanceAfter');
    }
    return WalletLedgerEntry.build(props);
  }

  /** Rebuilds an already-persisted entry; does not re-run business validation. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return WalletLedgerEntry.build(state);
  }

  /** balanceBefore ± money === balanceAfter. */
  isBalanced(): boolean {
    return WalletLedgerEntry.arithmeticHolds(this.direction, this.money, this.balanceBefore, this.balanceAfter);
  }

  /** Signed effect on the wallet balance (credit positive, debit negative). */
  signedAmount(): Money {
    return this.direction === LedgerDirection.Credit ? this.money : this.money.negate();
  }

  private static arithmeticHolds(direction: LedgerDirection, money: Money, before: Money, after: Money): boolean {
    const expected = direction === LedgerDirection.Credit ? before.add(money) : before.subtract(money);
    return expected.equals(after);
  }

  private static build(p: CreateLedgerEntryProps): WalletLedgerEntry {
    return new WalletLedgerEntry(
      p.id,
      p.walletId,
      p.transactionId,
      p.direction,
      p.money,
      p.balanceBefore,
      p.balanceAfter,
      new Date(p.createdAt),
    );
  }
}
