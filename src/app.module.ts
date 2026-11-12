import { MikroORM } from "@mikro-orm/postgresql";
import { type DynamicModule, Inject, Module, type OnModuleDestroy } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { CreateWalletUseCase } from "./application/create-wallet.use-case";
import { ProcessWagerTransactionUseCase } from "./application/process-wager-transaction.use-case";
import { QueryWalletUseCase } from "./application/query-wallet.use-case";
import { ReconcileWalletUseCase } from "./application/reconcile-wallet.use-case";
import { ResolvePendingReferencesUseCase } from "./application/resolve-pending-references.use-case";
import { APP_CONFIG, type AppConfig, loadConfig } from "./config/config";
import { buildOrmConfig } from "./database/orm.config";
import { TransactionRunner } from "./database/transaction-runner";
import { CorrelationInterceptor } from "./http/correlation.interceptor";
import { HealthController } from "./http/health.controller";
import { GlobalHttpExceptionFilter } from "./http/http-exception.filter";
import {
  NoopProviderIdentityAdapter,
  PROVIDER_IDENTITY_PORT,
  ProviderAuthGuard,
} from "./http/provider-auth.guard";
import { WageringController } from "./http/wagering.controller";
import { WalletsController } from "./http/wallets.controller";
import { SqsService } from "./messaging/sqs.service";
import { WagerSqsConsumer } from "./messaging/wager-sqs.consumer";
import { OutboxPublisherWorker } from "./workers/outbox-publisher.worker";
import { PendingReferenceWorker } from "./workers/pending-reference.worker";

@Module({})
export class AppModule implements OnModuleDestroy {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) { }

  static register(customConfig?: AppConfig): DynamicModule {
    const config = customConfig ?? loadConfig();
    return {
      module: AppModule,
      controllers: [WalletsController, WageringController, HealthController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        {
          provide: MikroORM,
          useFactory: async () => {
            const orm = await MikroORM.init(buildOrmConfig(config));
            await orm.getMigrator().up();
            return orm;
          },
        },
        TransactionRunner,
        SqsService,
        CreateWalletUseCase,
        ProcessWagerTransactionUseCase,
        ReconcileWalletUseCase,
        QueryWalletUseCase,
        ResolvePendingReferencesUseCase,
        WagerSqsConsumer,
        OutboxPublisherWorker,
        PendingReferenceWorker,
        { provide: PROVIDER_IDENTITY_PORT, useClass: NoopProviderIdentityAdapter },
        { provide: APP_GUARD, useClass: ProviderAuthGuard },
        { provide: APP_INTERCEPTOR, useClass: CorrelationInterceptor },
        { provide: APP_FILTER, useClass: GlobalHttpExceptionFilter },
      ],
      exports: [
        APP_CONFIG,
        MikroORM,
        TransactionRunner,
        SqsService,
        CreateWalletUseCase,
        ProcessWagerTransactionUseCase,
        ReconcileWalletUseCase,
        QueryWalletUseCase,
        ResolvePendingReferencesUseCase,
        WagerSqsConsumer,
        OutboxPublisherWorker,
        PendingReferenceWorker,
      ],
    };
  }

  async onModuleDestroy(): Promise<void> {
    await this.orm.close();
  }
}
