import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { DuplicateKind, Source, WageringMetrics } from '../../application/ports';
import type { FailureCode } from '../../domain/failure-code';
import type { WagerTransactionStatus } from '../../domain/wager-transaction';

/**
 * Prometheus metrics. One Registry per application instance (no global
 * default registry), so several apps can live in one test process.
 */
export class PrometheusMetrics implements WageringMetrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: 'wagering_transactions_total',
    help: 'Settled wager transactions by final status',
    labelNames: ['status', 'kind', 'source', 'failure_code'] as const,
    registers: [this.registry],
  });
  private readonly duplicates = new Counter({
    name: 'wagering_duplicates_detected_total',
    help: 'Duplicates detected (idempotent replays, inbox duplicates, outbox republishes)',
    labelNames: ['kind'] as const,
    registers: [this.registry],
  });
  private readonly retries = new Counter({
    name: 'wagering_retries_total',
    help: 'Retries by component and reason',
    labelNames: ['component', 'reason'] as const,
    registers: [this.registry],
  });
  private readonly lockConflicts = new Counter({
    name: 'wagering_lock_conflicts_total',
    help: 'Lock timeouts, deadlocks, optimistic-version and unique-key races',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });
  private readonly latency = new Histogram({
    name: 'wagering_processing_duration_seconds',
    help: 'End-to-end processing latency of a transaction submission',
    labelNames: ['source'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });
  private readonly reconciliation = new Counter({
    name: 'wagering_reconciliation_mismatches_total',
    help: 'Wallets whose stored balance diverged from the ledger',
    registers: [this.registry],
  });

  private readonly admission = new Counter({
    name: 'wagering_wallet_admission_total',
    help: 'Per-wallet admission decisions (immediate, queued behind the same wallet, rejected as busy)',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  readonly dlqMessages = new Counter({
    name: 'wagering_dlq_messages_total',
    help: 'Messages moved to the DLQ by this instance',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });
  readonly dlqDepth = new Gauge({
    name: 'wagering_dlq_depth',
    help: 'Approximate number of messages in the DLQ',
    registers: [this.registry],
  });
  readonly outboxPending = new Gauge({
    name: 'wagering_outbox_pending',
    help: 'Unpublished outbox messages',
    registers: [this.registry],
  });
  readonly outboxLag = new Gauge({
    name: 'wagering_outbox_lag_seconds',
    help: 'Age of the oldest unpublished outbox message',
    registers: [this.registry],
  });
  readonly outboxPublishDelay = new Histogram({
    name: 'wagering_outbox_publish_delay_seconds',
    help: 'Time between commit (occurredAt) and publication',
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    registers: [this.registry],
  });
  readonly outboxPublished = new Counter({
    name: 'wagering_outbox_published_total',
    help: 'Outbox messages published',
    labelNames: ['event_type'] as const,
    registers: [this.registry],
  });
  readonly sqsMessages = new Counter({
    name: 'wagering_sqs_messages_total',
    help: 'Consumed SQS messages by result',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });

  constructor(collectDefaults = true) {
    if (collectDefaults) collectDefaultMetrics({ register: this.registry });
  }

  transactionOutcome(status: WagerTransactionStatus, kind: string, source: Source, failureCode?: FailureCode): void {
    this.transactions.inc({ status, kind, source, failure_code: failureCode ?? '' });
  }
  duplicateDetected(kind: DuplicateKind): void {
    this.duplicates.inc({ kind });
  }
  retry(component: string, reason: string): void {
    this.retries.inc({ component, reason });
  }
  lockConflict(reason: string): void {
    this.lockConflicts.inc({ reason });
  }
  processingDuration(source: Source, seconds: number): void {
    this.latency.observe({ source }, seconds);
  }
  reconciliationMismatch(): void {
    this.reconciliation.inc();
  }
  walletAdmission(outcome: 'immediate' | 'queued' | 'rejected'): void {
    this.admission.inc({ outcome });
  }
}
