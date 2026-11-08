import { DomainError } from './errors';
import { LedgerDirection, WalletLedgerEntry } from './ledger-entry';
import { Money } from './money';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Movement {
  entryId: string; // id do lançamento que será criado
  transactionId: string;
  money: Money;
  at: Date;
}

/**
 * Carteira do jogador. O saldo só muda por `debit` e `credit`, e os dois
 * devolvem o lançamento do ledger — assim saldo e ledger nunca divergem.
 * A `version` começa em 1 e sobe 1 a cada mudança de saldo.
 */
export class Wallet {
  private constructor(private state: WalletState) {}

  /**
   * Abre a wallet na versão 1. Se o saldo inicial for > 0, devolve também o
   * lançamento CREDIT da transação de abertura (OPENING).
   */
  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    openingTransactionId: string;
    openingEntryId: string;
    at: Date;
  }): { wallet: Wallet; openingEntry?: WalletLedgerEntry } {
    const { initialBalance, at } = props;
    const wallet = new Wallet({
      id: props.id,
      playerId: props.playerId,
      currency: initialBalance.currency,
      balance: initialBalance,
      version: 1,
      createdAt: at,
      updatedAt: at,
    });
    if (initialBalance.isZero()) return { wallet };

    const openingEntry = WalletLedgerEntry.create({
      id: props.openingEntryId,
      walletId: props.id,
      transactionId: props.openingTransactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: initialBalance,
      walletVersion: 1,
      createdAt: at,
    });
    return { wallet, openingEntry };
  }

  /** Reconstrói a wallet lida do banco (sem revalidar nada). */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet({ ...state });
  }

  get id() { return this.state.id; }
  get playerId() { return this.state.playerId; }
  get currency() { return this.state.currency; }
  get balance() { return this.state.balance; }
  get version() { return this.state.version; }
  get createdAt() { return this.state.createdAt; }
  get updatedAt() { return this.state.updatedAt; }

  /** O saldo cobre esse valor? */
  canAfford(money: Money): boolean {
    return !this.balance.isLessThan(money);
  }

  /** Debita; lança INSUFFICIENT_FUNDS se o saldo ficaria negativo. */
  debit(movement: Movement): WalletLedgerEntry {
    if (!this.canAfford(movement.money)) {
      throw new DomainError('INSUFFICIENT_FUNDS', `wallet ${this.id} sem saldo suficiente`);
    }
    return this.move(LedgerDirection.Debit, movement);
  }

  /** Credita; não tem limite. */
  credit(movement: Movement): WalletLedgerEntry {
    return this.move(LedgerDirection.Credit, movement);
  }

  /** Muda o saldo, sobe a versão e devolve o lançamento correspondente. */
  private move(direction: LedgerDirection, { entryId, transactionId, money, at }: Movement): WalletLedgerEntry {
    const before = this.balance;
    const after = direction === LedgerDirection.Credit ? before.add(money) : before.subtract(money); // valida a moeda
    // o lançamento é criado (e validado) antes de mudar o estado
    const entry = WalletLedgerEntry.create({
      id: entryId,
      walletId: this.id,
      transactionId,
      direction,
      money,
      balanceBefore: before,
      balanceAfter: after,
      walletVersion: this.version + 1,
      createdAt: at,
    });
    this.state = { ...this.state, balance: after, version: this.version + 1, updatedAt: at };
    return entry;
  }
}
