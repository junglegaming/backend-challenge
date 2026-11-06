import { DomainError } from './money';
export class InboxMessage {
  private constructor(
    readonly messageId: string,
    readonly consumerName: string,
    readonly payloadHash: string,
    readonly receivedAt: Date,
    private doneAt?: Date,
  ) {}
  static receive(p: {
    messageId: string;
    consumerName: string;
    payloadHash: string;
    receivedAt?: Date;
  }) {
    return new InboxMessage(p.messageId, p.consumerName, p.payloadHash, p.receivedAt ?? new Date());
  }
  static rehydrate(p: {
    messageId: string;
    consumerName: string;
    payloadHash: string;
    receivedAt: Date;
    processedAt?: Date;
  }) {
    return new InboxMessage(
      p.messageId,
      p.consumerName,
      p.payloadHash,
      p.receivedAt,
      p.processedAt,
    );
  }
  get processedAt() {
    return this.doneAt;
  }
  isProcessed() {
    return this.doneAt !== undefined;
  }
  markProcessed(at: Date) {
    if (this.isProcessed())
      throw new DomainError('INVALID_INBOX_STATE', 'Inbox message is already processed');
    this.doneAt = at;
  }
}
export class OutboxMessage {
  private constructor(
    readonly id: string,
    readonly aggregateId: string,
    readonly eventType: string,
    readonly payload: Readonly<Record<string, unknown>>,
    readonly occurredAt: Date,
    private retryCount: number,
    private next?: Date,
    private published?: Date,
  ) {}
  static enqueue(p: {
    id: string;
    aggregateId: string;
    eventType: string;
    payload: Readonly<Record<string, unknown>>;
    occurredAt: Date;
  }) {
    return new OutboxMessage(
      p.id,
      p.aggregateId,
      p.eventType,
      Object.freeze({ ...p.payload }),
      p.occurredAt,
      0,
    );
  }
  static rehydrate(p: {
    id: string;
    aggregateId: string;
    eventType: string;
    payload: Readonly<Record<string, unknown>>;
    occurredAt: Date;
    attempts: number;
    nextAttemptAt?: Date;
    publishedAt?: Date;
  }) {
    return new OutboxMessage(
      p.id,
      p.aggregateId,
      p.eventType,
      Object.freeze({ ...p.payload }),
      p.occurredAt,
      p.attempts,
      p.nextAttemptAt,
      p.publishedAt,
    );
  }
  get attempts() {
    return this.retryCount;
  }
  get nextAttemptAt() {
    return this.next;
  }
  get publishedAt() {
    return this.published;
  }
  isPending() {
    return this.published === undefined;
  }
  isDue(now: Date) {
    return this.isPending() && (!this.next || this.next <= now);
  }
  markPublished(at: Date) {
    if (!this.isPending())
      throw new DomainError('INVALID_OUTBOX_STATE', 'Outbox entry already published');
    this.published = at;
  }
  scheduleRetry(now: Date) {
    if (!this.isPending())
      throw new DomainError('INVALID_OUTBOX_STATE', 'Outbox entry is already published');
    this.retryCount += 1;
    this.next = new Date(now.getTime() + Math.min(300_000, 1000 * 2 ** this.retryCount));
  }
}
