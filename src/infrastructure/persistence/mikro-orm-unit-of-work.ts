import { IsolationLevel } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { TransientInfrastructureError } from '../../application/errors';
import type { TransactionScope, UnitOfWork } from '../../domain/ports/repositories';
import { translateDatabaseError } from './database-errors';
import { MikroTransactionScope } from './repositories/mikro-orm-repositories';

export interface UnitOfWorkOptions {
  lockTimeoutMs: number;
  statementTimeoutMs: number;
  /** observes lock contention (lock timeout, deadlock, serialization, version guard) */
  onLockConflict?: (reason: string) => void;
}

const LOCK_REASONS = new Set(['lock-timeout', 'deadlock', 'serialization', 'optimistic-lock']);

/**
 * One call = one SQL transaction on a fresh EntityManager fork (its own
 * identity map). Commit happens only when `work` resolves; any error rolls
 * back and is translated into the application error taxonomy.
 *
 * lock_timeout bounds how long a writer waits for a hot wallet's row lock;
 * hitting it surfaces as a transient error (HTTP 503 / SQS retry) instead of
 * an unbounded queue of blocked connections.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly options: UnitOfWorkOptions,
  ) {}

  run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T> {
    return this.transactional(IsolationLevel.READ_COMMITTED, false, work);
  }

  snapshot<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T> {
    return this.transactional(IsolationLevel.REPEATABLE_READ, true, work);
  }

  private async transactional<T>(
    isolationLevel: IsolationLevel,
    readOnly: boolean,
    work: (scope: TransactionScope) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(
        async (em) => {
          await this.configure(em as EntityManager, readOnly);
          return work(new MikroTransactionScope(em as EntityManager));
        },
        { isolationLevel },
      );
    } catch (error) {
      const translated = translateDatabaseError(error);
      if (translated instanceof TransientInfrastructureError && LOCK_REASONS.has(translated.reason)) {
        this.options.onLockConflict?.(translated.reason);
      }
      throw translated;
    }
  }

  private async configure(em: EntityManager, readOnly: boolean): Promise<void> {
    if (readOnly) {
      await em.execute('SET TRANSACTION READ ONLY');
    }
    await em.execute(`SELECT set_config('lock_timeout', ?, true), set_config('statement_timeout', ?, true)`, [
      `${this.options.lockTimeoutMs}ms`,
      `${this.options.statementTimeoutMs}ms`,
    ]);
  }
}
