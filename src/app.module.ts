import { Logger, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { EntityManager } from '@mikro-orm/postgresql';
import { SQSClient } from '@aws-sdk/client-sqs';
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
import { PROCESS_WAGER_TRANSACTION } from './interfaces/http/tokens';

@Module({
  imports: [MikroOrmModule.forRoot({ ...buildOrmConfig(loadConfig().databaseUrl) }), WageringModule],
  controllers: [HealthController],
  providers: [
    { provide: PROVIDER_IDENTITY_PORT, useClass: NoopProviderIdentityAdapter },
    { provide: APP_GUARD, useClass: AuthGuard },
    {
      provide: SqsEventPublisher,
      useFactory: () => {
        const config = loadConfig();
        return new SqsEventPublisher(new SQSClient({ ...config.aws, maxAttempts: 1 }), config.sqs.eventsQueueUrl);
      },
    },
    {
      provide: PublishOutbox,
      inject: [EntityManager, SqsEventPublisher],
      useFactory: (em: EntityManager, publisher: SqsEventPublisher) => {
        const logger = new Logger(PublishOutbox.name);
        return new PublishOutbox(new SqlOutboxPublisherStore(em), publisher, new SystemClock(), {
          error: (message, error) => logger.error(message, error instanceof Error ? error.stack : String(error)),
        });
      },
    },
    {
      provide: OutboxPublisherWorker,
      inject: [PublishOutbox, SqsEventPublisher],
      useFactory: (publisher: PublishOutbox, sqs: SqsEventPublisher) => new OutboxPublisherWorker(publisher, () => sqs.close()),
    },
    {
      provide: SqsWagerConsumer,
      inject: [PROCESS_WAGER_TRANSACTION],
      useFactory: (process: ProcessWagerTransaction) => {
        const config = loadConfig();
        return new SqsWagerConsumer(new SQSClient({ ...config.aws, maxAttempts: 1 }), config.sqs.queueUrl, new ConsumeWagerMessage(process));
      },
    },
  ],
})
export class AppModule {}
