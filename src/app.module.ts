import { MikroORM } from '@mikro-orm/postgresql';
import {
  type BeforeApplicationShutdown,
  type DynamicModule,
  Inject,
  Injectable,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import type { Logger } from 'pino';
import { OpenWallet } from './application/open-wallet';
import {
  PENDING_REFERENCE_POLICY,
  type PendingReferencePolicy,
  STRUCTURED_LOGGER,
  type StructuredLogger,
  WAGERING_METRICS,
} from './application/ports';
import { WageringQueries } from './application/queries';
import { ReconcileWallet } from './application/reconcile-wallet';
import { ResolvePendingReferences } from './application/resolve-pending-references';
import { SubmitWagerTransaction } from './application/submit-wager-transaction';
import { WagerProcessor } from './application/wager-processor';
import { WALLET_ADMISSION, WalletAdmission } from './application/wallet-admission';
import { UNIT_OF_WORK, type UnitOfWork } from './domain/ports/repositories';
import { CLOCK, type Clock, ID_GENERATOR, systemClock, uuidV7Generator } from './domain/ports/system';
import { APP_CONFIG, type AppConfig } from './infrastructure/config/app-config';
import { MetricsSampler, PendingReferenceWorker } from './infrastructure/messaging/background-workers';
import { OutboxPublisher } from './infrastructure/messaging/outbox-publisher';
import { SqsGateway } from './infrastructure/messaging/sqs-gateway';
import { PinoStructuredLogger } from './infrastructure/observability/logger';
import { PrometheusMetrics } from './infrastructure/observability/metrics';
import { MikroOrmUnitOfWork } from './infrastructure/persistence/mikro-orm-unit-of-work';
import { buildOrmConfig } from './infrastructure/persistence/orm-config';
import { AUTHENTICATOR, AuthGuard, NoopAuthenticator } from './interface/http/auth';
import { WageringController, WalletsController } from './interface/http/controllers';
import { CorrelationMiddleware } from './interface/http/correlation.middleware';
import { HealthController, MIKRO_ORM } from './interface/http/health.controller';
import { HttpExceptionFilter } from './interface/http/http-exception.filter';
import { WagerTransactionsConsumer } from './interface/sqs/wager-transactions-consumer';

export const ROOT_LOGGER = Symbol('RootLogger');

/**
 * Starts/stops the background workers and releases shared resources. The
 * SQS consumer drains in its own beforeApplicationShutdown hook; the database
 * and the SQS client are closed last, in onApplicationShutdown.
 */
@Injectable()
export class WorkersLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  readonly outboxPublisher: OutboxPublisher;
  readonly pendingReferenceWorker: PendingReferenceWorker;
  private readonly sampler: MetricsSampler;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(UNIT_OF_WORK) uow: UnitOfWork,
    @Inject(CLOCK) clock: Clock,
    @Inject(STRUCTURED_LOGGER) logger: StructuredLogger,
    @Inject(MIKRO_ORM) private readonly orm: MikroORM,
    private readonly sqs: SqsGateway,
    metrics: PrometheusMetrics,
    resolver: ResolvePendingReferences,
  ) {
    this.outboxPublisher = new OutboxPublisher(uow, sqs, clock, metrics, logger, {
      instanceId: config.INSTANCE_ID,
      batchSize: config.OUTBOX_BATCH_SIZE,
      leaseMs: config.OUTBOX_LEASE_MS,
      pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS,
    });
    this.pendingReferenceWorker = new PendingReferenceWorker(
      resolver,
      logger,
      config.PENDING_REFERENCE_POLL_INTERVAL_MS,
      config.PENDING_REFERENCE_BATCH_SIZE,
    );
    this.sampler = new MetricsSampler(uow, sqs, metrics, logger, config.METRICS_SAMPLE_INTERVAL_MS);
  }

  onApplicationBootstrap(): void {
    if (this.config.OUTBOX_ENABLED) this.outboxPublisher.start();
    if (this.config.PENDING_REFERENCE_ENABLED) this.pendingReferenceWorker.start();
    this.sampler.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all([this.outboxPublisher.stop(), this.pendingReferenceWorker.stop(), this.sampler.stop()]);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
    this.sqs.destroy();
  }
}

@Module({})
export class AppModule implements NestModule {
  static forRoot(config: AppConfig, rootLogger: Logger): DynamicModule {
    return {
      module: AppModule,
      controllers: [WalletsController, WageringController, HealthController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: ROOT_LOGGER, useValue: rootLogger },
        { provide: STRUCTURED_LOGGER, useValue: new PinoStructuredLogger(rootLogger) },
        { provide: CLOCK, useValue: systemClock },
        { provide: ID_GENERATOR, useValue: uuidV7Generator },
        { provide: PrometheusMetrics, useValue: new PrometheusMetrics() },
        { provide: WAGERING_METRICS, useExisting: PrometheusMetrics },
        {
          provide: PENDING_REFERENCE_POLICY,
          useValue: {
            maxAttempts: config.PENDING_REFERENCE_MAX_ATTEMPTS,
            baseDelayMs: config.PENDING_REFERENCE_BASE_DELAY_MS,
            maxDelayMs: config.PENDING_REFERENCE_MAX_DELAY_MS,
          } satisfies PendingReferencePolicy,
        },
        {
          provide: MIKRO_ORM,
          useFactory: () => MikroORM.init(buildOrmConfig(config.DATABASE_URL, config.DATABASE_POOL_MAX)),
        },
        {
          provide: UNIT_OF_WORK,
          inject: [MIKRO_ORM, PrometheusMetrics],
          useFactory: (orm: MikroORM, metrics: PrometheusMetrics) =>
            new MikroOrmUnitOfWork(orm, {
              lockTimeoutMs: config.DB_LOCK_TIMEOUT_MS,
              statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
              onLockConflict: (reason) => metrics.lockConflict(reason),
            }),
        },
        {
          provide: WALLET_ADMISSION,
          inject: [PrometheusMetrics],
          useFactory: (metrics: PrometheusMetrics) =>
            new WalletAdmission(
              { maxInFlight: config.WALLET_MAX_IN_FLIGHT, maxQueue: config.WALLET_MAX_QUEUE, maxWaitMs: config.WALLET_MAX_WAIT_MS },
              (outcome) => metrics.walletAdmission(outcome),
            ),
        },
        { provide: SqsGateway, useFactory: () => new SqsGateway(config) },
        { provide: AUTHENTICATOR, useClass: NoopAuthenticator },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: HttpExceptionFilter },
        WagerProcessor,
        SubmitWagerTransaction,
        OpenWallet,
        WageringQueries,
        ReconcileWallet,
        ResolvePendingReferences,
        WagerTransactionsConsumer,
        WorkersLifecycle,
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*');
  }
}
