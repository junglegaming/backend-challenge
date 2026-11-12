import { Inject, Injectable } from "@nestjs/common";
import { isUniqueViolation } from "../database/database-errors";
import { TransactionRunner } from "../database/transaction-runner";
import { WagerTransactionProcessed, WalletBalanceChanged } from "../domain/events/events";
import { OutboxMessage } from "../domain/messaging/outbox-message";
import { Money, type MoneyProps } from "../domain/money/money";
import { ConflictError } from "../domain/shared/errors";
import { newId } from "../domain/shared/id";
import { computePayloadHash } from "../domain/wagering/payload-hash";
import { WagerTransaction, WagerTransactionKind } from "../domain/wagering/wager-transaction";
import { Wallet } from "../domain/wallet/wallet";
import { currentContext, enrichContext } from "../observability/context";
import { logger } from "../observability/logger";

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface CreateWalletResult {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

/**
 * Opens a player wallet.
 *
 * When `initialBalance > 0`, an internal `OPENING` transaction, its `CREDIT`
 * ledger entry and the corresponding outbox events are written in the same SQL
 * transaction, so the invariant `wallet.balance == sum(ledger)` holds from the
 * very first millisecond of the wallet's life.
 */
@Injectable()
export class CreateWalletUseCase {
  constructor(@Inject(TransactionRunner) private readonly txRunner: TransactionRunner) {}

  async execute(command: CreateWalletCommand): Promise<CreateWalletResult> {
    const playerId = command.playerId.toLowerCase();
    const initialMoney = Money.from(command.initialBalance);
    const now = new Date();
    const walletId = newId();
    const correlationId = currentContext().correlationId ?? newId();

    enrichContext({ walletId });

    try {
      const wallet = await this.txRunner.run(async (ctx) => {
        const opened = Wallet.open({
          id: walletId,
          playerId,
          currency: initialMoney.currency,
          at: now,
        });
        await ctx.wallets.insert(opened);

        if (initialMoney.isPositive()) {
          const externalTransactionId = `opening:${opened.id}`;
          const idempotencyKey = `internal:${externalTransactionId}`;
          const payloadHash = computePayloadHash({
            providerId: "internal",
            externalTransactionId,
            playerId,
            walletId: opened.id,
            roundId: "opening",
            gameId: "opening",
            kind: WagerTransactionKind.Opening,
            money: initialMoney.toJSON(),
          });

          const openingTx = WagerTransaction.create({
            providerId: "internal",
            externalTransactionId,
            idempotencyKey,
            payloadHash,
            walletId: opened.id,
            playerId,
            roundId: "opening",
            gameId: "opening",
            kind: WagerTransactionKind.Opening,
            money: initialMoney,
            correlationId,
            createdAt: now,
          });

          const entry = opened.openingCredit(initialMoney, openingTx.id, now);
          openingTx.markProcessed(undefined, opened.balance, now);

          await ctx.transactions.insert(openingTx);
          await ctx.wallets.update(opened, 1);
          await ctx.ledger.insert(entry);

          const eventCtx = { correlationId, causationId: openingTx.id, occurredAt: now };
          await ctx.outbox.insert([
            OutboxMessage.enqueue(WagerTransactionProcessed.from(openingTx, opened, eventCtx)),
            OutboxMessage.enqueue(WalletBalanceChanged.from(opened, entry, eventCtx)),
          ]);
        }

        return opened;
      });

      logger.info({ walletId: wallet.id, playerId, currency: wallet.currency }, "Wallet created");
      return wallet.toJSON();
    } catch (error) {
      if (isUniqueViolation(error, "wallets_player_currency_uq")) {
        throw new ConflictError(
          "WALLET_ALREADY_EXISTS",
          `Wallet already exists for player ${playerId} and currency ${initialMoney.currency}`,
        );
      }
      throw error;
    }
  }
}

