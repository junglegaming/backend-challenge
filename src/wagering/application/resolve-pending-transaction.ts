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

  handle(transactionId: string) {
    return this.run(transactionId);
  }
  handleNextDue() {
    return this.run();
  }

  private async run(transactionId?: string) {
    let selectedId = transactionId;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.resolve(selectedId, false, (id) => {
          selectedId = id;
        });
      } catch (error) {
        this.telemetry.databaseError(error);
        const classification = classifySqlError(error);
        if (classification === "known_unique_race" && attempt === 0) continue;
        if (classification === "permanent" && selectedId) {
          try {
            return await this.resolve(selectedId, true, () => {});
          } catch (failureError) {
            this.telemetry.databaseError(failureError);
          }
        }
        throw new TransientProcessingError();
      }
    }
    throw new TransientProcessingError();
  }

  private async resolve(
    transactionId: string | undefined,
    failed: boolean,
    selected: (id: string) => void,
  ) {
    return this.uow.run(async (tx) => {
      const initial = transactionId ? await this.transactions.find(tx, transactionId) : null;
      if (transactionId && (!initial || initial.status !== WagerTransactionStatus.PendingReference))
        return;
      const now = new Date();
      const wallet = initial
        ? await this.wallets.lock(tx, initial.walletId)
        : await this.wallets.lockNextWithDueReference(tx, now);
      if (!initial && !wallet) return;
      const transaction = transactionId
        ? await this.transactions.find(tx, transactionId)
        : await this.transactions.findNextDueReference(tx, wallet?.id ?? "", now);
      if (!transaction || transaction.status !== WagerTransactionStatus.PendingReference) return;
      selected(transaction.id);
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
