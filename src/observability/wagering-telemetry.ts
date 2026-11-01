import { Injectable } from "@nestjs/common";
import { Counter, Gauge, Histogram, Registry } from "prom-client";
import { JsonLogger } from "./json-logger";
import { LogContext, ProcessingChannel } from "./log-context";

@Injectable()
export class WageringTelemetry {
  readonly registry = new Registry();
  readonly transactions = this.counter("transactions_total", "Committed wagering outcomes", [
    "status",
    "kind",
    "channel",
  ]);
  readonly duplicates = this.counter("duplicates_total", "Committed duplicate submissions", [
    "source",
  ]);
  readonly conflicts = this.counter("idempotency_conflicts_total", "Conflicting submissions", [
    "type",
  ]);
  readonly retries = this.counter("retries_total", "Retry attempts", ["operation"]);
  readonly dlq = this.counter("dlq_messages_total", "Confirmed explicit dead letter handoffs", [
    "reason",
  ]);
  readonly queue = this.gauge("sqs_queue_messages", "Approximate queue messages", [
    "queue",
    "state",
  ]);
  readonly lockConflicts = this.counter("lock_conflicts_total", "Database lock conflicts", [
    "reason",
  ]);
  readonly lockWait = this.histogram("wallet_lock_wait_seconds", "Wallet lock acquisition time", [
    "channel",
  ]);
  readonly duration = this.histogram(
    "processing_duration_seconds",
    "Submission or reference attempt duration",
    ["channel", "status"],
  );
  readonly outboxLag = this.gauge("outbox_lag_seconds", "Age of oldest unpublished event");
  readonly published = this.counter(
    "outbox_published_total",
    "Confirmed and marked outbox events",
    ["event_type"],
  );
  readonly publishFailures = this.counter(
    "outbox_publish_failures_total",
    "Unconfirmed outbox sends",
  );
  readonly pending = this.gauge(
    "pending_reference_transactions",
    "Transactions waiting for references",
  );
  readonly divergences = this.counter(
    "reconciliation_divergences_total",
    "Wallet reconciliation divergences",
  );

  constructor(
    readonly logger: JsonLogger,
    readonly context: LogContext,
  ) {}
  private counter(name: string, help: string, labelNames: string[] = []) {
    return new Counter({ name: `wagering_${name}`, help, labelNames, registers: [this.registry] });
  }
  private gauge(name: string, help: string, labelNames: string[] = []) {
    return new Gauge({ name: `wagering_${name}`, help, labelNames, registers: [this.registry] });
  }
  private histogram(name: string, help: string, labelNames: string[]) {
    return new Histogram({
      name: `wagering_${name}`,
      help,
      labelNames,
      buckets: [0.001, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
      registers: [this.registry],
    });
  }
  observeLock(start: number): void {
    this.lockWait.observe({ channel: this.context.channel() }, (performance.now() - start) / 1000);
  }
  observeDuration(channel: ProcessingChannel, status: string, start: number): void {
    this.duration.observe({ channel, status }, (performance.now() - start) / 1000);
  }

  reconciliationDiverged(walletId: string): void {
    this.divergences.inc();
    this.logger.failure({ event: "reconciliation_divergence", walletId });
  }
  databaseError(error: unknown): void {
    // Unwrap only for telemetry; financial retry classification keeps its original error boundary.
    for (let depth = 0; depth < 4 && error && typeof error === "object"; depth++) {
      if ("code" in error && (error.code === "55P03" || error.code === "40P01")) {
        this.lockConflicts.inc({ reason: error.code === "55P03" ? "lock_timeout" : "deadlock" });
        return;
      }
      error = "cause" in error ? error.cause : undefined;
    }
  }
}
