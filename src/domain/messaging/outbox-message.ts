import type { IntegrationEvent, IntegrationEventEnvelope } from "../events/integration-event";

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

/** Retry backoff: 1s, 2s, 4s, ... capped at 5 minutes. */
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 5 * 60_000;

/**
 * Integration event waiting to be published (Transactional Outbox).
 *
 * It is written in the same SQL transaction as the financial change, so an
 * event exists if and only if the change was committed. A background
 * publisher sends it to SQS afterwards; publishing may happen more than once
 * (crash between send and markPublished), which is why the envelope carries a
 * stable `eventId` for consumer-side deduplication.
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  /** The outbox id is the event id, so the same event is never enqueued twice. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const envelope: IntegrationEventEnvelope = event.toJSON();
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      envelope as unknown as Record<string, unknown>,
      event.occurredAt,
      0,
      event.occurredAt,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (!this._nextAttemptAt || this._nextAttemptAt.getTime() <= now.getTime());
  }

  markPublished(at: Date): void {
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  /** Increments attempts and computes the next attempt with exponential backoff. */
  scheduleRetry(now: Date): void {
    this._attempts += 1;
    const delay = Math.min(RETRY_BASE_MS * 2 ** (this._attempts - 1), RETRY_MAX_MS);
    this._nextAttemptAt = new Date(now.getTime() + delay);
  }
}

