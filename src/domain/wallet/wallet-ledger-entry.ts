import { Money, type MoneyProps } from "../money/money";
import { UnbalancedLedgerEntryError } from "../shared/errors";
import { newId } from "../shared/id";

export enum LedgerDirection {
  Debit = "DEBIT",
  Credit = "CREDIT",
}

export interface CreateLedgerEntryProps {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  /** Wallet version produced by this movement (one entry per version). */
  walletVersion: number;
  createdAt: Date;
}

export interface LedgerEntryState extends CreateLedgerEntryProps {
  id: string;
}

/**
 * Immutable, append-only record of a single balance movement.
 *
 * Immutability is structural: every field is readonly and there is no method
 * that changes state. The database reinforces it with a trigger that blocks
 * UPDATE/DELETE on the ledger table.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly walletVersion: number,
    public readonly createdAt: Date,
  ) {}

  /** Creates a new entry and verifies its arithmetic. */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = new WalletLedgerEntry(
      newId(),
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.walletVersion,
      props.createdAt,
    );
    if (!props.money.isPositive() || !entry.isBalanced()) {
      throw new UnbalancedLedgerEntryError();
    }
    return entry;
  }

  /** Rebuilds an entry already persisted. Does not re-validate. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.walletVersion,
      state.createdAt,
    );
  }

  /** balanceBefore ± money === balanceAfter */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }

  /** Signed effect of this entry on the balance (+ for credit, - for debit). */
  signedAmount(): Money {
    return this.direction === LedgerDirection.Credit ? this.money : this.money.negate();
  }

  toJSON(): {
    id: string;
    transactionId: string;
    direction: LedgerDirection;
    money: MoneyProps;
    balanceBefore: MoneyProps;
    balanceAfter: MoneyProps;
    walletVersion: number;
    createdAt: string;
  } {
    return {
      id: this.id,
      transactionId: this.transactionId,
      direction: this.direction,
      money: this.money.toJSON(),
      balanceBefore: this.balanceBefore.toJSON(),
      balanceAfter: this.balanceAfter.toJSON(),
      walletVersion: this.walletVersion,
      createdAt: this.createdAt.toISOString(),
    };
  }
}

