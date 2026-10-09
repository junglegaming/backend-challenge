import type { InboxRepository, OutboxRepository } from "../../modules/messaging/application/messaging-ports";
import type {
  SubmissionFailureRepository,
  WagerTransactionRepository,
} from "../../modules/wagering/application/wagering-ports";
import type { LedgerRepository, WalletRepository } from "../../modules/wallet/application/wallet-ports";

/** Repositories bound to one SQL transaction. */
export interface TransactionScope {
  wallets: WalletRepository;
  wagers: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
  failures: SubmissionFailureRepository;
}

export interface TransactionOptions {
  /** Used for logs/metrics. */
  label: string;
  /** Default true: lock timeouts, deadlocks, serialization failures and connection loss are retried with jitter. */
  retryTransient?: boolean;
}

export interface UnitOfWork {
  /** READ COMMITTED read-write transaction with SET LOCAL lock/statement timeouts. Commit or rollback as one. */
  transaction<T>(work: (scope: TransactionScope) => Promise<T>, options: TransactionOptions): Promise<T>;
  /** REPEATABLE READ, READ ONLY: one consistent snapshot without taking row locks. */
  snapshot<T>(work: (scope: TransactionScope) => Promise<T>, options: TransactionOptions): Promise<T>;
}

export const UNIT_OF_WORK = Symbol("UNIT_OF_WORK");
