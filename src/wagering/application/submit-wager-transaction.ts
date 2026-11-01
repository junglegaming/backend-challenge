import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { InboxMessage } from "../../messaging/domain/inbox-message";
import { WageringTelemetry } from "../../observability/wagering-telemetry";
import { canonicalHash } from "../../shared/application/canonical-json";
import { TransactionContext, UnitOfWork } from "../../shared/application/unit-of-work";
import { Money, MoneyProps } from "../../shared/domain/money";
import { classifySqlError } from "../../shared/infrastructure/sql-error-classifier";
import {
  CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind,
} from "../domain/wager-transaction";
import { InboxPayloadConflictError, TransientProcessingError } from "./errors";
import { InboxStore } from "./ports/messaging";
import { WagerTransactionRepository, WalletRepository } from "./ports/repositories";
import { SettlementWriter } from "./settlement-writer";
import { TransactionView, transactionView } from "./views";

export interface WagerBusinessFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}
export interface SubmitCommand extends WagerBusinessFields {
  idempotencyKey: string;
  correlationId: string;
  causationId?: string;
}
export interface SubmissionOptions {
  inbox?: { messageId: string; payloadHash: string };
}
export type SubmissionResult =
  | { type: "completed"; transaction: TransactionView; idempotentReplay: boolean }
  | { type: "duplicate_message" }
  | { type: "idempotency_conflict" }
  | { type: "external_transaction_conflict" };

export function wageringPayloadHash(command: WagerBusinessFields): string {
  return canonicalHash({
    providerId: command.providerId,
    externalTransactionId: command.externalTransactionId,
    playerId: command.playerId,
    walletId: command.walletId,
    roundId: command.roundId,
    gameId: command.gameId,
    kind: command.kind,
    money: { amount: command.money.amount, currency: command.money.currency },
    referenceExternalTransactionId: command.referenceExternalTransactionId,
  });
}

@Injectable()
export class SubmitWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly wallets: WalletRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly inbox: InboxStore,
    private readonly settlement: SettlementWriter,
    private readonly telemetry: WageringTelemetry,
  ) {}

  async handle(command: SubmitCommand, options: SubmissionOptions = {}): Promise<SubmissionResult> {
    const props: CreateWagerTransactionProps = {
      ...command,
      id: randomUUID(),
      createdAt: new Date(),
      payloadHash: wageringPayloadHash(command),
      money: Money.from(command.money),
    };
    WagerTransaction.create(props); // Validate before SQL; invalid input is never an infrastructure failure.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.uow.run((tx) => this.execute(tx, command, props, options, false));
      } catch (error) {
        if (error instanceof InboxPayloadConflictError) throw error;
        this.telemetry.databaseError(error);
        const classification = classifySqlError(error);
        if (classification === "known_unique_race" && attempt === 0) continue;
        if (classification === "permanent") {
          try {
            return await this.uow.run((tx) => this.execute(tx, command, props, options, true));
          } catch (failureError) {
            if (failureError instanceof InboxPayloadConflictError) throw failureError;
            this.telemetry.databaseError(failureError);
            throw new TransientProcessingError();
          }
        }
        throw new TransientProcessingError();
      }
    }
    throw new TransientProcessingError();
  }

  private async execute(
    tx: TransactionContext,
    command: SubmitCommand,
    props: CreateWagerTransactionProps,
    options: SubmissionOptions,
    failed: boolean,
  ): Promise<SubmissionResult> {
    let message: InboxMessage | undefined;
    if (options.inbox) {
      message = InboxMessage.receive({
        consumerName: "wager-transactions",
        ...options.inbox,
        receivedAt: new Date(),
      });
      const claim = await this.inbox.claim(tx, message);
      if (!claim.inserted) {
        if (claim.existing.payloadHash !== message.payloadHash)
          throw new InboxPayloadConflictError("Inbox payload differs");
        return { type: "duplicate_message" };
      }
    }
    const finish = async (result: SubmissionResult): Promise<SubmissionResult> => {
      if (message) {
        message.markProcessed(new Date());
        await this.inbox.markProcessed(tx, message);
      }
      return result;
    };
    const wallet = await this.wallets.lock(tx, command.walletId);
    const existing = await this.transactions.findByKey(
      tx,
      command.providerId,
      command.idempotencyKey,
    );
    if (existing) {
      return finish(
        existing.matchesPayload(props.payloadHash)
          ? { type: "completed", transaction: transactionView(existing), idempotentReplay: true }
          : { type: "idempotency_conflict" },
      );
    }
    if (
      await this.transactions.findByExternalId(
        tx,
        command.providerId,
        command.externalTransactionId,
      )
    ) {
      return finish({ type: "external_transaction_conflict" });
    }
    const transaction = WagerTransaction.create(props);
    if (failed) {
      await this.settlement.fail(tx, transaction, wallet, {
        correlationId: command.correlationId,
        causationId: command.causationId,
      });
    } else {
      await this.settlement.apply(tx, transaction, wallet, {
        correlationId: command.correlationId,
        causationId: command.causationId,
      });
    }
    return finish({
      type: "completed",
      transaction: transactionView(transaction),
      idempotentReplay: false,
    });
  }
}
