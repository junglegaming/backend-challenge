import type { StructuredLogger } from '../../application/ports';
import type { ResolvePendingReferences } from '../../application/resolve-pending-references';
import type { UnitOfWork } from '../../domain/ports/repositories';
import type { PrometheusMetrics } from '../observability/metrics';
import { PollingWorker } from './polling-worker';
import type { SqsGateway } from './sqs-gateway';

/** Scheduled worker for PENDING_REFERENCE transactions (section 7.1). */
export class PendingReferenceWorker extends PollingWorker {
  protected readonly workerName = 'pending-reference-worker';

  constructor(
    private readonly resolver: ResolvePendingReferences,
    logger: StructuredLogger,
    intervalMs: number,
    private readonly batchSize: number,
  ) {
    super(logger, intervalMs);
  }

  async tick(): Promise<boolean> {
    const result = await this.resolver.runBatch(this.batchSize);
    return result.claimed > 0;
  }
}

/** Samples gauges that are not driven by events: outbox backlog/lag and DLQ depth. */
export class MetricsSampler extends PollingWorker {
  protected readonly workerName = 'metrics-sampler';

  constructor(
    private readonly uow: UnitOfWork,
    private readonly sqs: SqsGateway,
    private readonly metrics: PrometheusMetrics,
    logger: StructuredLogger,
    intervalMs: number,
  ) {
    super(logger, intervalMs);
  }

  async tick(): Promise<boolean> {
    const stats = await this.uow.snapshot((s) => s.outbox.stats());
    this.metrics.outboxPending.set(stats.pending);
    this.metrics.outboxLag.set(stats.oldestPendingAgeSeconds);
    try {
      const { dlq } = await this.sqs.queueUrls();
      this.metrics.dlqDepth.set(await this.sqs.approximateDepth(dlq));
    } catch {
      // SQS unavailable: readiness reports it, the gauge keeps its last value
    }
    return false;
  }
}
