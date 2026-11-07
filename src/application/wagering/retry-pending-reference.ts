import type { Clock } from '../ports/clock-and-ids.port';
import type { UnitOfWork } from '../ports/wagering-repositories.port';
import type { ProcessWagerTransaction } from './process-wager-transaction';
import { NOOP_TELEMETRY, type Telemetry } from '../observability/telemetry';
import { runWithContext } from '../observability/context';

export class RetryPendingReference {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly process: ProcessWagerTransaction,
    private readonly telemetry: Telemetry = NOOP_TELEMETRY,
  ) {}

  async runOne(): Promise<boolean> {
    const outcome = await this.unitOfWork.run(async (repositories) => {
      const pending = await repositories.transactions.claimDueReference(this.clock.now());
      if (!pending) return undefined;
      const context = { correlationId: pending.correlationId ?? pending.transaction.id,
        ...(pending.causationId ? { messageId: pending.causationId } : {}),
        transactionId: pending.transaction.id, walletId: pending.transaction.walletId, providerId: pending.transaction.providerId };
      const result = await runWithContext(context, () => this.process.processExisting(repositories, pending.transaction, pending.retryCount,
        { correlationId: pending.correlationId, causationId: pending.causationId }));
      return { context, result };
    });
    if (!outcome) return false;
    this.telemetry.retry('reference');
    runWithContext(outcome.context, () => this.process.record(outcome.result));
    return true;
  }
}
