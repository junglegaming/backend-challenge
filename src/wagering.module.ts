import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { CLOCK, type Clock, ID_GENERATOR, type IdGenerator } from './application/ports/clock-and-ids.port';
import { UNIT_OF_WORK, type UnitOfWork } from './application/ports/wagering-repositories.port';
import { METRICS, type Metrics, type WalletQueries } from './application/ports/wallet-queries.port';
import { GetTransaction, GetWallet, ListLedger, ReconcileWallet } from './application/wagering/wallet-queries';
import { PrometheusMetrics } from './infrastructure/observability/prometheus-metrics';
import { JsonLogger } from './infrastructure/observability/json-logger';
import { TraceMiddleware } from './interfaces/http/trace.middleware';
import type { Telemetry } from './application/observability/telemetry';
import { SqlWalletQueries } from './infrastructure/persistence/sql-wallet-queries';
import { OpenWallet } from './application/wagering/open-wallet';
import { ProcessWagerTransaction } from './application/wagering/process-wager-transaction';
import { RetryPendingReference } from './application/wagering/retry-pending-reference';
import { MikroOrmUnitOfWork } from './infrastructure/persistence/mikro-orm-unit-of-work';
import { SystemClock, UuidV7Generator } from './infrastructure/system/system-clock-and-ids';
import { PendingReferenceWorker } from './infrastructure/system/pending-reference-worker';
import { ApiExceptionFilter } from './interfaces/http/api-exception.filter';
import { MetricsController } from './interfaces/http/metrics.controller';
import { OPEN_WALLET, PROCESS_WAGER_TRANSACTION, WALLET_QUERIES } from './interfaces/http/tokens';
import { WageringController } from './interfaces/http/wagering.controller';

/** Wiring of the wagering use cases. Expects a MikroORM connection (EntityManager) from the importing module. */
@Module({
  controllers: [WageringController, MetricsController],
  exports: [PROCESS_WAGER_TRANSACTION, METRICS],
  providers: [
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidV7Generator },
    {
      provide: UNIT_OF_WORK,
      inject: [EntityManager, METRICS],
      useFactory: (em: EntityManager, telemetry: Telemetry): UnitOfWork => new MikroOrmUnitOfWork(em, Number(process.env.LOCK_TIMEOUT_MS ?? 5000), telemetry),
    },
    { provide: METRICS, useClass: PrometheusMetrics },
    { provide: WALLET_QUERIES, inject: [EntityManager], useFactory: (em: EntityManager) => new SqlWalletQueries(em) },
    { provide: GetWallet, inject: [WALLET_QUERIES], useFactory: (q: WalletQueries) => new GetWallet(q) },
    { provide: ListLedger, inject: [WALLET_QUERIES], useFactory: (q: WalletQueries) => new ListLedger(q) },
    { provide: GetTransaction, inject: [WALLET_QUERIES], useFactory: (q: WalletQueries) => new GetTransaction(q) },
    {
      provide: ReconcileWallet,
      inject: [WALLET_QUERIES, METRICS, CLOCK],
      useFactory: (q: WalletQueries, metrics: Metrics, clock: Clock) => {
        const logger = new JsonLogger(ReconcileWallet.name);
        return new ReconcileWallet(q, metrics, clock, { error: (m) => logger.error(m) });
      },
    },
    {
      provide: OPEN_WALLET,
      inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR, METRICS],
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator, telemetry: Telemetry) => new OpenWallet(uow, clock, ids, telemetry),
    },
    {
      provide: PROCESS_WAGER_TRANSACTION,
      inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR, METRICS],
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator, telemetry: Telemetry) => new ProcessWagerTransaction(uow, clock, ids, telemetry, new JsonLogger(ProcessWagerTransaction.name)),
    },
    {
      provide: RetryPendingReference,
      inject: [UNIT_OF_WORK, CLOCK, PROCESS_WAGER_TRANSACTION, METRICS],
      useFactory: (uow: UnitOfWork, clock: Clock, process: ProcessWagerTransaction, telemetry: Telemetry) =>
        new RetryPendingReference(uow, clock, process, telemetry),
    },
    {
      provide: PendingReferenceWorker,
      inject: [RetryPendingReference],
      useFactory: (retry: RetryPendingReference) => new PendingReferenceWorker(retry),
    },
  ],
})
export class WageringModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TraceMiddleware).forRoutes('*');
  }
}
