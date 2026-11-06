import { CurrencyMismatchError } from '../shared/domain-error';
import { Money } from '../shared/money';
import { LedgerDirection } from './ledger-direction';
import { WalletLedgerEntry } from './wallet-ledger-entry';
import { InsufficientFundsError, InvalidAmountError, InvalidWalletError } from './wallet.errors';

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  now?: Date;
}

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
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

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

  /** New wallet: version starts at 1 and the balance equals the initial balance. */
  static open(props: OpenWalletProps): Wallet {
    if (!props.id || !props.playerId) {
      throw new InvalidWalletError('id and playerId are required');
    }
    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletError('initial balance must not be negative');
    }
    const now = props.now ?? new Date();
    return new Wallet(props.id, props.playerId, props.initialBalance.currency, props.initialBalance, 1, now, now);
  }

  /** Reconstruction from persistence — does not re-validate. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      new Date(state.createdAt),
      new Date(state.updatedAt),
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

  /**
   * Ledger entry for the OPENING credit of a freshly opened wallet (zero→initial balance).
   * Returns undefined for a zero initial balance. Does not change wallet state.
   */
  openingEntry(movement: Omit<WalletMovement, 'money'>): WalletLedgerEntry | undefined {
    if (this._version !== 1) {
      throw new InvalidWalletError('opening entry is only valid for a wallet that has not moved yet');
    }
    if (this._balance.isZero()) return undefined;
    return WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction: LedgerDirection.Credit,
      money: this._balance,
      balanceBefore: Money.zero(this.currency),
      balanceAfter: this._balance,
      createdAt: movement.at,
    });
  }

  debit(movement: WalletMovement): WalletLedgerEntry {
    this.assertMovable(movement.money);
    if (this._balance.isLessThan(movement.money)) {
      throw new InsufficientFundsError(this._balance.toString(), movement.money.toString());
    }
    return this.apply(LedgerDirection.Debit, movement, this._balance.subtract(movement.money));
  }

  credit(movement: WalletMovement): WalletLedgerEntry {
    this.assertMovable(movement.money);
    return this.apply(LedgerDirection.Credit, movement, this._balance.add(movement.money));
  }

  private assertMovable(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvalidAmountError('movement amount must be positive');
    }
  }

  // The entry is built (and validated) before any state is touched, so a failure leaves the wallet intact.
  private apply(direction: LedgerDirection, m: WalletMovement, balanceAfter: Money): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: m.entryId,
      walletId: this.id,
      transactionId: m.transactionId,
      direction,
      money: m.money,
      balanceBefore: this._balance,
      balanceAfter,
      createdAt: m.at,
    });
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = m.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
