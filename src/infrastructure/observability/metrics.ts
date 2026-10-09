import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from "prom-client";
import type { AppMetrics, Channel } from "../../shared/application/observability";

export interface GaugeSources {
  outboxStats?: () => Promise<{ pending: number; oldestPendingOccurredAt: Date | undefined }>;
  pendingReferences?: () => Promise<number>;
  dlqDepth?: () => Promise<number>;
}

/** prom-client implementation of the AppMetrics port, exposed at GET /metrics. */
export class PromMetrics implements AppMetrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: "wager_transactions_total",
    help: "Wager transactions by kind, final status and entry channel (replays excluded)",
    labelNames: ["kind", "status", "channel"],
    registers: [this.registry],
  });
  private readonly duration = new Histogram({
    name: "wager_processing_duration_seconds",
    help: "End-to-end processing latency of a wager submission (including DB retries)",
    labelNames: ["channel", "outcome"],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });
  private readonly replays = new Counter({
    name: "wager_idempotent_replays_total",
    help: "Duplicate submissions answered from the stored original result",
    labelNames: ["channel"],
    registers: [this.registry],
  });
  private readonly conflicts = new Counter({
    name: "wager_idempotency_conflicts_total",
    help: "Same idempotency key / externalId / messageId with a different payload",
    labelNames: ["channel", "reason"],
    registers: [this.registry],
  });
  private readonly inboxDuplicates = new Counter({
    name: "inbox_duplicates_total",
    help: "Queue redeliveries detected by the persistent inbox",
    registers: [this.registry],
  });
  private readonly retries = new Counter({
    name: "db_transient_retries_total",
    help: "Whole-transaction retries after transient DB failures",
    labelNames: ["operation", "reason"],
    registers: [this.registry],
  });
  private readonly lockConflicts = new Counter({
    name: "db_lock_conflicts_total",
    help: "Lock timeouts, deadlocks and serialization failures",
    labelNames: ["reason"],
    registers: [this.registry],
  });
  private readonly sqs = new Counter({
    name: "sqs_messages_total",
    help: "Consumed SQS messages by result (ack, retry, dlq, duplicate)",
    labelNames: ["result"],
    registers: [this.registry],
  });
  private readonly outboxPublishedTotal = new Counter({
    name: "outbox_published_total",
    help: "Outbox events published",
    registers: [this.registry],
  });
  private readonly outboxFailures = new Counter({
    name: "outbox_publish_failures_total",
    help: "Failed outbox publish attempts (will be retried with backoff)",
    registers: [this.registry],
  });
  private readonly outboxLag = new Histogram({
    name: "outbox_publish_lag_seconds",
    help: "Time between the business commit (occurredAt) and the broker accepting the event",
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300],
    registers: [this.registry],
  });
  private readonly reconciliations = new Counter({
    name: "reconciliation_checks_total",
    help: "Wallet reconciliations by result",
    labelNames: ["result"],
    registers: [this.registry],
  });
  private readonly reconciliationMismatches = new Counter({
    name: "reconciliation_mismatches_total",
    help: "Wallets whose stored balance diverged from the ledger",
    registers: [this.registry],
  });
  private readonly submissionFailures = new Counter({
    name: "wager_submission_failures_total",
    help: "Submissions that did not become a business outcome (audited), by channel and reason",
    labelNames: ["channel", "reason"],
    registers: [this.registry],
  });
  private readonly pendingRefResolutions = new Counter({
    name: "pending_reference_resolutions_total",
    help: "PENDING_REFERENCE re-evaluations by outcome",
    labelNames: ["outcome"],
    registers: [this.registry],
  });

  constructor(defaultLabels: Record<string, string> = {}) {
    this.registry.setDefaultLabels(defaultLabels);
    collectDefaultMetrics({ register: this.registry });
  }

  /** DB/SQS-backed gauges, evaluated lazily on scrape. A failing source never breaks the scrape. */
  registerGauges(sources: GaugeSources): void {
    const safe = async (fn: () => Promise<void>) => {
      try {
        await fn();
      } catch {
        // source unavailable (DB/SQS down): keep the last value
      }
    };
    if (sources.outboxStats) {
      const outboxStats = sources.outboxStats;
      const pending = new Gauge({
        name: "outbox_pending_messages",
        help: "Unpublished outbox events",
        registers: [this.registry],
      });
      new Gauge({
        name: "outbox_lag_seconds",
        help: "Age of the oldest unpublished outbox event (0 when the outbox is drained)",
        registers: [this.registry],
        async collect() {
          await safe(async () => {
            const s = await outboxStats();
            pending.set(s.pending);
            this.set(
              s.oldestPendingOccurredAt ? (Date.now() - s.oldestPendingOccurredAt.getTime()) / 1000 : 0,
            );
          });
        },
      });
    }
    if (sources.pendingReferences) {
      const fn = sources.pendingReferences;
      new Gauge({
        name: "pending_reference_transactions",
        help: "Transactions waiting for their referenced transaction",
        registers: [this.registry],
        async collect() {
          await safe(async () => this.set(await fn()));
        },
      });
    }
    if (sources.dlqDepth) {
      const fn = sources.dlqDepth;
      new Gauge({
        name: "sqs_dlq_depth",
        help: "Approximate number of messages in the wager DLQ",
        registers: [this.registry],
        async collect() {
          await safe(async () => this.set(await fn()));
        },
      });
    }
  }

  transactionOutcome(l: { kind: string; status: string; channel: Channel }) {
    this.transactions.inc(l);
  }
  processingDuration(l: { channel: Channel; outcome: string }, seconds: number) {
    this.duration.observe(l, seconds);
  }
  idempotentReplay(channel: Channel) {
    this.replays.inc({ channel });
  }
  idempotencyConflict(channel: Channel, reason: string) {
    this.conflicts.inc({ channel, reason });
  }
  inboxDuplicate() {
    this.inboxDuplicates.inc();
  }
  transientRetry(operation: string, reason: string) {
    this.retries.inc({ operation, reason });
  }
  lockConflict(reason: string) {
    this.lockConflicts.inc({ reason });
  }
  sqsMessage(result: "ack" | "retry" | "dlq" | "duplicate") {
    this.sqs.inc({ result });
  }
  outboxPublished(count: number, lagSeconds: number[]) {
    this.outboxPublishedTotal.inc(count);
    for (const lag of lagSeconds) this.outboxLag.observe(lag);
  }
  outboxPublishFailure() {
    this.outboxFailures.inc();
  }
  reconciliation(consistent: boolean) {
    this.reconciliations.inc({ result: consistent ? "consistent" : "mismatch" });
    if (!consistent) this.reconciliationMismatches.inc();
  }
  pendingReferenceResolution(outcome: string) {
    this.pendingRefResolutions.inc({ outcome });
  }
  submissionFailure(channel: Channel, reason: string) {
    this.submissionFailures.inc({ channel, reason });
  }
}
