import type { AppLogger, AppMetrics } from "../../../shared/application/observability";
import { logContext } from "../../../shared/application/observability";
import type { UnitOfWork } from "../../../shared/application/unit-of-work";
import type { Clock, IdGenerator } from "../../../shared/domain/ports";
import { counterpartyAccountFor } from "../domain/counterparty";
import { WagerProcessor } from "../domain/wager-processor";
import { WagerTransactionStatus } from "../domain/wager-transaction-kind";
import { lookupReference } from "./process-wager-transaction";
import type { ReferenceRetryPolicy } from "./reference-retry-policy";
import { outboxMessagesFor } from "./wager-outcome-events";
import type { ClaimedPendingReference } from "./wagering-ports";

export interface ResolveBatchResult {
  claimed: number;
  processed: number;
  rejected: number;
  stillPending: number;
  skipped: number;
}

/**
 * Re-evaluates PENDING_REFERENCE transactions whose retry is due.
 *
 * Claiming uses FOR UPDATE SKIP LOCKED and pushes next_reference_retry_at forward by a lease, so N workers
 * on N instances share the work and a crashed worker's claim expires on its own. Each claimed transaction
 * is then handled in its own SQL transaction that locks the wallet first and the transaction row second —
 * the same lock order as the online path, so the worker and live traffic never deadlock.
 */
export class ResolvePendingReferences {
  private readonly processor = new WagerProcessor();

  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly retryPolicy: ReferenceRetryPolicy,
    private readonly metrics: AppMetrics,
    private readonly logger: AppLogger,
    private readonly options: { batchSize: number; leaseMs: number },
  ) {}

  async runOnce(): Promise<ResolveBatchResult> {
    const now = this.clock.now();
    const claimed = await this.uow.transaction(
      (scope) =>
        scope.wagers.claimDuePendingReferences(
          now,
          this.options.batchSize,
          new Date(now.getTime() + this.options.leaseMs),
        ),
      { label: "pending-ref-claim" },
    );
    const result: ResolveBatchResult = {
      claimed: claimed.length,
      processed: 0,
      rejected: 0,
      stillPending: 0,
      skipped: 0,
    };
    for (const item of claimed) {
      try {
        const outcome = await logContext.run(
          { transactionId: item.id, walletId: item.walletId, channel: "worker" },
          () => this.resolveOne(item),
        );
        result[outcome] += 1;
        this.metrics.pendingReferenceResolution(outcome);
      } catch (error) {
        // Lease expiry guarantees another attempt; one bad item must not stall the batch.
        this.logger.warn(
          { transactionId: item.id, err: error },
          "pending reference resolution failed; will retry",
        );
      }
    }
    return result;
  }

  private async resolveOne(
    item: ClaimedPendingReference,
  ): Promise<"processed" | "rejected" | "stillPending" | "skipped"> {
    return this.uow.transaction(
      async (scope) => {
        const now = this.clock.now();
        const wallet = await scope.wallets.lockById(item.walletId);
        const tx = await scope.wagers.lockById(item.id);
        if (!wallet || !tx || tx.status !== WagerTransactionStatus.PendingReference) return "skipped";

        const reference = await lookupReference(scope, tx);
        const versionBefore = wallet.version;
        const outcome = this.processor.process({
          wallet,
          transaction: tx,
          reference,
          ledgerEntryId: this.ids.next(),
          at: now,
          nextReferenceRetryAt: this.retryPolicy.nextRetryAt(tx.referenceAttempts + 1, now),
          referenceRetryExhausted: this.retryPolicy.isExhausted(tx.referenceAttempts),
        });

        await scope.wagers.update(tx);
        if (outcome.type === "PROCESSED" && outcome.ledgerEntry) {
          await scope.wallets.saveBalance(wallet, versionBefore);
          await scope.ledger.insertMany([
            { entry: outcome.ledgerEntry, counterpartyAccount: counterpartyAccountFor(tx) },
          ]);
        }
        // The original submission is the causation of everything that happens to it later.
        const meta = { correlationId: tx.idempotencyKey, causationId: tx.id, occurredAt: now };
        await scope.outbox.add(outboxMessagesFor(outcome, tx, wallet, meta, this.ids));

        // Terminal either way: its own dependents can be decided now.
        if (outcome.type !== "PENDING_REFERENCE") {
          await scope.wagers.nudgeDependents(wallet.id, tx.providerId, tx.externalTransactionId, now);
        }
        if (outcome.type === "PROCESSED") {
          this.logger.info({ kind: tx.kind }, "pending reference resolved");
          return "processed";
        }
        if (outcome.type === "REJECTED") {
          this.logger.warn(
            { kind: tx.kind, failureCode: outcome.failureCode },
            "pending transaction rejected",
          );
          return "rejected";
        }
        return "stillPending";
      },
      { label: "pending-ref-resolve" },
    );
  }
}
