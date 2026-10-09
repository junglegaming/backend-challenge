import type { ResolvePendingReferences } from "../../modules/wagering/application/resolve-pending-references";
import type { AppLogger } from "../../shared/application/observability";
import type { UnitOfWork } from "../../shared/application/unit-of-work";
import type { Clock } from "../../shared/domain/ports";
import { PollingWorker } from "./polling-worker";

/** Scheduled worker for PENDING_REFERENCE transactions (exponential backoff lives in the use case's policy). */
export class PendingReferenceWorker extends PollingWorker {
  constructor(
    private readonly useCase: ResolvePendingReferences,
    private readonly batchSize: number,
    pollIntervalMs: number,
    logger: AppLogger,
  ) {
    super("pending-reference-worker", logger, pollIntervalMs);
  }

  protected async tick(): Promise<boolean> {
    const result = await this.useCase.runOnce();
    if (result.claimed > 0) this.logger.debug({ ...result }, "pending references evaluated");
    return result.claimed >= this.batchSize;
  }
}

/**
 * Retention for the inbox and the submission-failure audit. The inbox is a de-duplication window for queue redeliveries (minutes/hours in practice);
 * business idempotency is permanent through wager_transactions' unique constraints, so purging old inbox rows
 * never re-enables a double effect.
 */
export class RetentionWorker extends PollingWorker {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly retention: { inboxDays: number; submissionFailureDays: number },
    logger: AppLogger,
  ) {
    super("retention", logger, 60 * 60 * 1000);
  }

  protected async tick(): Promise<boolean> {
    const now = this.clock.now().getTime();
    const inboxCutoff = new Date(now - this.retention.inboxDays * 86_400_000);
    const failureCutoff = new Date(now - this.retention.submissionFailureDays * 86_400_000);
    const [inbox, failures] = await this.uow.transaction(
      async (s) => [
        await s.inbox.purgeReceivedBefore(inboxCutoff, 5000),
        await s.failures.purgeOccurredBefore(failureCutoff, 5000),
      ],
      { label: "retention" },
    );
    if (inbox + failures > 0) this.logger.info({ inbox, failures }, "retention purge");
    return inbox >= 5000 || failures >= 5000;
  }
}
