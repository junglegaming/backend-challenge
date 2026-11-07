import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { EntityManager } from '@mikro-orm/postgresql';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { PROVIDER_IDENTITY_PORT } from './application/ports/provider-identity.port';
import { PublishOutbox } from './application/outbox/publish-outbox';
import { NoopProviderIdentityAdapter } from './infrastructure/auth/noop-provider-identity.adapter';
import { loadConfig } from './infrastructure/config/app-config';
import { buildOrmConfig } from './infrastructure/persistence/mikro-orm.config';
import { AuthGuard } from './interfaces/http/auth.guard';
import { HealthController } from './interfaces/http/health.controller';
import { WageringModule } from './wagering.module';
import { SqlOutboxPublisherStore } from './infrastructure/persistence/outbox-publisher-store';
import { SqsEventPublisher } from './infrastructure/messaging/sqs-event-publisher';
import { SystemClock } from './infrastructure/system/system-clock-and-ids';
import { OutboxPublisherWorker } from './infrastructure/system/outbox-publisher-worker';
import { ConsumeWagerMessage } from './application/wagering/consume-wager-message';
import { ProcessWagerTransaction } from './application/wagering/process-wager-transaction';
import { SqsWagerConsumer } from './infrastructure/messaging/sqs-wager-consumer';
import { PROCESS_WAGER_TRANSACTION, READINESS } from './interfaces/http/tokens';
import { Readiness } from './infrastructure/health/readiness';
import { METRICS } from './application/ports/wallet-queries.port';
import { PrometheusMetrics } from './infrastructure/observability/prometheus-metrics';
import { JsonLogger } from './infrastructure/observability/json-logger';

@Module({
  imports: [MikroOrmModule.forRoot({ ...buildOrmConfig(loadConfig().databaseUrl) }), WageringModule],
  controllers: [HealthController],
  providers: [
    { provide: PROVIDER_IDENTITY_PORT, useClass: NoopProviderIdentityAdapter },
    { provide: APP_GUARD, useClass: AuthGuard },
    {
      provide: READINESS,
      inject: [EntityManager],
      useFactory: (em: EntityManager) => {
        const config = loadConfig();
        const logger = new JsonLogger(Readiness.name);
        return new Readiness(
          em,
          new SQSClient({ ...config.aws, maxAttempts: 1 }),
          [config.sqs.queueUrl, config.sqs.eventsQueueUrl],
          { warn: (m) => logger.warn(m) },
        );
      },
    },
    {
      provide: SqsEventPublisher,
      useFactory: () => {
        const config = loadConfig();
        return new SqsEventPublisher(new SQSClient({ ...config.aws, maxAttempts: 1 }), config.sqs.eventsQueueUrl);
      },
    },
    {
      provide: PublishOutbox,
      inject: [EntityManager, SqsEventPublisher, METRICS],
      useFactory: (em: EntityManager, publisher: SqsEventPublisher, metrics: PrometheusMetrics) => {
        const logger = new JsonLogger(PublishOutbox.name);
        return new PublishOutbox(new SqlOutboxPublisherStore(em), publisher, new SystemClock(), {
          error: () => logger.error('SQS outbox publication failed'),
        }, metrics);
      },
    },
    {
      provide: 'METRICS_PROBES',
      inject: [EntityManager, METRICS],
      useFactory: (em: EntityManager, metrics: PrometheusMetrics) => {
        const config = loadConfig();
        const sqs = new SQSClient({ ...config.aws, maxAttempts: 1 });
        metrics.configureProbes(async () => {
          const [row] = await em.fork().getConnection().execute<{ lag: string }[]>(
            `select coalesce(extract(epoch from (now() - min(occurred_at))), 0) as lag from outbox_messages where published_at is null`);
          return Math.max(0, Number(row?.lag ?? 0));
        }, async () => {
          const result = await sqs.send(new GetQueueAttributesCommand({
            QueueUrl: config.sqs.dlqUrl,
            AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
          }), { abortSignal: AbortSignal.timeout(2000) });
          const visible = result.Attributes?.ApproximateNumberOfMessages;
          const inFlight = result.Attributes?.ApproximateNumberOfMessagesNotVisible;
          if (visible === undefined || inFlight === undefined) throw new Error('DLQ attributes missing');
          return Number(visible) + Number(inFlight);
        });
        return { onModuleDestroy: () => sqs.destroy() };
      },
    },
    {
      provide: OutboxPublisherWorker,
      inject: [PublishOutbox, SqsEventPublisher],
      useFactory: (publisher: PublishOutbox, sqs: SqsEventPublisher) => new OutboxPublisherWorker(publisher, () => sqs.close()),
    },
    {
      provide: SqsWagerConsumer,
      inject: [PROCESS_WAGER_TRANSACTION, METRICS],
      useFactory: (process: ProcessWagerTransaction, metrics: PrometheusMetrics) => {
        const config = loadConfig();
        return new SqsWagerConsumer(new SQSClient({ ...config.aws, maxAttempts: 1 }), config.sqs.queueUrl, new ConsumeWagerMessage(process), metrics);
      },
    },
  ],
})
export class AppModule {}
