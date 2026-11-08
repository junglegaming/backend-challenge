import { EntityManager } from '@mikro-orm/postgresql';
import type { OutboxPublisherStore, OutboxPublisherTransaction, PendingOutboxMessage } from '../../application/outbox/publish-outbox';
import { SpanKind } from '@opentelemetry/api';
import { parseTraceCarrier, traced } from '../../application/observability/tracing';

export class SqlOutboxPublisherStore implements OutboxPublisherStore {
  constructor(private readonly em: EntityManager) {}

  async run<T>(work: (tx: OutboxPublisherTransaction) => Promise<T>): Promise<T> {
    return this.em.fork().transactional(async (em) => {
      const connection = em.getConnection();
      const ctx = em.getTransactionContext();
      return work({
        async claim(now): Promise<PendingOutboxMessage | undefined> {
          const rows = await traced('PostgreSQL outbox claim', SpanKind.CLIENT, () => connection.execute<PendingOutboxMessage[]>(
            `select id, aggregate_id as "aggregateId", payload, attempts, trace_context as "traceContext"
             from outbox_messages where published_at is null and next_attempt_at <= ?::timestamptz
             order by next_attempt_at, id limit 1 for update skip locked`,
            [now.toISOString()], 'all', ctx,
          ));
          const row = rows[0];
          return row ? { ...row, traceContext: parseTraceCarrier(row.traceContext) } : undefined;
        },
        async markPublished(id, now): Promise<void> {
          const result = await traced('PostgreSQL outbox update', SpanKind.CLIENT, () => connection.execute<{ affectedRows: number }>(
            'update outbox_messages set published_at = ?::timestamptz where id = ?::uuid and published_at is null',
            [now.toISOString(), id], 'run', ctx,
          ));
          if (result.affectedRows !== 1) throw new Error(`outbox event ${id} could not be marked published`);
        },
        async scheduleRetry(id, attempts, nextAttemptAt): Promise<void> {
          const result = await traced('PostgreSQL outbox update', SpanKind.CLIENT, () => connection.execute<{ affectedRows: number }>(
            `update outbox_messages set attempts = ?, next_attempt_at = ?::timestamptz
             where id = ?::uuid and published_at is null`,
            [attempts, nextAttemptAt.toISOString(), id], 'run', ctx,
          ));
          if (result.affectedRows !== 1) throw new Error(`outbox event ${id} could not be rescheduled`);
        },
      });
    });
  }
}
