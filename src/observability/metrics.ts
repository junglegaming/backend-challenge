import { Counter, Gauge, Histogram, Registry } from 'prom-client';

export const registry = new Registry();

export const metrics = {
  transactions: new Counter({
    name: 'wager_transactions_total',
    help: 'Transações resolvidas, por tipo, status e código de falha',
    labelNames: ['kind', 'status', 'failure_code'] as const,
    registers: [registry],
  }),
  duplicates: new Counter({
    name: 'wager_duplicates_total',
    help: 'Duplicatas detectadas: replay idempotente, conflito de payload ou mensagem repetida na inbox',
    labelNames: ['type'] as const,
    registers: [registry],
  }),
  retries: new Counter({
    name: 'wager_retries_total',
    help: 'Novas tentativas, por origem (sqs, outbox, pending_reference, idempotency_race)',
    labelNames: ['source'] as const,
    registers: [registry],
  }),
  dlq: new Counter({
    name: 'wager_dlq_messages_total',
    help: 'Mensagens enviadas explicitamente para a DLQ, por motivo',
    labelNames: ['reason'] as const,
    registers: [registry],
  }),
  lockConflicts: new Counter({
    name: 'wager_lock_conflicts_total',
    help: 'Timeouts de lock, deadlocks e falhas de serialização',
    registers: [registry],
  }),
  processingSeconds: new Histogram({
    name: 'wager_processing_duration_seconds',
    help: 'Latência do caso de uso de submissão, por entrada',
    labelNames: ['source'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  }),
  outboxPublished: new Counter({
    name: 'wager_outbox_published_total',
    help: 'Eventos publicados pela outbox',
    labelNames: ['event_type'] as const,
    registers: [registry],
  }),
  reconciliationDivergences: new Counter({
    name: 'wallet_reconciliation_divergences_total',
    help: 'Reconciliações em que o saldo materializado diverge do ledger',
    registers: [registry],
  }),
};

/** Gauges calculados na hora do scrape (outbox lag, tamanho da DLQ). Registrados pela infraestrutura. */
export const registerGauge = (name: string, help: string, read: () => Promise<number>): void => {
  new Gauge({
    name,
    help,
    registers: [registry],
    async collect() {
      this.set(await read().catch(() => Number.NaN));
    },
  });
};
