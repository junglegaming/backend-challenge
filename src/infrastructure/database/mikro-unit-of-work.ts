import { IsolationLevel } from "@mikro-orm/core";
import type { EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { TransientInfrastructureError } from "../../shared/application/errors";
import type { AppLogger, AppMetrics } from "../../shared/application/observability";
import type { TransactionOptions, TransactionScope, UnitOfWork } from "../../shared/application/unit-of-work";
import { LOCK_CONFLICT_REASONS, transientReason } from "./db-errors";
import {
  IdempotencyRaceError,
  MikroInboxRepository,
  MikroLedgerRepository,
  MikroOutboxRepository,
  MikroSubmissionFailureRepository,
  MikroWagerTransactionRepository,
  MikroWalletRepository,
  OptimisticConcurrencyError,
} from "./repositories/repositories";

export interface UnitOfWorkSettings {
  lockTimeoutMs: number;
  statementTimeoutMs: number;
  maxAttempts: number;
}

function scopeFor(em: EntityManager): TransactionScope {
  return {
    wallets: new MikroWalletRepository(em),
    wagers: new MikroWagerTransactionRepository(em),
    ledger: new MikroLedgerRepository(em),
    inbox: new MikroInboxRepository(em),
    outbox: new MikroOutboxRepository(em),
    failures: new MikroSubmissionFailureRepository(em),
  };
}

/**
 * MikroORM-backed unit of work. Each call forks a fresh EntityManager (isolated identity map) and runs the
 * work inside `em.transactional()`. Writes are explicit (insert/nativeUpdate/raw SQL) so every financial
 * statement is visible and reviewable; the ORM provides the transaction boundary, mapping and pooling.
 *
 * Transient failures (lock timeout, deadlock, serialization failure, connection loss, idempotency races)
 * roll back and retry the *whole* transaction a bounded number of times with jitter; after that they surface
 * as TransientInfrastructureError (HTTP 503 / SQS visibility backoff).
 */
export class MikroUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly settings: UnitOfWorkSettings,
    private readonly metrics: AppMetrics,
    private readonly logger: AppLogger,
  ) {}

  transaction<T>(work: (scope: TransactionScope) => Promise<T>, options: TransactionOptions): Promise<T> {
    return this.withRetry(options, () =>
      this.orm.em.fork().transactional(
        async (em) => {
          await this.applyTimeouts(em);
          return work(scopeFor(em));
        },
        { isolationLevel: IsolationLevel.READ_COMMITTED },
      ),
    );
  }

  snapshot<T>(work: (scope: TransactionScope) => Promise<T>, options: TransactionOptions): Promise<T> {
    return this.withRetry(options, () =>
      this.orm.em.fork().transactional(
        async (em) => {
          await em.execute(`SET LOCAL statement_timeout = ${this.settings.statementTimeoutMs}`);
          return work(scopeFor(em));
        },
        { isolationLevel: IsolationLevel.REPEATABLE_READ, readOnly: true },
      ),
    );
  }

  private async applyTimeouts(em: EntityManager): Promise<void> {
    // SET LOCAL: scoped to this transaction, safe behind PgBouncer in transaction pooling mode.
    await em.execute(
      `SET LOCAL lock_timeout = ${this.settings.lockTimeoutMs}; SET LOCAL statement_timeout = ${this.settings.statementTimeoutMs}`,
    );
  }

  private async withRetry<T>(options: TransactionOptions, run: () => Promise<T>): Promise<T> {
    const maxAttempts = options.retryTransient === false ? 1 : this.settings.maxAttempts;
    for (let attempt = 1; ; attempt++) {
      try {
        return await run();
      } catch (error) {
        const reason = this.retryReason(error);
        if (!reason) throw error;
        if (LOCK_CONFLICT_REASONS.has(reason)) this.metrics.lockConflict(reason);
        if (attempt >= maxAttempts) {
          this.logger.warn(
            { operation: options.label, reason, attempts: attempt },
            "transient failure, giving up",
          );
          throw new TransientInfrastructureError(
            `${options.label} failed transiently (${reason})`,
            reason,
            error,
          );
        }
        this.metrics.transientRetry(options.label, reason);
        this.logger.debug(
          { operation: options.label, reason, attempt },
          "transient failure, retrying transaction",
        );
        await Bun.sleep(Math.round(15 * attempt + Math.random() * 35 * attempt));
      }
    }
  }

  private retryReason(error: unknown): string | undefined {
    if (error instanceof IdempotencyRaceError) return "idempotency_race";
    if (error instanceof OptimisticConcurrencyError) return "optimistic_conflict";
    return transientReason(error);
  }
}
