import type { MoneyProps } from '../../domain/shared/money';
import type { StoredTransaction } from './wagering-repositories.port';

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface LedgerEntryRow {
  /** Monotonic per-table sequence: the keyset the cursor is built on. */
  seq: string;
  id: string;
  transactionId: string;
  direction: string;
  amount: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: Date;
}

export interface ReconciliationSnapshot {
  walletId: string;
  currency: string;
  walletBalance: MoneyProps;
  /** Sum of signed ledger amounts (credits - debits). */
  ledgerBalance: MoneyProps;
  /** `balance_after` of the newest ledger entry (undefined when the ledger is empty). */
  lastEntryBalance: MoneyProps | undefined;
  entryCount: number;
}

/** Read side: never locks and never writes. */
export interface WalletQueries {
  findWallet(walletId: string): Promise<WalletView | undefined>;
  /** Entries with `seq` greater than `afterSeq`, ascending; undefined when the wallet does not exist. */
  listLedger(walletId: string, afterSeq: string | undefined, limit: number): Promise<LedgerEntryRow[] | undefined>;
  findTransactionById(id: string): Promise<StoredTransaction | undefined>;
  findTransactionByProviderAndExternalId(providerId: string, externalId: string): Promise<StoredTransaction | undefined>;
  /** Wallet balance and ledger aggregates read in ONE statement (a single snapshot). */
  snapshotForReconciliation(walletId: string): Promise<ReconciliationSnapshot | undefined>;
}

export interface Metrics {
  increment(name: string, labels?: Record<string, string>): void;
}

export const METRICS = Symbol('METRICS');
