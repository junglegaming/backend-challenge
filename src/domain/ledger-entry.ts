import { InvariantError } from './errors';
import { Money } from './money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface LedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  walletVersion: number; // versão da wallet depois deste lançamento
  createdAt: Date;
}

/**
 * Lançamento do ledger. Imutável: só campos readonly e objeto congelado.
 * No banco, um trigger também impede UPDATE e DELETE.
 */
export class WalletLedgerEntry {
  readonly id!: string;
  readonly walletId!: string;
  readonly transactionId!: string;
  readonly direction!: LedgerDirection;
  readonly money!: Money;
  readonly balanceBefore!: Money;
  readonly balanceAfter!: Money;
  readonly walletVersion!: number;
  readonly createdAt!: Date;

  private constructor(props: LedgerEntryProps) {
    Object.assign(this, props);
    Object.freeze(this);
  }

  /** Cria um lançamento novo, conferindo a conta: antes ± valor = depois. */
  static create(props: LedgerEntryProps): WalletLedgerEntry {
    const entry = new WalletLedgerEntry(props);
    if (!entry.money.isPositive() || entry.balanceAfter.isNegative() || !entry.isBalanced()) {
      const { balanceBefore, direction, money, balanceAfter } = entry;
      throw new InvariantError(`lançamento inválido: ${balanceBefore} ${direction} ${money} = ${balanceAfter}`);
    }
    return entry;
  }

  /** Reconstrói um lançamento lido do banco. */
  static rehydrate(props: LedgerEntryProps): WalletLedgerEntry {
    return new WalletLedgerEntry(props);
  }

  /** A conta fecha? balanceBefore ± money = balanceAfter (+ no crédito, - no débito). */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
