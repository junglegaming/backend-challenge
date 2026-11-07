import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { CLOCK, type Clock, ID_GENERATOR, type IdGenerator } from './application/ports/clock-and-ids.port';
import { UNIT_OF_WORK, type UnitOfWork } from './application/ports/wagering-repositories.port';
import { OpenWallet } from './application/wagering/open-wallet';
import { ProcessWagerTransaction } from './application/wagering/process-wager-transaction';
import { RetryPendingReference } from './application/wagering/retry-pending-reference';
import { MikroOrmUnitOfWork } from './infrastructure/persistence/mikro-orm-unit-of-work';
import { SystemClock, UuidV7Generator } from './infrastructure/system/system-clock-and-ids';
import { PendingReferenceWorker } from './infrastructure/system/pending-reference-worker';
import { ApiExceptionFilter } from './interfaces/http/api-exception.filter';
import { OPEN_WALLET, PROCESS_WAGER_TRANSACTION } from './interfaces/http/tokens';
import { WageringController } from './interfaces/http/wagering.controller';

/** Wiring of the wagering use cases. Expects a MikroORM connection (EntityManager) from the importing module. */
@Module({
  controllers: [WageringController],
  exports: [PROCESS_WAGER_TRANSACTION],
  providers: [
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidV7Generator },
    {
      provide: UNIT_OF_WORK,
      inject: [EntityManager],
      useFactory: (em: EntityManager): UnitOfWork => new MikroOrmUnitOfWork(em, Number(process.env.LOCK_TIMEOUT_MS ?? 5000)),
    },
    {
      provide: OPEN_WALLET,
      inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR],
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) => new OpenWallet(uow, clock, ids),
    },
    {
      provide: PROCESS_WAGER_TRANSACTION,
      inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR],
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) => new ProcessWagerTransaction(uow, clock, ids),
    },
    {
      provide: RetryPendingReference,
      inject: [UNIT_OF_WORK, CLOCK, PROCESS_WAGER_TRANSACTION],
      useFactory: (uow: UnitOfWork, clock: Clock, process: ProcessWagerTransaction) =>
        new RetryPendingReference(uow, clock, process),
    },
    {
      provide: PendingReferenceWorker,
      inject: [RetryPendingReference],
      useFactory: (retry: RetryPendingReference) => new PendingReferenceWorker(retry),
    },
  ],
})
export class WageringModule {}
