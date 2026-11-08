import { Counter, Gauge, Histogram, Registry } from 'prom-client';

/** Métricas Prometheus, expostas em GET /metrics. */
export class MetricasService {
  readonly registro = new Registry();

  readonly transacoes = new Counter({
    name: 'wagering_transactions_total',
    help: 'Transações por tipo, status e origem',
    labelNames: ['kind', 'status', 'source'],
    registers: [this.registro],
  });
  readonly duplicatas = new Counter({
    name: 'wagering_duplicates_total',
    help: 'Duplicatas detectadas (replay idempotente ou redelivery no inbox)',
    labelNames: ['kind'],
    registers: [this.registro],
  });
  readonly conflitosDeIdempotencia = new Counter({
    name: 'wagering_idempotency_conflicts_total',
    help: 'Mesma idempotency key com payload diferente',
    registers: [this.registro],
  });
  readonly conflitosDeConcorrencia = new Counter({
    name: 'wagering_lock_conflicts_total',
    help: 'Conflitos de concorrência (unique, versão, deadlock, lock timeout)',
    labelNames: ['reason'],
    registers: [this.registro],
  });
  readonly novasTentativas = new Counter({
    name: 'wagering_retries_total',
    help: 'Retentativas por operação',
    labelNames: ['operation'],
    registers: [this.registro],
  });
  readonly mensagensNaDlq = new Counter({
    name: 'wagering_dlq_messages_total',
    help: 'Mensagens enviadas para a DLQ',
    labelNames: ['reason'],
    registers: [this.registro],
  });
  readonly atrasoDaOutbox = new Gauge({
    name: 'wagering_outbox_lag_seconds',
    help: 'Idade do evento pendente mais antigo da outbox',
    registers: [this.registro],
  });
  readonly tempoDeProcessamento = new Histogram({
    name: 'wagering_processing_duration_seconds',
    help: 'Latência de processamento de transações',
    labelNames: ['source'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registro],
  });
  readonly divergenciasDeReconciliacao = new Counter({
    name: 'wagering_reconciliation_divergences_total',
    help: 'Reconciliações com saldo diferente do ledger',
    registers: [this.registro],
  });
}
