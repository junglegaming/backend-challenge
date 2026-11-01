import { randomUUID } from "node:crypto";
import {
  SqlInboxStore,
  SqlOutboxRepository,
} from "../../src/messaging/infrastructure/repositories";
import { JsonLogger } from "../../src/observability/json-logger";
import { LogContext } from "../../src/observability/log-context";
import { WageringTelemetry } from "../../src/observability/wagering-telemetry";
import { NoopSyncPoint } from "../../src/shared/application/sync-point";
import { OpenWallet } from "../../src/wagering/application/open-wallet";
import { ReconcileWallet, WageringQueries } from "../../src/wagering/application/queries";
import { ResolvePendingTransaction } from "../../src/wagering/application/resolve-pending-transaction";
import { SettlementWriter } from "../../src/wagering/application/settlement-writer";
import {
  SubmitCommand,
  SubmitWagerTransaction,
} from "../../src/wagering/application/submit-wager-transaction";
import { WagerTransactionKind } from "../../src/wagering/domain/wager-transaction";
import { SqlReconciliationRepository } from "../../src/wagering/infrastructure/reconciliation";
import {
  SqlLedgerRepository,
  SqlWagerTransactionRepository,
  SqlWalletRepository,
} from "../../src/wagering/infrastructure/repositories";
import { testDatabase } from "./database";

export function wageringHarness(fixture = testDatabase()) {
  const { database, uow, values } = fixture;
  const wallets = new SqlWalletRepository();
  const transactions = new SqlWagerTransactionRepository();
  const ledger = new SqlLedgerRepository();
  const outbox = new SqlOutboxRepository();
  const inbox = new SqlInboxStore();
  const context = new LogContext();
  const telemetry = new WageringTelemetry(new JsonLogger({ values }, context), context);
  const settlement = new SettlementWriter(wallets, transactions, ledger, outbox, { values });
  return {
    database,
    values,
    uow,
    wallets,
    transactions,
    ledger,
    outbox,
    inbox,
    telemetry,
    settlement,
    submit: new SubmitWagerTransaction(
      uow,
      wallets,
      transactions,
      inbox,
      settlement,
      telemetry,
      new NoopSyncPoint(),
    ),
    open: new OpenWallet(uow, wallets, transactions, ledger, outbox, telemetry),
    resolve: new ResolvePendingTransaction(uow, wallets, transactions, settlement, telemetry),
    queries: new WageringQueries(uow, wallets, transactions, ledger),
    reconcile: new ReconcileWallet(uow, new SqlReconciliationRepository(), telemetry),
  };
}

export function wagerCommand(
  wallet: { id: string; playerId: string },
  overrides: Partial<SubmitCommand> = {},
): SubmitCommand {
  return {
    providerId: "provider-a",
    externalTransactionId: randomUUID(),
    idempotencyKey: randomUUID(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "round",
    gameId: "game",
    kind: WagerTransactionKind.Bet,
    money: { amount: "10.00", currency: "BRL" },
    correlationId: randomUUID(),
    ...overrides,
  };
}
