import type { Clock } from '../ports/clock-and-ids.port';
import type { UnitOfWork } from '../ports/wagering-repositories.port';
import type { ProcessWagerTransaction } from './process-wager-transaction';

export class RetryPendingReference {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly process: ProcessWagerTransaction,
  ) {}

  async runOne(): Promise<boolean> {
    return this.unitOfWork.run(async (repositories) => {
      const pending = await repositories.transactions.claimDueReference(this.clock.now());
      if (!pending) return false;
      await this.process.processExisting(repositories, pending.transaction, pending.retryCount);
      return true;
    });
  }
}
