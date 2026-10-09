import type { Money } from "../../../shared/domain/money";
import type { Wallet } from "../../wallet/domain/wallet";
import type { WalletLedgerEntry } from "../../wallet/domain/wallet-ledger-entry";

export interface WalletRepository {
  /** @throws WalletAlreadyExistsError on (playerId, currency) conflict. */
  insert(wallet: Wallet): Promise<void>;
  findById(id: string): Promise<Wallet | undefined>;
  /** SELECT … FOR UPDATE: serialises every balance-affecting operation of this wallet (and only this wallet). */
  lockById(id: string): Promise<Wallet | undefined>;
  /** Conditional write (WHERE version = expectedVersion). Throws if the row moved underneath (defence in depth). */
  saveBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface LedgerAggregate {
  credits: Money;
  debits: Money;
  entries: number;
  maxVersion: number;
  /** Entries whose balanceBefore does not continue the previous entry's balanceAfter. */
  chainBreaks: number;
  /** Transactions of this wallet whose journal postings do not balance (double-entry). */
  unbalancedJournals: number;
  /** Σ(credit) − Σ(debit) of the wallet account in the journal; must equal the stored balance. */
  journalBalance: Money;
}

export interface LedgerRepository {
  /**
   * Inserts sub-ledger lines (multi-row, in version order) and their two journal postings each
   * (wallet leg + counterparty leg).
   */
  insertMany(entries: readonly { entry: WalletLedgerEntry; counterpartyAccount: string }[]): Promise<void>;
  /** Newest first, keyset pagination on wallet_version. */
  page(
    walletId: string,
    currency: string,
    beforeVersion: number | undefined,
    limit: number,
  ): Promise<WalletLedgerEntry[]>;
  aggregate(walletId: string, currency: string): Promise<LedgerAggregate>;
}
