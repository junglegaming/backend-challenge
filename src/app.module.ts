import { type DynamicModule, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import type { Core } from "./composition/core";
import { HealthController, ReadinessService } from "./infrastructure/health/health";
import { PromMetrics } from "./infrastructure/observability/metrics";
import {
  NoopProviderIdentity,
  PROVIDER_IDENTITY,
  ProviderAuthGuard,
  type ProviderIdentityPort,
} from "./modules/auth/provider-auth";
import { ProcessWagerTransaction } from "./modules/wagering/application/process-wager-transaction";
import {
  ListSubmissionFailures,
  RecordSubmissionFailure,
} from "./modules/wagering/application/submission-failures";
import { GetWagerTransaction } from "./modules/wagering/application/wager-queries";
import { WageringController } from "./modules/wagering/infrastructure/http/wagering.controller";
import {
  CreateWallet,
  GetWallet,
  ListWalletLedger,
  ReconcileWallet,
} from "./modules/wallet/application/wallet-use-cases";
import { WalletsController } from "./modules/wallet/infrastructure/http/wallets.controller";

export interface AppModuleDeps {
  core: Core;
  metrics: PromMetrics;
  readiness: ReadinessService;
  identity?: ProviderIdentityPort;
}

/**
 * Nest is the HTTP/DI shell. The core (ORM, unit of work, use cases) is built framework-free in
 * composition/core.ts and registered here as values, so the same instances serve HTTP, SQS and tests.
 */
@Module({})
export class AppModule {
  static register(deps: AppModuleDeps): DynamicModule {
    const { core } = deps;
    return {
      module: AppModule,
      controllers: [WalletsController, WageringController, HealthController],
      providers: [
        { provide: ProcessWagerTransaction, useValue: core.processWager },
        { provide: GetWagerTransaction, useValue: core.getWager },
        { provide: RecordSubmissionFailure, useValue: core.recordSubmissionFailure },
        { provide: ListSubmissionFailures, useValue: core.listSubmissionFailures },
        { provide: CreateWallet, useValue: core.createWallet },
        { provide: GetWallet, useValue: core.getWallet },
        { provide: ListWalletLedger, useValue: core.listLedger },
        { provide: ReconcileWallet, useValue: core.reconcileWallet },
        { provide: ReadinessService, useValue: deps.readiness },
        { provide: PromMetrics, useValue: deps.metrics },
        { provide: PROVIDER_IDENTITY, useValue: deps.identity ?? new NoopProviderIdentity() },
        { provide: APP_GUARD, useClass: ProviderAuthGuard },
      ],
    };
  }
}
