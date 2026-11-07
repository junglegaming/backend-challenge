import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { Telemetry } from '../../application/observability/telemetry';
import type { Metrics } from '../../application/ports/wallet-queries.port';

export class PrometheusMetrics implements Metrics, Telemetry {
  readonly registry = new Registry();
  private readonly transactions = new Counter({ name: 'wager_transactions_total', help: 'Committed transaction outcomes', labelNames: ['status'], registers: [this.registry] });
  private readonly duplicates = new Counter({ name: 'wager_duplicates_total', help: 'Committed idempotent duplicates', labelNames: ['source'], registers: [this.registry] });
  private readonly retries = new Counter({ name: 'wager_retries_total', help: 'Retry attempts', labelNames: ['source'], registers: [this.registry] });
  private readonly locks = new Counter({ name: 'wager_lock_conflicts_total', help: 'Database lock timeouts and deadlocks', registers: [this.registry] });
  private readonly reconciliations = new Counter({ name: 'wallet_reconciliation_divergence_total', help: 'Divergent reconciliation checks', labelNames: ['currency'], registers: [this.registry] });
  private readonly durations = new Histogram({ name: 'wager_operation_duration_seconds', help: 'Operation duration in seconds', labelNames: ['operation'], registers: [this.registry] });
  private outboxProbe?: () => Promise<number>;
  private dlqProbe?: () => Promise<number>;

  constructor() {
    const getOutbox = () => this.outboxProbe?.();
    const getDlq = () => this.dlqProbe?.();
    new Gauge({
      name: 'wager_outbox_oldest_unpublished_seconds',
      help: 'Age of the oldest unpublished outbox event, zero when empty',
      registers: [this.registry],
      collect: async function () {
        const probe = getOutbox();
        if (probe) this.set(await probe);
      },
    });
    new Gauge({
      name: 'wager_dlq_messages',
      help: 'Approximate number of visible and in-flight messages in the SQS dead letter queue',
      registers: [this.registry],
      collect: async function () {
        const probe = getDlq();
        if (probe) this.set(await probe);
      },
    });
  }

  configureProbes(outbox: () => Promise<number>, dlq: () => Promise<number>): void {
    this.outboxProbe = outbox;
    this.dlqProbe = dlq;
  }

  transaction(status: string): void { this.transactions.inc({ status }); }
  duplicate(source: 'inbox' | 'transaction'): void { this.duplicates.inc({ source }); }
  retry(source: 'sqs' | 'outbox' | 'reference'): void { this.retries.inc({ source }); }
  lockConflict(): void { this.locks.inc(); }
  latency(operation: 'http' | 'sqs' | 'transaction', seconds: number): void { this.durations.observe({ operation }, seconds); }
  increment(name: string, labels: Record<string, string> = {}): void {
    if (name !== 'wallet_reconciliation_divergence_total' || !labels.currency) throw new Error(`Unknown metric ${name}`);
    this.reconciliations.inc({ currency: labels.currency });
  }
  render(): Promise<string> { return this.registry.metrics(); }
}
