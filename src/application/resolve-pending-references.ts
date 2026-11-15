import { Inject, Injectable } from '@nestjs/common';
import { FailureCode } from '../domain/failure-code';
import { UNIT_OF_WORK, type UnitOfWork } from '../domain/ports/repositories';
import { CLOCK, type Clock } from '../domain/ports/system';
import { type WagerTransaction, WagerTransactionStatus } from '../domain/wager-transaction';
import { ApplicationError } from './errors';
import { LogContext } from './log-context';
import { STRUCTURED_LOGGER, type StructuredLogger, WAGERING_METRICS, type WageringMetrics } from './ports';
import { WagerProcessor } from './wager-processor';
import { WALLET_ADMISSION, type WalletAdmission } from './wallet-admission';

export interface ResolveBatchResult {
  claimed: number;
  processed: number;
  rejected: number;
  stillPending: number;
  failed: number;
  /** already finished by someone else between claim and processing */
  skipped: number;
}

type ItemOutcome = Exclude<keyof ResolveBatchResult, 'claimed'>;

/** Lease that keeps other instances away from a claimed item while it is processed. */
const CLAIM_LEASE_MS = 30_000;

/**
 * Re-processes PENDING_REFERENCE transactions whose backoff is due. Items are
 * claimed with FOR UPDATE SKIP LOCKED, so several instances share the work
 * without stepping on each other; each item then runs in its own transaction
 * under the same wallet row lock used by the online path.
 */
@Injectable()
export class ResolvePendingReferences {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WAGERING_METRICS) private readonly metrics: WageringMetrics,
    @Inject(STRUCTURED_LOGGER) private readonly logger: StructuredLogger,
    @Inject(WALLET_ADMISSION) private readonly admission: WalletAdmission,
    private readonly processor: WagerProcessor,
  ) {}

  async runBatch(limit: number): Promise<ResolveBatchResult> {
    const claimed = await this.uow.run((s) => s.transactions.claimDuePendingReferences(CLAIM_LEASE_MS, limit), {
      name: 'claim-pending-references',
    });
    const result: ResolveBatchResult = { claimed: claimed.length, processed: 0, rejected: 0, stillPending: 0, failed: 0, skipped: 0 };

    // Different wallets in parallel; the wallet lock serialises same-wallet items.
    const outcomes = await Promise.all(claimed.map((item) => this.resolveOne(item.id, item.walletId)));
    for (const outcome of outcomes) result[outcome] += 1;
    return result;
  }

  private resolveOne(transactionId: string, walletId: string): Promise<ItemOutcome> {
    return LogContext.run({ transactionId, walletId }, async () => {
      const started = performance.now();
      try {
        const outcome = await this.admission.run(walletId, () => this.settle(transactionId, walletId));
        this.metrics.processingDuration('worker', (performance.now() - started) / 1000);
        if (!outcome) return 'skipped';
        if (outcome.status === WagerTransactionStatus.PendingReference) {
          this.metrics.retry('pending-reference', 'reference-missing');
          return 'stillPending';
        }
        this.metrics.transactionOutcome(outcome.status, outcome.kind, 'worker', outcome.failureCode);
        this.logger.info('pending reference resolved', { status: outcome.status, failureCode: outcome.failureCode });
        return outcome.status === WagerTransactionStatus.Processed ? 'processed' : 'rejected';
      } catch (error) {
        return this.handleFailure(transactionId, walletId, error);
      }
    });
  }

  /** One item, in its own transaction, under the same wallet row lock as the online path. */
  private settle(transactionId: string, walletId: string): Promise<WagerTransaction | undefined> {
    return this.uow.run(
      async (scope) => {
        const wallet = await scope.wallets.findByIdForUpdate(walletId);
        const tx = await scope.transactions.findById(transactionId);
        if (!wallet || !tx || tx.status !== WagerTransactionStatus.PendingReference) return undefined;
        await this.processor.process(scope, wallet, tx, { correlationId: transactionId, causationId: transactionId });
        return tx;
      },
      { name: 'resolve-pending-reference' },
    );
  }

  /**
   * Transient errors: leave the item pending, the lease expires and it is retried.
   * Anything else is a permanent failure: the transaction is marked FAILED (auditable).
   */
  private async handleFailure(transactionId: string, walletId: string, error: unknown): Promise<'stillPending' | 'failed'> {
    if (error instanceof ApplicationError && error.category === 'transient') {
      this.metrics.retry('pending-reference', error.code);
      this.logger.warn('transient error resolving pending reference', { error: error.message });
      return 'stillPending';
    }
    this.logger.error('permanent error resolving pending reference', { error: String(error) });
    try {
      const kind = await this.uow.run(async (scope) => {
        await scope.wallets.findByIdForUpdate(walletId);
        const tx = await scope.transactions.findById(transactionId);
        if (!tx || tx.isTerminal()) return undefined;
        tx.fail(FailureCode.ProcessingError, this.clock.now());
        await scope.transactions.save(tx);
        return tx.kind;
      });
      if (kind) this.metrics.transactionOutcome(WagerTransactionStatus.Failed, kind, 'worker', FailureCode.ProcessingError);
      return 'failed';
    } catch (markError) {
      this.logger.error('could not mark transaction as FAILED', { error: String(markError) });
      return 'stillPending';
    }
  }
}
