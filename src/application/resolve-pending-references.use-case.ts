import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/config";
import { TransactionRunner } from "../database/transaction-runner";
import { WagerTransactionRejected } from "../domain/events/events";
import { OutboxMessage } from "../domain/messaging/outbox-message";
import { FailureCode } from "../domain/shared/failure-code";
import { WagerTransactionStatus } from "../domain/wagering/wager-transaction";
import { enrichContext, runWithContext } from "../observability/context";
import { logger } from "../observability/logger";
import { metrics } from "../observability/metrics";
import { ProcessWagerTransactionUseCase } from "./process-wager-transaction.use-case";

/**
 * Reprocesses `PENDING_REFERENCE` transactions whose `nextReferenceAttemptAt` is due.
 *
 * Concurrency rules:
 *  - Always locks the `Wallet` first (`SELECT ... FOR UPDATE`), then locks the
 *    `WagerTransaction` row with `FOR UPDATE SKIP LOCKED`. Keeping the same
 *    lock acquisition order (`wallets` -> `wager_transactions`) across the
 *    entire service eliminates deadlocks.
 *  - When the reference still hasn't arrived and `referenceAttempts + 1 >= maxAttempts`,
 *    transitions the transaction to `REJECTED` with `FailureCode.ReferenceNotFound`
 *    and emits `WagerTransactionRejected` to the outbox.
 */
@Injectable()
export class ResolvePendingReferencesUseCase {
  constructor(
    @Inject(TransactionRunner) private readonly txRunner: TransactionRunner,
    @Inject(ProcessWagerTransactionUseCase)
    private readonly wagerUseCase: ProcessWagerTransactionUseCase,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async executeBatch(limit = 20): Promise<number> {
    const now = new Date();
    const dueList = await this.txRunner.read((ctx) =>
      ctx.transactions.findDuePendingReferences(now, limit),
    );

    let processedCount = 0;
    for (const item of dueList) {
      const resolved = await this.resolveOne(item.id, item.walletId);
      if (resolved) {
        processedCount += 1;
      }
    }
    return processedCount;
  }

  async resolveOne(transactionId: string, walletId: string): Promise<boolean> {
    return runWithContext({ transactionId, walletId, channel: "worker" }, async () => {
      return this.txRunner.run(async (ctx) => {
        const now = new Date();

        // 1. Lock the wallet first (global lock ordering: wallet -> transaction).
        const wallet = await ctx.wallets.lockById(walletId);
        if (!wallet) {
          return false;
        }

        // 2. Claim the pending transaction with SKIP LOCKED.
        const tx = await ctx.transactions.lockPendingReference(transactionId, now);
        if (!tx) {
          return false;
        }

        enrichContext({
          correlationId: tx.correlationId,
          providerId: tx.providerId,
          transactionId: tx.id,
          walletId: tx.walletId,
        });

        const reference = tx.referenceExternalTransactionId
          ? await ctx.transactions.findByExternalId(tx.providerId, tx.referenceExternalTransactionId)
          : null;

        // Still missing (or still non-terminal) and retry budget exhausted -> REJECTED.
        if (
          (!reference || !reference.isTerminal()) &&
          tx.referenceAttempts + 1 >= this.config.pendingReference.maxAttempts
        ) {
          tx.reject(FailureCode.ReferenceNotFound, wallet.balance, now);
          await ctx.transactions.updateState(tx);
          await ctx.outbox.insert([
            OutboxMessage.enqueue(
              WagerTransactionRejected.from(tx, FailureCode.ReferenceNotFound, {
                correlationId: tx.correlationId,
                causationId: tx.id,
                occurredAt: now,
              }),
            ),
          ]);

          metrics.pendingReferenceResolved.inc({ outcome: "expired" });
          metrics.transactions.inc({
            kind: tx.kind,
            status: WagerTransactionStatus.Rejected,
            channel: "worker",
          });
          logger.warn(
            { transactionId: tx.id, attempts: tx.referenceAttempts + 1 },
            "Pending reference expired and rejected",
          );
          return true;
        }

        await this.wagerUseCase.evaluateAndPersist(ctx, tx, wallet, now, tx.correlationId, true);

        if (tx.status === WagerTransactionStatus.Processed) {
          metrics.pendingReferenceResolved.inc({ outcome: "processed" });
          metrics.transactions.inc({ kind: tx.kind, status: tx.status, channel: "worker" });
          logger.info({ transactionId: tx.id, kind: tx.kind }, "Pending reference resolved and processed");
        } else if (tx.status === WagerTransactionStatus.Rejected) {
          metrics.pendingReferenceResolved.inc({ outcome: "rejected" });
          metrics.transactions.inc({ kind: tx.kind, status: tx.status, channel: "worker" });
          logger.info(
            { transactionId: tx.id, failureCode: tx.failureCode },
            "Pending reference resolved as rejected",
          );
        } else {
          metrics.pendingReferenceResolved.inc({ outcome: "rescheduled" });
          metrics.retries.inc({ component: "pending_reference", reason: "missing_reference" });
        }

        return true;
      });
    });
  }
}

