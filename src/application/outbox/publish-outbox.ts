import type { Clock } from '../ports/clock-and-ids.port';

export interface PendingOutboxMessage {
  id: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export interface OutboxPublisherTransaction {
  claim(now: Date): Promise<PendingOutboxMessage | undefined>;
  markPublished(id: string, now: Date): Promise<void>;
  scheduleRetry(id: string, attempts: number, nextAttemptAt: Date): Promise<void>;
}

export interface OutboxPublisherStore {
  run<T>(work: (tx: OutboxPublisherTransaction) => Promise<T>): Promise<T>;
}

export interface EventPublisher {
  publish(message: PendingOutboxMessage): Promise<void>;
}

export interface PublishLogger {
  error(message: string, error: unknown): void;
}

export class PublishOutbox {
  constructor(
    private readonly store: OutboxPublisherStore,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly logger: PublishLogger,
  ) {}

  async runOne(): Promise<boolean> {
    return this.store.run(async (tx) => {
      const message = await tx.claim(this.clock.now());
      if (!message) return false;
      try {
        await this.publisher.publish(message);
      } catch (error) {
        this.logger.error(`SQS publish failed for outbox event ${message.id}`, error);
        const attempts = message.attempts + 1;
        const delayMs = Math.min(1000 * 2 ** Math.min(attempts - 1, 10), 300_000);
        await tx.scheduleRetry(message.id, attempts, new Date(this.clock.now().getTime() + delayMs));
        return true;
      }
      await tx.markPublished(message.id, this.clock.now());
      return true;
    });
  }
}
