import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { WageringTelemetry } from "../../observability/wagering-telemetry";
import { UnitOfWork } from "../../shared/application/unit-of-work";
import { classifySqlError } from "../../shared/infrastructure/sql-error-classifier";
import { WagerTransactionStatus } from "../domain/wager-transaction";
import { TransientProcessingError } from "./errors";
import { WagerTransactionRepository, WalletRepository } from "./ports/repositories";
import { SettlementWriter } from "./settlement-writer";
import { transactionView } from "./views";

@Injectable()
export class ResolvePendingTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly wallets: WalletRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly settlement: SettlementWriter,
    private readonly telemetry: WageringTelemetry,
  ) {}

  async handle(transactionId: string) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.resolve(transactionId, false);
      } catch (error) {
        this.telemetry.databaseError(error);
        const classification = classifySqlError(error);
        if (classification === "known_unique_race" && attempt === 0) continue;
        if (classification === "permanent") {
          try {
            return await this.resolve(transactionId, true);
          } catch (failureError) {
            this.telemetry.databaseError(failureError);
          }
        }
        throw new TransientProcessingError();
      }
    }
    throw new TransientProcessingError();
  }

  private async resolve(transactionId: string, failed: boolean) {
    return this.uow.run(async (tx) => {
      const initial = await this.transactions.find(tx, transactionId);
      if (!initial || initial.status !== WagerTransactionStatus.PendingReference) return;
      const wallet = await this.wallets.lock(tx, initial.walletId);
      const transaction = await this.transactions.find(tx, transactionId);
      if (!transaction || transaction.status !== WagerTransactionStatus.PendingReference) return;
      await this.settlement[failed ? "fail" : "apply"](
        tx,
        transaction,
        wallet,
        { correlationId: randomUUID(), causationId: transaction.id },
        true,
      );
      return transactionView(transaction);
    });
  }
}
