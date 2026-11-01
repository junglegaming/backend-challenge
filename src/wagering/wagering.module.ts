import { Module } from "@nestjs/common";
import { MessagingPersistenceModule } from "../messaging/messaging-persistence.module";
import { SyncPointModule } from "../shared/infrastructure/sync-point.module";
import { OpenWallet } from "./application/open-wallet";
import {
  LedgerRepository,
  ReconciliationRepository,
  WagerTransactionRepository,
  WalletRepository,
} from "./application/ports/repositories";
import { ReconcileWallet, WageringQueries } from "./application/queries";
import { ResolvePendingTransaction } from "./application/resolve-pending-transaction";
import { SettlementWriter } from "./application/settlement-writer";
import { SubmitWagerTransaction } from "./application/submit-wager-transaction";
import { WageringController } from "./http/wagering.controller";
import { SqlReconciliationRepository } from "./infrastructure/reconciliation";
import {
  SqlLedgerRepository,
  SqlWagerTransactionRepository,
  SqlWalletRepository,
} from "./infrastructure/repositories";

@Module({
  imports: [MessagingPersistenceModule, SyncPointModule],
  controllers: [WageringController],
  providers: [
    { provide: WalletRepository, useClass: SqlWalletRepository },
    { provide: WagerTransactionRepository, useClass: SqlWagerTransactionRepository },
    { provide: LedgerRepository, useClass: SqlLedgerRepository },
    { provide: ReconciliationRepository, useClass: SqlReconciliationRepository },
    SettlementWriter,
    OpenWallet,
    SubmitWagerTransaction,
    ResolvePendingTransaction,
    WageringQueries,
    ReconcileWallet,
  ],
  exports: [
    OpenWallet,
    SubmitWagerTransaction,
    ResolvePendingTransaction,
    WageringQueries,
    ReconcileWallet,
  ],
})
export class WageringModule {}
