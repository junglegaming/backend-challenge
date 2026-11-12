import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from "prom-client";

/**
 * Prometheus metrics exposed at GET /metrics.
 *
 * Labels are low-cardinality on purpose (kind, status, channel, reason):
 * never wallet ids or transaction ids, which would explode the series count.
 */
export const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry });

export const metrics = {
  transactions: new Counter({
    name: "wager_transactions_total",
    help: "Wager transactions by final status of the attempt",
    labelNames: ["kind", "status", "channel"] as const,
    registers: [metricsRegistry],
  }),
  duplicates: new Counter({
    name: "wager_duplicates_total",
    help: "Duplicates detected (idempotent replay, inbox redelivery) and idempotency conflicts",
    labelNames: ["type", "channel"] as const,
    registers: [metricsRegistry],
  }),
  retries: new Counter({
    name: "wager_retries_total",
    help: "Retries scheduled after transient failures",
    labelNames: ["component", "reason"] as const,
    registers: [metricsRegistry],
  }),
  deadLettered: new Counter({
    name: "sqs_dead_lettered_messages_total",
    help: "Messages moved to the DLQ",
    labelNames: ["reason"] as const,
    registers: [metricsRegistry],
  }),
  lockConflicts: new Counter({
    name: "wallet_lock_conflicts_total",
    help: "Lock timeouts/deadlocks while acquiring a wallet row lock",
    registers: [metricsRegistry],
  }),
  outboxLag: new Gauge({
    name: "outbox_lag_seconds",
    help: "Age of the oldest unpublished outbox event",
    registers: [metricsRegistry],
  }),
  outboxPublished: new Counter({
    name: "outbox_published_total",
    help: "Outbox events published to SQS",
    labelNames: ["event_type"] as const,
    registers: [metricsRegistry],
  }),
  processingDuration: new Histogram({
    name: "wager_processing_duration_seconds",
    help: "End-to-end latency of the wager use case",
    labelNames: ["channel"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [metricsRegistry],
  }),
  pendingReferenceResolved: new Counter({
    name: "pending_reference_resolutions_total",
    help: "Outcome of PENDING_REFERENCE retries",
    labelNames: ["outcome"] as const,
    registers: [metricsRegistry],
  }),
  reconciliationDivergences: new Counter({
    name: "reconciliation_divergences_total",
    help: "Wallets whose stored balance diverged from the ledger",
    registers: [metricsRegistry],
  }),
};

