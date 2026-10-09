import { CurrencyMismatchError } from "../../../shared/domain/domain-error";
import { Money } from "../../../shared/domain/money";
import { LedgerDirection } from "./ledger-direction";
import { InsufficientFundsError, InvalidWalletOperationError } from "./wallet-errors";
import { WalletLedgerEntry } from "./wallet-ledger-entry";

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
  at: Date;
  /** Required when initialBalance > 0: the internal OPENING transaction and its ledger line. */
  opening?: { transactionId: string; ledgerEntryId: string };
}

export interface WalletOpening {
  wallet: Wallet;
  /** Present only when the initial balance is positive. */
  openingEntry: WalletLedgerEntry | undefined;
}

export interface MovementProps {
  ledgerEntryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

/**
 * Aggregate root. Every balance change goes through `apply`, which produces exactly one ledger entry
 * and bumps `version` — so balance and ledger cannot drift apart inside the domain.
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

  static open(props: OpenWalletProps): WalletOpening {
    const { initialBalance, at } = props;
    if (initialBalance.isNegative())
      throw new InvalidWalletOperationError("initial balance cannot be negative");

    // version starts at 1 after creation. When there is an opening credit, that credit *is* version 1.
    const wallet = new Wallet(
      props.id,
      props.playerId,
      initialBalance.currency,
      Money.zero(initialBalance.currency),
      0,
      at,
      at,
    );
    if (initialBalance.isZero()) {
      wallet._version = 1;
      return { wallet, openingEntry: undefined };
    }
    if (!props.opening) {
      throw new InvalidWalletOperationError("a positive initial balance requires an OPENING transaction");
    }
    const openingEntry = wallet.apply(LedgerDirection.Credit, {
      ledgerEntryId: props.opening.ledgerEntryId,
      transactionId: props.opening.transactionId,
      money: initialBalance,
      at,
    });
    return { wallet, openingEntry };
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

  /** @throws InsufficientFundsError when the debit would make the balance negative. */
  debit(props: MovementProps): WalletLedgerEntry {
    return this.apply(LedgerDirection.Debit, props);
  }

  credit(props: MovementProps): WalletLedgerEntry {
    return this.apply(LedgerDirection.Credit, props);
  }

  apply(direction: LedgerDirection, props: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    if (!props.money.isPositive()) throw new InvalidWalletOperationError("movement amount must be positive");

    const before = this._balance;
    const after =
      direction === LedgerDirection.Credit ? before.add(props.money) : before.subtract(props.money);
    if (after.isNegative()) {
      throw new InsufficientFundsError(this.id, before.toString(), props.money.toString());
    }

    const entry = WalletLedgerEntry.create({
      id: props.ledgerEntryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore: before,
      balanceAfter: after,
      walletVersion: this._version + 1,
      createdAt: props.at,
    });

    this._balance = after;
    this._version += 1;
    // Instances have independent clocks (skew of 100+ ms was observed under load): wall-clock time is
    // informational only — ordering is by version — so updatedAt is kept monotonic and never before createdAt.
    this._updatedAt = props.at > this._updatedAt ? props.at : this._updatedAt;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) throw new CurrencyMismatchError(this.currency, money.currency);
  }
}
