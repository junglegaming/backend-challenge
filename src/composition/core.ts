import { MikroORM } from "@mikro-orm/postgresql";
import type { AppConfig } from "../config/config";
import { MikroUnitOfWork } from "../infrastructure/database/mikro-unit-of-work";
import { buildOrmConfig } from "../infrastructure/database/orm-config";
import { ProcessWagerTransaction } from "../modules/wagering/application/process-wager-transaction";
import { ReferenceRetryPolicy } from "../modules/wagering/application/reference-retry-policy";
import { ResolvePendingReferences } from "../modules/wagering/application/resolve-pending-references";
import {
  ListSubmissionFailures,
  RecordSubmissionFailure,
} from "../modules/wagering/application/submission-failures";
import { GetWagerTransaction } from "../modules/wagering/application/wager-queries";
import {
  CreateWallet,
  GetWallet,
  ListWalletLedger,
  ReconcileWallet,
} from "../modules/wallet/application/wallet-use-cases";
import type { AppLogger, AppMetrics } from "../shared/application/observability";
import { type Clock, type IdGenerator, systemClock, uuidV7Generator } from "../shared/domain/ports";

/**
 * Framework-free composition root for the core (ORM, unit of work, use cases).
 * Nest wires these instances as providers; tests use them directly.
 */
export interface Core {
  orm: MikroORM;
  uow: MikroUnitOfWork;
  clock: Clock;
  ids: IdGenerator;
  retryPolicy: ReferenceRetryPolicy;
  processWager: ProcessWagerTransaction;
  resolvePendingReferences: ResolvePendingReferences;
  createWallet: CreateWallet;
  getWallet: GetWallet;
  listLedger: ListWalletLedger;
  reconcileWallet: ReconcileWallet;
  getWager: GetWagerTransaction;
  recordSubmissionFailure: RecordSubmissionFailure;
  listSubmissionFailures: ListSubmissionFailures;
  close(): Promise<void>;
}

export type CoreConfig = Pick<
  AppConfig,
  | "DATABASE_URL"
  | "DB_POOL_MIN"
  | "DB_POOL_MAX"
  | "DB_LOCK_TIMEOUT_MS"
  | "DB_STATEMENT_TIMEOUT_MS"
  | "DB_TX_MAX_ATTEMPTS"
  | "PENDING_REF_BASE_MS"
  | "PENDING_REF_MAX_MS"
  | "PENDING_REF_MAX_ATTEMPTS"
  | "PENDING_REF_BATCH_SIZE"
  | "PENDING_REF_LEASE_MS"
  | "SUPPORTED_CURRENCIES"
>;

export async function buildCore(
  config: CoreConfig,
  deps: { logger: AppLogger; metrics: AppMetrics; clock?: Clock; ids?: IdGenerator },
): Promise<Core> {
  const clock = deps.clock ?? systemClock;
  const ids = deps.ids ?? uuidV7Generator;
  const orm = await MikroORM.init(
    buildOrmConfig({
      url: config.DATABASE_URL,
      poolMin: config.DB_POOL_MIN,
      poolMax: config.DB_POOL_MAX,
      statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
    }),
  );
  const uow = new MikroUnitOfWork(
    orm,
    {
      lockTimeoutMs: config.DB_LOCK_TIMEOUT_MS,
      statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
      maxAttempts: config.DB_TX_MAX_ATTEMPTS,
    },
    deps.metrics,
    deps.logger,
  );
  const retryPolicy = new ReferenceRetryPolicy(
    { baseMs: config.PENDING_REF_BASE_MS, maxMs: config.PENDING_REF_MAX_MS, jitter: 0.2 },
    config.PENDING_REF_MAX_ATTEMPTS,
  );

  return {
    orm,
    uow,
    clock,
    ids,
    retryPolicy,
    processWager: new ProcessWagerTransaction(uow, clock, ids, retryPolicy, deps.metrics, deps.logger),
    resolvePendingReferences: new ResolvePendingReferences(
      uow,
      clock,
      ids,
      retryPolicy,
      deps.metrics,
      deps.logger,
      {
        batchSize: config.PENDING_REF_BATCH_SIZE,
        leaseMs: config.PENDING_REF_LEASE_MS,
      },
    ),
    createWallet: new CreateWallet(uow, clock, ids, deps.logger, config.SUPPORTED_CURRENCIES),
    getWallet: new GetWallet(uow),
    listLedger: new ListWalletLedger(uow),
    reconcileWallet: new ReconcileWallet(uow, clock, deps.metrics, deps.logger),
    getWager: new GetWagerTransaction(uow),
    recordSubmissionFailure: new RecordSubmissionFailure(uow, clock, ids, deps.metrics, deps.logger),
    listSubmissionFailures: new ListSubmissionFailures(uow),
    close: () => orm.close(true),
  };
}
