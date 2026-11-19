import { CurrencyMismatchError, InsufficientFundsError } from './errors';
import { newId } from './id';
import { LedgerDirection, WalletLedgerEntry } from './ledger-entry';
import { Money } from './money';

export interface WalletState {
  id: string;
  playerId: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Aggregate root. O saldo só muda por debit/credit, e toda mudança devolve o lançamento de
 * ledger correspondente — é impossível, pelo tipo, alterar saldo sem produzir o lançamento.
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
   * Abre a wallet em version 1. Saldo inicial > 0 gera o lançamento CREDIT de abertura,
   * vinculado à transação interna OPENING. A abertura não incrementa version.
   */
  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    openingTransactionId: string;
    at: Date;
  }): { wallet: Wallet; openingEntry?: WalletLedgerEntry } {
    const zero = Money.zero(props.initialBalance.currency);
    const wallet = new Wallet(props.id, props.playerId, zero.currency, zero, 1, props.at, props.at);
    if (!props.initialBalance.isPositive()) return { wallet };
    const openingEntry = wallet.apply(LedgerDirection.Credit, props.initialBalance, props.openingTransactionId, props.at);
    wallet._version = 1;
    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(s: WalletState): Wallet {
    return new Wallet(s.id, s.playerId, s.balance.currency, s.balance, s.version, s.createdAt, s.updatedAt);
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

  debit(money: Money, transactionId: string, at: Date): WalletLedgerEntry {
    this.assertSameCurrency(money);
    if (this._balance.isLessThan(money)) {
      throw new InsufficientFundsError(`wallet ${this.id} has insufficient funds`);
    }
    return this.apply(LedgerDirection.Debit, money, transactionId, at);
  }

  credit(money: Money, transactionId: string, at: Date): WalletLedgerEntry {
    this.assertSameCurrency(money);
    return this.apply(LedgerDirection.Credit, money, transactionId, at);
  }

  private apply(direction: LedgerDirection, money: Money, transactionId: string, at: Date): WalletLedgerEntry {
    const balanceBefore = this._balance;
    const balanceAfter = direction === LedgerDirection.Credit ? balanceBefore.add(money) : balanceBefore.subtract(money);
    const entry = WalletLedgerEntry.create({
      id: newId(),
      walletId: this.id,
      transactionId,
      direction,
      money,
      balanceBefore,
      balanceAfter,
      createdAt: at,
    });
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(`wallet ${this.id} is ${this.currency}, operation is ${money.currency}`);
    }
  }
}
