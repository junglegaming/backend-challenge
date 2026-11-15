import type { InboxMessage } from '../inbox-message';
import type { Money } from '../money';
import type { OutboxMessage } from '../outbox-message';
import type { WagerTransaction } from '../wager-transaction';
import type { Wallet } from '../wallet';
import type { WalletLedgerEntry } from '../wallet-ledger-entry';

export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  /** SELECT ... FOR UPDATE: serialises every writer of this wallet (and only this wallet). */
  findByIdForUpdate(id: string): Promise<Wallet | undefined>;
  /**
   * Inserts a new wallet or conditionally updates an existing one
   * (WHERE version = persistedVersion), then appends its uncommitted ledger
   * entries. Throws ConcurrencyConflictError if the version moved.
   */
  save(wallet: Wallet): Promise<void>;
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  /** sequence of the last returned entry, when more entries may exist */
  nextAfterSequence: string | undefined;
}

export interface LedgerTotals {
  /** credits - debits */
  net: Money;
  entries: number;
}

export interface LedgerRepository {
  page(walletId: string, afterSequence: string | undefined, limit: number): Promise<LedgerPage>;
  totals(walletId: string, currency: string): Promise<LedgerTotals>;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** true when a PROCESSED REFUND/ROLLBACK already reverted `referenceTransactionId` */
  isReversed(referenceTransactionId: string): Promise<boolean>;
  /** Inserts (new) or updates guarded by the previously persisted status. */
  save(tx: WagerTransaction): Promise<void>;
  /**
   * Claims due PENDING_REFERENCE transactions for this worker (FOR UPDATE SKIP
   * LOCKED + short lease on next_reference_check_at) and returns their ids.
   */
  claimDuePendingReferences(now: Date, leaseMs: number, limit: number): Promise<Array<{ id: string; walletId: string }>>;
  /** Makes pending transactions that reference (providerId, externalId) due immediately. */
  wakeDependents(providerId: string, externalTransactionId: string, now: Date): Promise<number>;
}

export interface InboxRepository {
  /** INSERT ... ON CONFLICT DO NOTHING. false when (consumer, messageId) was already received. */
  tryReceive(message: InboxMessage): Promise<boolean>;
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
}

export interface OutboxRepository {
  add(messages: readonly OutboxMessage[]): Promise<void>;
  /** Leases a batch of due messages using FOR UPDATE SKIP LOCKED. */
  claimBatch(owner: string, leaseMs: number, limit: number): Promise<OutboxMessage[]>;
  /** @returns how many rows this call marked (the rest were already published by someone else) */
  markPublished(ids: readonly string[], at: Date): Promise<number>;
  scheduleRetry(message: OutboxMessage, owner: string, error: string): Promise<void>;
  stats(): Promise<{ pending: number; oldestPendingAgeSeconds: number }>;
}

/** Repositories bound to one SQL transaction. */
export interface TransactionScope {
  readonly wallets: WalletRepository;
  readonly ledger: LedgerRepository;
  readonly transactions: WagerTransactionRepository;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;
}

export interface UnitOfWork {
  /** Runs `work` in one READ COMMITTED transaction; commits only if it resolves. */
  run<T>(work: (scope: TransactionScope) => Promise<T>, options?: { name?: string }): Promise<T>;
  /** Runs `work` in a REPEATABLE READ, READ ONLY transaction (consistent snapshot). */
  snapshot<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T>;
}

export const UNIT_OF_WORK = Symbol('UnitOfWork');
