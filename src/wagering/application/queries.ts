import { Injectable } from "@nestjs/common";
import { WageringTelemetry } from "../../observability/wagering-telemetry";
import { UnitOfWork } from "../../shared/application/unit-of-work";
import {
  LedgerRepository,
  ReconciliationRepository,
  WagerTransactionRepository,
  WalletRepository,
} from "./ports/repositories";
import { ledgerView, transactionView, walletView } from "./views";

@Injectable()
export class WageringQueries {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly wallets: WalletRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly ledger: LedgerRepository,
  ) {}

  wallet(id: string) {
    return this.uow.run(async (tx) => {
      const wallet = await this.wallets.find(tx, id);
      return wallet ? walletView(wallet) : null;
    });
  }
  transaction(id: string) {
    return this.uow.run(async (tx) => {
      const transaction = await this.transactions.find(tx, id);
      return transaction ? transactionView(transaction) : null;
    });
  }
  providerTransaction(providerId: string, externalId: string) {
    return this.uow.run(async (tx) => {
      const transaction = await this.transactions.findByExternalId(tx, providerId, externalId);
      return transaction ? transactionView(transaction) : null;
    });
  }
  ledgerPage(walletId: string, afterVersion: number, limit: number) {
    return this.uow.run(async (tx) => {
      if (!(await this.wallets.find(tx, walletId))) return null;
      return (await this.ledger.list(tx, walletId, afterVersion, limit)).map(ledgerView);
    });
  }
}

@Injectable()
export class ReconcileWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly reconciliation: ReconciliationRepository,
    private readonly telemetry: WageringTelemetry,
  ) {}

  async handle(walletId: string) {
    const snapshot = await this.uow.run((tx) => this.reconciliation.snapshot(tx, walletId));
    if (!snapshot) return null;
    const difference = snapshot.storedBalance.subtract(snapshot.calculatedBalance);
    const consistent = difference.isZero();
    if (!consistent) this.telemetry.reconciliationDiverged(walletId);
    return {
      walletId,
      storedBalance: snapshot.storedBalance.toJSON(),
      calculatedBalance: snapshot.calculatedBalance.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: snapshot.checkedEntries,
    };
  }
}
