import type { EntityManager } from "@mikro-orm/postgresql";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import { OutboxMessageRow } from "../entities";

/** Transactional outbox storage and the claim protocol used by publishers. */
export class OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(messages: readonly OutboxMessage[]): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    await this.em.insertMany(
      OutboxMessageRow,
      messages.map((m) => ({
        id: m.id,
        aggregateId: m.aggregateId,
        eventType: m.eventType,
        payload: m.payload as Record<string, unknown>,
        occurredAt: m.occurredAt,
        attempts: m.attempts,
        nextAttemptAt: m.nextAttemptAt ?? m.occurredAt,
      })),
    );
  }

  /**
   * Claims up to `limit` due messages for `owner` by setting a lease.
   *
   * - FOR UPDATE SKIP LOCKED: concurrent publishers never claim the same row.
   * - The lease (`locked_until`) survives the claim transaction, so the row
   *   stays reserved while we talk to SQS without holding a DB transaction.
   * - If the publisher dies, the lease expires and another instance takes over.
   */
  async claimDue(owner: string, limit: number, leaseMs: number): Promise<OutboxMessage[]> {
    const rows = await this.em.execute<
      {
        id: string;
        aggregate_id: string;
        event_type: string;
        payload: Record<string, unknown>;
        occurred_at: Date;
        attempts: number;
        next_attempt_at: Date;
      }[]
    >(
      `UPDATE outbox_messages o
          SET locked_by = ?, locked_until = now() + (? || ' milliseconds')::interval
         FROM (
           SELECT id FROM outbox_messages
            WHERE published_at IS NULL
              AND (attempts = 0 OR next_attempt_at <= now())
              AND (locked_until IS NULL OR locked_until < now())
            ORDER BY next_attempt_at, occurred_at
            LIMIT ?
            FOR UPDATE SKIP LOCKED
         ) due
        WHERE o.id = due.id
      RETURNING o.id, o.aggregate_id, o.event_type, o.payload, o.occurred_at, o.attempts, o.next_attempt_at`,
      [owner, String(leaseMs), limit],
    );
    return rows.map((r) =>
      OutboxMessage.rehydrate({
        id: r.id,
        aggregateId: r.aggregate_id,
        eventType: r.event_type,
        payload: r.payload,
        occurredAt: new Date(r.occurred_at),
        attempts: r.attempts,
        nextAttemptAt: new Date(r.next_attempt_at),
      }),
    );
  }

  /** Marks as published only if we still own the lease. */
  async markPublished(message: OutboxMessage, owner: string): Promise<void> {
    await this.em.nativeUpdate(
      OutboxMessageRow,
      { id: message.id, lockedBy: owner },
      { publishedAt: message.publishedAt, lockedBy: null, lockedUntil: null, lastError: null },
    );
  }

  /** Releases the lease and schedules the next attempt (backoff computed by the domain). */
  async scheduleRetry(message: OutboxMessage, owner: string, error: string): Promise<void> {
    await this.em.nativeUpdate(
      OutboxMessageRow,
      { id: message.id, lockedBy: owner },
      {
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt,
        lockedBy: null,
        lockedUntil: null,
        lastError: error.slice(0, 500),
      },
    );
  }

  /** Age in seconds of the oldest unpublished event (0 when the outbox is empty). */
  async lagSeconds(): Promise<number> {
    const [row] = await this.em.execute<{ lag: string | null }[]>(
      `SELECT EXTRACT(EPOCH FROM (now() - MIN(occurred_at)))::text AS lag
         FROM outbox_messages WHERE published_at IS NULL`,
    );
    return row?.lag ? Math.max(0, Number.parseFloat(row.lag)) : 0;
  }
}

