import type { IntegrationEvent } from './events/integration-event';

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

export interface RetryPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_OUTBOX_RETRY: RetryPolicy = { baseDelayMs: 1_000, maxDelayMs: 5 * 60_000 };

/**
 * Exponential backoff with "equal jitter": half deterministic, half random,
 * so concurrent publishers do not retry in lock-step.
 */
export const backoffDelayMs = (attempt: number, policy: RetryPolicy, random: () => number = Math.random): number => {
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp / 2 + (random() * exp) / 2);
};

/**
 * Integration event waiting to be published. Written in the same SQL
 * transaction as the financial change; published by a worker afterwards.
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

  /** The outbox id is the event id, so consumers can de-duplicate by it. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const envelope = event.toJSON();
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      Object.freeze(envelope as unknown as Record<string, unknown>),
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
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    this._publishedAt ??= at;
  }

  /** Increments attempts and computes the next nextAttemptAt (exponential backoff). */
  scheduleRetry(now: Date, policy: RetryPolicy = DEFAULT_OUTBOX_RETRY): void {
    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + backoffDelayMs(this._attempts, policy));
  }
}
