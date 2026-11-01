import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { OutboxMessage } from "../../messaging/domain/outbox-message";
import { WageringTelemetry } from "../../observability/wagering-telemetry";
import { UnitOfWork } from "../../shared/application/unit-of-work";
import { Money, MoneyProps } from "../../shared/domain/money";
import { sqlErrorFields } from "../../shared/infrastructure/sql-error-classifier";
import { WagerTransactionProcessed, WalletBalanceChanged } from "../domain/events";
import { WagerTransaction, WagerTransactionKind } from "../domain/wager-transaction";
import { Wallet } from "../domain/wallet";
import { TransientProcessingError, WalletAlreadyExistsError } from "./errors";
import { OutboxWriter } from "./ports/messaging";
import {
  LedgerRepository,
  WagerTransactionRepository,
  WalletRepository,
} from "./ports/repositories";
import { wageringPayloadHash } from "./submit-wager-transaction";
import { walletView } from "./views";

@Injectable()
export class OpenWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly wallets: WalletRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly ledger: LedgerRepository,
    private readonly outbox: OutboxWriter,
    private readonly telemetry: WageringTelemetry,
  ) {}

  async handle(command: { playerId: string; initialBalance: MoneyProps; correlationId: string }) {
    const now = new Date();
    const id = randomUUID();
    const openingId = randomUUID();
    const { wallet, ledgerEntry } = Wallet.open({
      id,
      playerId: command.playerId,
      initialBalance: Money.from(command.initialBalance),
      openingTransactionId: openingId,
      openingEntryId: openingId,
      at: now,
    });
    try {
      const result = await this.uow.run(async (tx) => {
        await this.wallets.insert(tx, wallet);
        if (ledgerEntry) {
          const business = {
            providerId: "internal",
            externalTransactionId: `opening:${id}`,
            walletId: id,
            playerId: wallet.playerId,
            roundId: "internal",
            gameId: "internal",
            kind: WagerTransactionKind.Opening,
            money: wallet.balance.toJSON(),
          };
          const transaction = WagerTransaction.create(
            {
              ...business,
              id: openingId,
              idempotencyKey: business.externalTransactionId,
              payloadHash: wageringPayloadHash(business),
              money: wallet.balance,
              createdAt: now,
            },
            "internal",
          );
          transaction.markProcessed(undefined, now, wallet.balance);
          await this.transactions.insert(tx, transaction);
          await this.ledger.insert(tx, ledgerEntry);
          const context = () => ({
            eventId: randomUUID(),
            correlationId: command.correlationId,
            occurredAt: now,
          });
          await this.outbox.append(
            tx,
            OutboxMessage.enqueue(WagerTransactionProcessed.from(transaction, context())),
          );
          await this.outbox.append(
            tx,
            OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, ledgerEntry, context())),
          );
        }
        return walletView(wallet);
      });
      if (ledgerEntry)
        this.telemetry.transactions.inc({ status: "PROCESSED", kind: "OPENING", channel: "http" });
      this.telemetry.logger.info({
        event: "wallet_opened",
        correlationId: command.correlationId,
        walletId: id,
        transactionId: ledgerEntry ? openingId : undefined,
        providerId: "internal",
        channel: "http",
      });
      return result;
    } catch (error) {
      const { code, constraint } = sqlErrorFields(error);
      if (code === "23505" && constraint === "uq_wallets_player_currency")
        throw new WalletAlreadyExistsError("WALLET_ALREADY_EXISTS");
      throw new TransientProcessingError();
    }
  }
}
