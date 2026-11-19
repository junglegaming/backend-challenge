import { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { Global, Injectable, Module, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { OpenWallet } from './application/open-wallet';
import { EventPublisher, UnitOfWork } from './application/ports';
import { PublishOutbox } from './application/publish-outbox';
import { ResolvePendingReferences } from './application/resolve-pending-references';
import { SubmitWagerTransaction } from './application/submit-wager-transaction';
import { config } from './config';
import { OperationsController, WageringController, WalletsController } from './infra/http/controllers';
import { ProviderAuthGuard } from './infra/http/http';
import { ormConfig } from './infra/persistence/orm';
import { ReadModel } from './infra/persistence/read-model';
import { MikroUnitOfWork } from './infra/persistence/unit-of-work';
import { Poller } from './infra/poller';
import { WagerTransactionsConsumer } from './infra/sqs/consumer';
import { SqsEventPublisher } from './infra/sqs/event-publisher';
import { createSqsClient, ensureQueues, queueDepth, QUEUES, type QueueUrls } from './infra/sqs/queues';
import { logger } from './observability/logger';
import { registerGauge } from './observability/metrics';

/** Liga e desliga os processos de fundo conforme os papéis da instância. */
@Injectable()
class BackgroundWork implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly pollers: Poller[] = [];

  constructor(
    private readonly consumer: WagerTransactionsConsumer,
    private readonly publishOutbox: PublishOutbox,
    private readonly resolvePending: ResolvePendingReferences,
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
  ) {}

  onApplicationBootstrap(): void {
    if (config.roles.has('workers')) {
      this.pollers.push(
        new Poller('outbox', () => this.publishOutbox.runOnce(), config.outbox.pollMs),
        new Poller('pending-reference', () => this.resolvePending.runOnce(), config.pendingReference.pollMs),
      );
      this.pollers.forEach((poller) => poller.start());
    }
    if (config.roles.has('consumer')) this.consumer.start();
    logger.info({ roles: [...config.roles] }, 'instance started');
  }

  /** SIGTERM/SIGINT: conclui o que está em andamento antes de fechar as conexões. */
  async onApplicationShutdown(signal?: string): Promise<void> {
    logger.info({ signal }, 'shutting down');
    await Promise.all([this.consumer.stop(), ...this.pollers.map((poller) => poller.stop())]);
    await this.orm.close();
    this.sqs.destroy();
  }
}

@Global()
@Module({
  controllers: [WalletsController, WageringController, OperationsController],
  providers: [
    ProviderAuthGuard,
    BackgroundWork,
    { provide: MikroORM, useFactory: () => MikroORM.init(ormConfig()) },
    { provide: SQSClient, useFactory: createSqsClient },
    { provide: QUEUES, useFactory: ensureQueues, inject: [SQSClient] },
    { provide: UnitOfWork, useClass: MikroUnitOfWork },
    {
      provide: ReadModel,
      inject: [MikroORM, SQSClient, QUEUES],
      useFactory: (orm: MikroORM, sqs: SQSClient, queues: QueueUrls) => {
        const read = new ReadModel(orm);
        registerGauge('wager_outbox_lag_seconds', 'Idade do evento pendente mais antigo na outbox', () => read.outboxLagSeconds());
        registerGauge('wager_dlq_depth', 'Mensagens paradas na DLQ', () => queueDepth(sqs, queues.dlq));
        return read;
      },
    },
    { provide: EventPublisher, inject: [SQSClient, QUEUES], useFactory: (sqs: SQSClient, q: QueueUrls) => new SqsEventPublisher(sqs, q.events) },
    // Casos de uso são classes puras; o Nest só os instancia.
    { provide: SubmitWagerTransaction, inject: [UnitOfWork], useFactory: (uow: UnitOfWork) => new SubmitWagerTransaction(uow) },
    { provide: OpenWallet, inject: [UnitOfWork], useFactory: (uow: UnitOfWork) => new OpenWallet(uow) },
    { provide: ResolvePendingReferences, inject: [UnitOfWork], useFactory: (uow: UnitOfWork) => new ResolvePendingReferences(uow) },
    {
      provide: PublishOutbox,
      inject: [UnitOfWork, EventPublisher],
      useFactory: (uow: UnitOfWork, publisher: EventPublisher) => new PublishOutbox(uow, publisher),
    },
    {
      provide: WagerTransactionsConsumer,
      inject: [SQSClient, QUEUES, SubmitWagerTransaction],
      useFactory: (sqs: SQSClient, q: QueueUrls, submit: SubmitWagerTransaction) => new WagerTransactionsConsumer(sqs, q, submit),
    },
  ],
})
export class AppModule {}
