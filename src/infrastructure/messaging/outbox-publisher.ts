import { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import type { StructuredLogger } from '../../application/ports';
import type { OutboxMessage } from '../../domain/outbox-message';
import type { UnitOfWork } from '../../domain/ports/repositories';
import type { Clock } from '../../domain/ports/system';
import type { PrometheusMetrics } from '../observability/metrics';
import { PollingWorker } from './polling-worker';
import type { SqsGateway } from './sqs-gateway';

export interface OutboxPublisherOptions {
  instanceId: string;
  batchSize: number;
  leaseMs: number;
  pollIntervalMs: number;
}

const SQS_BATCH_LIMIT = 10;

/**
 * Publishes committed outbox rows to SQS (at-least-once).
 *
 * claim (short tx, SKIP LOCKED + lease) -> send (no tx open) -> mark
 * published (short tx). If the process dies after the claim, the lease
 * expires and any other instance re-claims the rows; if it dies after the
 * send but before the mark, the event is re-sent: consumers de-duplicate by
 * eventId (also used as the FIFO MessageDeduplicationId). Failures are
 * retried with exponential backoff and never dropped.
 */
export class OutboxPublisher extends PollingWorker {
  protected readonly workerName = 'outbox-publisher';
  /** unique per publisher, even for several publishers inside one process */
  readonly owner: string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly sqs: SqsGateway,
    private readonly clock: Clock,
    private readonly metrics: PrometheusMetrics,
    logger: StructuredLogger,
    private readonly options: OutboxPublisherOptions,
  ) {
    super(logger, options.pollIntervalMs);
    this.owner = `${options.instanceId}:${randomUUID().slice(0, 8)}`;
  }

  /** One claim/publish/mark cycle. @returns true when a batch was processed */
  async tick(): Promise<boolean> {
    const batch = await this.uow.run((s) => s.outbox.claimBatch(this.owner, this.options.leaseMs, this.options.batchSize));
    if (batch.length === 0) return false;

    const { published, failed } = await this.publish(batch);

    const now = this.clock.now();
    if (published.length > 0) {
      const marked = await this.uow.run((s) => s.outbox.markPublished(published.map((m) => m.id), now));
      for (let i = marked; i < published.length; i++) this.metrics.duplicateDetected('outbox-republish');
      for (const m of published) {
        this.metrics.outboxPublished.inc({ event_type: m.eventType });
        this.metrics.outboxPublishDelay.observe(Math.max(0, (now.getTime() - m.occurredAt.getTime()) / 1000));
      }
    }
    for (const { message, error } of failed) {
      message.scheduleRetry(now);
      this.metrics.retry('outbox', 'publish-failed');
      await this.uow.run((s) => s.outbox.scheduleRetry(message, this.owner, error));
    }
    if (failed.length > 0) {
      this.logger.warn('outbox publish failures', { failed: failed.length, published: published.length });
    }
    return true;
  }

  /** Sends in SQS batches of 10; any failure (including resolving the queue) is per message. */
  private async publish(batch: OutboxMessage[]): Promise<{ published: OutboxMessage[]; failed: Array<{ message: OutboxMessage; error: string }> }> {
    const published: OutboxMessage[] = [];
    const failed: Array<{ message: OutboxMessage; error: string }> = [];
    let queueUrl: string;
    try {
      queueUrl = (await this.sqs.queueUrls()).events;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { published, failed: batch.map((message) => ({ message, error: reason })) };
    }

    for (let i = 0; i < batch.length; i += SQS_BATCH_LIMIT) {
      const chunk = batch.slice(i, i + SQS_BATCH_LIMIT);
      try {
        const response = await this.sqs.client.send(
          new SendMessageBatchCommand({
            QueueUrl: queueUrl,
            Entries: chunk.map((m, index) => ({
              Id: String(index),
              MessageBody: JSON.stringify(m.payload),
              MessageGroupId: m.aggregateId,
              MessageDeduplicationId: m.id,
              MessageAttributes: { eventType: { DataType: 'String', StringValue: m.eventType } },
            })),
          }),
        );
        const failedIds = new Map((response.Failed ?? []).map((f) => [f.Id, f.Message ?? f.Code ?? 'send failed']));
        chunk.forEach((m, index) => {
          const error = failedIds.get(String(index));
          if (error) failed.push({ message: m, error });
          else published.push(m);
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        for (const m of chunk) failed.push({ message: m, error: reason });
      }
    }
    return { published, failed };
  }
}
