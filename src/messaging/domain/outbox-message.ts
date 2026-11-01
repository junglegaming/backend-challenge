import { DomainError } from "../../shared/domain/domain-error";
import { IntegrationEvent } from "../../shared/domain/integration-event";

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt?: Date;
}

export class OutboxMessage {
  private readonly payloadJson: string;
  private constructor(private readonly state: OutboxMessageState) {
    this.payloadJson = JSON.stringify(state.payload);
  }

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: event.toJSON(),
      occurredAt: event.occurredAt,
      attempts: 0,
      nextAttemptAt: event.occurredAt,
    });
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage({
      ...state,
      occurredAt: new Date(state.occurredAt),
      nextAttemptAt: new Date(state.nextAttemptAt),
      publishedAt: state.publishedAt && new Date(state.publishedAt),
    });
  }

  get id() {
    return this.state.id;
  }
  get aggregateId() {
    return this.state.aggregateId;
  }
  get eventType() {
    return this.state.eventType;
  }
  get payload(): Readonly<Record<string, unknown>> {
    return JSON.parse(this.payloadJson);
  }
  get occurredAt() {
    return new Date(this.state.occurredAt);
  }
  get attempts() {
    return this.state.attempts;
  }
  get nextAttemptAt() {
    return new Date(this.state.nextAttemptAt);
  }
  get publishedAt() {
    return this.state.publishedAt && new Date(this.state.publishedAt);
  }
  isPending(): boolean {
    return this.state.publishedAt === undefined;
  }
  isDue(now: Date): boolean {
    return this.isPending() && this.state.nextAttemptAt <= now;
  }

  markPublished(at: Date): void {
    if (!this.isPending()) throw new DomainError("Outbox message is already published");
    this.state.publishedAt = new Date(at);
  }

  scheduleRetry(
    now: Date,
    options: { leaseMs?: number; maxMs?: number; random?: () => number } = {},
  ): void {
    if (!this.isPending()) throw new DomainError("Published messages cannot retry");
    const { leaseMs = 15_000, maxMs = 300_000, random = Math.random } = options;
    this.state.attempts += 1;
    const base = Math.min(maxMs, leaseMs * 2 ** Math.min(this.attempts, 30));
    const delay = Math.min(maxMs, Math.floor(base * (1 + random() * 0.2)));
    this.state.nextAttemptAt = new Date(now.getTime() + delay);
  }
}
