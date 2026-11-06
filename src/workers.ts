import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
  SendMessageCommand,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import { DataSource } from 'typeorm';
import { createHash } from 'node:crypto';
import { metrics } from './metrics';
import { AppService } from './app.service';
import { retryDelaySeconds } from './retry-policy';

@Injectable()
export class Workers implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger(Workers.name);
  private readonly sqs = new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.SQS_ENDPOINT,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });
  private stopping = false;
  private polling = false;
  private activePoll?: Promise<void>;
  constructor(
    private readonly db: DataSource,
    private readonly app: AppService,
  ) {}
  onModuleInit() {
    void this.startPoll();
  }
  async onApplicationShutdown() {
    this.stopping = true;
    await this.activePoll;
  }
  private startPoll() {
    if (this.activePoll) return this.activePoll;
    const task = this.poll();
    this.activePoll = task;
    void task.finally(() => {
      if (this.activePoll === task) this.activePoll = undefined;
    });
    return task;
  }
  private async poll() {
    if (this.polling || this.stopping) return;
    this.polling = true;
    const queue = process.env.WAGER_QUEUE_URL;
    try {
      if (queue) {
        const r = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queue,
            WaitTimeSeconds: Number.parseInt(process.env.SQS_LONG_POLL_SECONDS ?? '10', 10),
            VisibilityTimeout: Number.parseInt(
              process.env.SQS_MESSAGE_VISIBILITY_SECONDS ?? '30',
              10,
            ),
            MaxNumberOfMessages: 10,
            MessageSystemAttributeNames: ['ApproximateReceiveCount'],
          }),
        );
        for (const msg of r.Messages ?? []) {
          if (!msg.Body || !msg.ReceiptHandle) continue;
          try {
            const envelope = JSON.parse(msg.Body),
              d = envelope.data;
            const messageId = String(envelope.messageId),
              payloadHash = createHash('sha256').update(JSON.stringify(envelope)).digest('hex');
            await this.app.submit(d, d.idempotencyKey, undefined, { messageId, payloadHash });
            if (
              process.env.NODE_ENV === 'test' &&
              Number(process.env.TEST_PAUSE_AFTER_COMMIT_MS) > 0
            )
              await new Promise((resolve) =>
                setTimeout(resolve, Number(process.env.TEST_PAUSE_AFTER_COMMIT_MS)),
              );
            if (
              process.env.NODE_ENV === 'test' &&
              process.env.TEST_EMIT_SIGTERM_AFTER_COMMIT_MESSAGE_ID === messageId
            )
              process.emit('SIGTERM');
            if (
              process.env.NODE_ENV === 'test' &&
              process.env.TEST_CRASH_AFTER_COMMIT_MESSAGE_ID === messageId
            ) {
              await this.sqs.send(
                new ChangeMessageVisibilityCommand({
                  QueueUrl: queue,
                  ReceiptHandle: msg.ReceiptHandle,
                  VisibilityTimeout: 1,
                }),
              );
              process.kill(process.pid, 'SIGKILL');
              return;
            }
            await this.sqs.send(
              new DeleteMessageCommand({ QueueUrl: queue, ReceiptHandle: msg.ReceiptHandle }),
            );
          } catch (e) {
            metrics.increment('sqs_consumer_retries_total');
            this.log.error(
              JSON.stringify({
                messageId: msg.MessageId,
                error: e instanceof Error ? e.message : 'unknown',
              }),
            );
            const attempt = Number.parseInt(msg.Attributes?.ApproximateReceiveCount ?? '1', 10),
              base = Number.parseInt(process.env.SQS_RETRY_VISIBILITY_SECONDS ?? '0', 10),
              maximum = Number.parseInt(process.env.SQS_RETRY_MAX_VISIBILITY_SECONDS ?? '300', 10),
              delay = retryDelaySeconds(attempt, base, maximum);
            await this.sqs.send(
              new ChangeMessageVisibilityCommand({
                QueueUrl: queue,
                ReceiptHandle: msg.ReceiptHandle,
                VisibilityTimeout: delay,
              }),
            );
          }
        }
      }
    } catch (e) {
      this.log.warn(`SQS polling unavailable: ${e instanceof Error ? e.message : 'unknown'}`);
    } finally {
      this.polling = false;
    }
  }
  @Cron(CronExpression.EVERY_5_SECONDS) async pollQueue() {
    await this.startPoll();
    const dlq = process.env.DLQ_QUEUE_URL;
    if (dlq) {
      try {
        const q = await this.sqs.send(
          new GetQueueAttributesCommand({
            QueueUrl: dlq,
            AttributeNames: ['ApproximateNumberOfMessages'],
          }),
        );
        metrics.gauge(
          'wagering_dlq_messages',
          Number(q.Attributes?.ApproximateNumberOfMessages ?? 0),
        );
      } catch {
        /* readiness reports SQS outages */
      }
    }
  }
  @Cron(CronExpression.EVERY_5_SECONDS) async retryReferences() {
    try {
      await this.app.retryPendingReferences();
    } catch (e) {
      this.log.warn(
        `Pending reference retry failed: ${e instanceof Error ? e.message : 'unknown'}`,
      );
    }
  }
  @Cron(CronExpression.EVERY_SECOND) async publishOutbox() {
    const queue = process.env.EVENT_QUEUE_URL;
    if (
      !queue ||
      (process.env.NODE_ENV === 'test' && process.env.TEST_DISABLE_OUTBOX_PUBLISHER === 'true')
    )
      return;
    try {
      const leaseSeconds = Number.parseInt(process.env.OUTBOX_LOCK_SECONDS ?? '30', 10);
      const claimResult = await this.db.query(
        `WITH claimed AS (SELECT id FROM outbox_messages WHERE published_at IS NULL AND COALESCE(next_attempt_at,now())<=now() AND COALESCE(locked_until,now())<=now() ORDER BY occurred_at FOR UPDATE SKIP LOCKED LIMIT 20) UPDATE outbox_messages AS o SET locked_until=now()+make_interval(secs=>$1) FROM claimed AS c WHERE o.id=c.id RETURNING o.id,o.aggregate_id,o.event_type,o.payload,o.occurred_at,o.attempts`,
        [leaseSeconds],
      );
      const rows = Array.isArray(claimResult[0]) ? claimResult[0] : claimResult;
      for (const row of rows) {
        if (
          process.env.NODE_ENV === 'test' &&
          process.env.TEST_CRASH_AFTER_OUTBOX_CLAIM_ID === String(row.id)
        ) {
          process.kill(process.pid, 'SIGKILL');
          return;
        }
        const body = JSON.stringify(row.payload),
          groupId = String(row.aggregate_id),
          dedupId = String(row.id);
        try {
          await this.sqs.send(
            new SendMessageCommand({
              QueueUrl: queue,
              MessageBody: body,
              MessageGroupId: groupId,
              MessageDeduplicationId: dedupId,
            }),
          );
          await this.db.query(
            'UPDATE outbox_messages SET published_at=now(),locked_until=NULL WHERE id=$1',
            [row.id],
          );
        } catch (e) {
          metrics.increment('outbox_publish_retries_total');
          const failure = e as { message?: string; code?: string; $metadata?: unknown };
          this.log.error(
            JSON.stringify({
              event: 'outbox_publish_failed',
              eventId: row.id,
              error: failure.message ?? 'unknown',
              code: failure.code,
              queue,
              bodyLength: body?.length,
              groupId,
              dedupId,
              metadata: failure.$metadata,
            }),
          );
          await this.db.query(
            'UPDATE outbox_messages SET attempts=attempts+1,next_attempt_at=now()+make_interval(secs=>LEAST(300,power(2,attempts)::int)),locked_until=NULL WHERE id=$1',
            [row.id],
          );
        }
      }
      const lag = await this.db.query(
        'SELECT EXTRACT(EPOCH FROM (now()-MIN(occurred_at))) AS seconds FROM outbox_messages WHERE published_at IS NULL',
      );
      metrics.gauge('outbox_lag_seconds', Number(lag[0].seconds ?? 0));
    } catch (e) {
      this.log.warn(`Outbox publisher unavailable: ${e instanceof Error ? e.message : 'unknown'}`);
    }
  }
}
