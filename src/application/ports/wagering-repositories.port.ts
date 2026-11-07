import type { Money } from '../../domain/shared/money';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import type { IntegrationEvent } from '../events/integration-event';

export interface StoredTransaction {
  transaction: WagerTransaction;
  /** Wallet balance right after the transaction was applied (PROCESSED only). */
  balanceSnapshot: Money | undefined;
}

export interface WagerTransactionRepository {
  /**
   * `INSERT ... ON CONFLICT DO NOTHING` of a PENDING transaction. Returns false when the idempotency key
   * (or provider + external id) already exists, or when the wallet does not exist.
   */
  insertIfAbsent(transaction: WagerTransaction): Promise<boolean>;
  findByIdempotencyKey(key: string): Promise<StoredTransaction | undefined>;
  findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<StoredTransaction | undefined>;
  /** True when a PROCESSED REFUND/ROLLBACK already targets the given transaction. */
  isReversed(transactionId: string): Promise<boolean>;
  /** Persists the outcome (status, failure code, reference, snapshot, processedAt) of a locked transaction. */
  saveOutcome(transaction: WagerTransaction, balanceSnapshot: Money | undefined): Promise<void>;
  claimDueReference(now: Date): Promise<{ transaction: WagerTransaction; retryCount: number } | undefined>;
  scheduleReferenceRetry(transactionId: string, retryCount: number, nextAttemptAt: Date): Promise<void>;
}

export interface WalletRepository {
  /** Inserts a new wallet; returns false when (playerId, currency) already has one. */
  insertIfAbsent(wallet: Wallet): Promise<boolean>;
  /** `SELECT ... FOR UPDATE`: serializes concurrent writers of this wallet only. */
  lockById(walletId: string): Promise<Wallet | undefined>;
  /** Optimistic guard on top of the row lock: throws if the stored version is not `expectedVersion`. */
  saveBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
}

export interface OutboxRepository {
  enqueue(event: IntegrationEvent<unknown>): Promise<void>;
}

export interface InboxRepository {
  receive(consumerName: string, messageId: string, payloadHash: string, now: Date): Promise<'inserted' | 'duplicate' | 'conflict'>;
  markProcessed(consumerName: string, messageId: string, now: Date): Promise<void>;
}

export interface WageringRepositories {
  transactions: WagerTransactionRepository;
  wallets: WalletRepository;
  ledger: LedgerRepository;
  outbox: OutboxRepository;
  inbox: InboxRepository;
}

export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');

/** One SQL transaction: commits when `work` resolves (business rejections included), rolls back when it throws. */
export interface UnitOfWork {
  run<T>(work: (repositories: WageringRepositories) => Promise<T>): Promise<T>;
}
