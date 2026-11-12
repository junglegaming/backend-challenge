import { IsolationLevel } from "@mikro-orm/core";
import { type EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/config";
import { translateDatabaseError } from "./database-errors";
import { InboxRepository } from "./repositories/inbox.repository";
import { LedgerRepository } from "./repositories/ledger.repository";
import { OutboxRepository } from "./repositories/outbox.repository";
import { WagerTransactionRepository } from "./repositories/wager-transaction.repository";
import { WalletRepository } from "./repositories/wallet.repository";

/**
 * Every repository bound to the same EntityManager, i.e. to the same SQL
 * transaction. Use cases receive this object, so it is impossible to write the
 * wallet in one transaction and the ledger/outbox in another.
 */
export class TransactionContext {
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: LedgerRepository;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;

  constructor(em: EntityManager) {
    this.wallets = new WalletRepository(em);
    this.transactions = new WagerTransactionRepository(em);
    this.ledger = new LedgerRepository(em);
    this.inbox = new InboxRepository(em);
    this.outbox = new OutboxRepository(em);
  }
}

/** Runs units of work against PostgreSQL. */
@Injectable()
export class TransactionRunner {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Executes `work` inside a single SQL transaction: everything commits
   * together or nothing does. Waiting for row locks is bounded by
   * `lock_timeout`; lock timeouts, deadlocks and connection failures surface
   * as TransientError so callers can retry safely.
   */
  async run<T>(work: (ctx: TransactionContext) => Promise<T>, options?: { isolationLevel?: IsolationLevel }): Promise<T> {
    try {
      const em = this.orm.em.fork() as EntityManager;
      return await em.transactional(
        async (txEm) => {
          await txEm.execute(`SET LOCAL lock_timeout = '${this.config.database.lockTimeoutMs}ms'`);
          return work(new TransactionContext(txEm));
        },
        { isolationLevel: options?.isolationLevel ?? IsolationLevel.READ_COMMITTED },
      );
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }

  /** Read-only access outside an explicit transaction (single statements). */
  async read<T>(work: (ctx: TransactionContext) => Promise<T>): Promise<T> {
    try {
      return await work(new TransactionContext(this.orm.em.fork() as EntityManager));
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }

  /** Cheap connectivity probe used by the readiness check. */
  async ping(): Promise<void> {
    await this.read(async () => {
      await (this.orm.em.fork() as EntityManager).execute("SELECT 1");
    });
  }
}

