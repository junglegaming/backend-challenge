import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { Configuration } from "../../config/config";
import { OutboxMessage } from "../../messaging/domain/outbox-message";
import { TransactionContext } from "../../shared/application/unit-of-work";
import { EventContext } from "../../shared/domain/integration-event";
import {
  WagerTransactionFailed,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../domain/events";
import { FailureCode } from "../domain/failure-code";
import { settle } from "../domain/settlement";
import { WagerTransaction } from "../domain/wager-transaction";
import { Wallet } from "../domain/wallet";
import { TransientProcessingError } from "./errors";
import { OutboxWriter } from "./ports/messaging";
import {
  LedgerRepository,
  WagerTransactionRepository,
  WalletRepository,
} from "./ports/repositories";

@Injectable()
export class SettlementWriter {
  constructor(
    private readonly wallets: WalletRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly ledger: LedgerRepository,
    private readonly outbox: OutboxWriter,
    private readonly configuration: Configuration,
  ) {}

  async fail(
    tx: TransactionContext,
    transaction: WagerTransaction,
    wallet: Wallet | null,
    context: Omit<EventContext, "eventId" | "occurredAt">,
    existing = false,
  ): Promise<void> {
    const now = new Date();
    transaction.fail(FailureCode.PermanentProcessingError, now, wallet?.balance ?? null);
    if (existing) await this.transactions.save(tx, transaction);
    else await this.transactions.insert(tx, transaction);
    await this.outbox.append(
      tx,
      OutboxMessage.enqueue(
        WagerTransactionFailed.from(transaction, {
          ...context,
          eventId: randomUUID(),
          occurredAt: now,
        }),
      ),
    );
  }

  async apply(
    tx: TransactionContext,
    transaction: WagerTransaction,
    wallet: Wallet | null,
    context: Omit<EventContext, "eventId" | "occurredAt">,
    existing = false,
  ): Promise<void> {
    const now = new Date();
    let reference: WagerTransaction | null = null;
    let referenceHasProcessedReversal = false;
    try {
      reference =
        transaction.referenceExternalTransactionId === undefined
          ? null
          : await this.transactions.findByExternalId(
              tx,
              transaction.providerId,
              transaction.referenceExternalTransactionId,
            );
      referenceHasProcessedReversal = reference
        ? await this.transactions.hasProcessedReversal(tx, reference.id)
        : false;
    } catch (error) {
      // A failed read establishes neither reference absence nor a permanent
      // financial write failure. Keep the whole attempt retryable.
      throw new TransientProcessingError(error);
    }
    const outcome = settle({
      transaction,
      wallet,
      reference,
      referenceHasProcessedReversal,
      deadlineReached:
        transaction.referenceDeadlineAt !== undefined && now >= transaction.referenceDeadlineAt,
      now,
      referenceRetryJitter: existing ? Math.random() * 0.2 : 0,
      referenceTtlMs: this.configuration.values.pending.ttlMs,
    });
    if (existing) await this.transactions.save(tx, transaction);
    else await this.transactions.insert(tx, transaction);
    if (outcome.type === "processed" && outcome.ledgerEntry && wallet) {
      await this.ledger.insert(tx, outcome.ledgerEntry);
      await this.wallets.save(tx, wallet);
    }
    const eventContext = () => ({ ...context, eventId: randomUUID(), occurredAt: now });
    const event =
      outcome.type === "processed"
        ? WagerTransactionProcessed.from(transaction, eventContext())
        : outcome.type === "rejected"
          ? WagerTransactionRejected.from(transaction, eventContext())
          : existing
            ? undefined
            : WagerTransactionPendingReference.from(transaction, eventContext());
    if (event) await this.outbox.append(tx, OutboxMessage.enqueue(event));
    if (outcome.type === "processed" && outcome.ledgerEntry && wallet) {
      await this.outbox.append(
        tx,
        OutboxMessage.enqueue(
          WalletBalanceChanged.from(wallet, outcome.ledgerEntry, eventContext()),
        ),
      );
    }
  }
}
