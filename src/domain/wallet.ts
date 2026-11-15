import { CurrencyMismatchError, InsufficientFundsError, InvalidValueError } from './errors';
import { Money } from './money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  /** required when initialBalance > 0: id of the internal OPENING transaction */
  openingTransactionId?: string;
  openingEntryId?: string;
  now: Date;
}

/** One balance movement. */
export interface WalletMovement {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

/**
 * Aggregate root. The balance can only change through debit/credit, and each
 * of them produces exactly one ledger entry that is kept as "uncommitted"
 * until the repository persists it in the same SQL transaction as the wallet.
 * This makes "every balance change has a ledger entry" structural.
 */
export class Wallet {
  private readonly _uncommittedEntries: WalletLedgerEntry[] = [];

  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
    /** version as loaded from storage — used for the conditional UPDATE */
    private readonly _persistedVersion: number | undefined,
  ) {}

  static open(props: OpenWalletProps): Wallet {
    const { initialBalance } = props;
    if (initialBalance.isNegative()) {
      throw new InvalidValueError('Initial balance cannot be negative');
    }
    const zero = Money.zero(initialBalance.currency);
    const wallet = new Wallet(props.id, props.playerId, initialBalance.currency, zero, 1, props.now, props.now, undefined);
    if (initialBalance.isPositive()) {
      if (!props.openingTransactionId || !props.openingEntryId) {
        throw new InvalidValueError('A positive initial balance requires an OPENING transaction');
      }
      // The opening credit is version 1 itself (version starts at 1 after creation).
      wallet.apply(LedgerDirection.Credit, {
        entryId: props.openingEntryId,
        transactionId: props.openingTransactionId,
        money: initialBalance,
        at: props.now,
      }, false);
    }
    return wallet;
  }

  /** Reconstruction from persistence — does not re-validate transitions. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
      state.version,
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

  /** undefined for a wallet that was never persisted. */
  get persistedVersion(): number | undefined {
    return this._persistedVersion;
  }

  isNew(): boolean {
    return this._persistedVersion === undefined;
  }

  canAfford(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  /** @throws InsufficientFundsError when the balance would become negative */
  debit(movement: WalletMovement): WalletLedgerEntry {
    return this.apply(LedgerDirection.Debit, movement, true);
  }

  credit(movement: WalletMovement): WalletLedgerEntry {
    return this.apply(LedgerDirection.Credit, movement, true);
  }

  /** Ledger entries produced since the wallet was loaded and not yet persisted. */
  get uncommittedEntries(): readonly WalletLedgerEntry[] {
    return this._uncommittedEntries;
  }

  /** Hands the pending ledger entries to the repository (and forgets them). */
  pullUncommittedEntries(): WalletLedgerEntry[] {
    return this._uncommittedEntries.splice(0, this._uncommittedEntries.length);
  }

  private apply(direction: LedgerDirection, movement: WalletMovement, bumpVersion: boolean): WalletLedgerEntry {
    this.assertSameCurrency(movement.money);
    if (!movement.money.isPositive()) {
      throw new InvalidValueError('Movement amount must be positive');
    }
    const before = this._balance;
    const after = direction === LedgerDirection.Credit ? before.add(movement.money) : before.subtract(movement.money);
    if (after.isNegative()) {
      throw new InsufficientFundsError();
    }
    const nextVersion = bumpVersion ? this._version + 1 : this._version;
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore: before,
      balanceAfter: after,
      walletVersion: nextVersion,
      createdAt: movement.at,
    });
    this._balance = after;
    this._version = nextVersion;
    this._updatedAt = movement.at;
    this._uncommittedEntries.push(entry);
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (!money.hasCurrency(this.currency)) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
