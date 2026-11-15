import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { Inject, Injectable, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ApplicationError, TransientInfrastructureError } from '../../application/errors';
import { LogContext } from '../../application/log-context';
import { STRUCTURED_LOGGER, type StructuredLogger } from '../../application/ports';
import { SubmitWagerTransaction, type SubmitResult } from '../../application/submit-wager-transaction';
import { APP_CONFIG, type AppConfig } from '../../infrastructure/config/app-config';
import { SqsGateway } from '../../infrastructure/messaging/sqs-gateway';
import { PrometheusMetrics } from '../../infrastructure/observability/metrics';
import { parseOrThrow, queueEnvelopeSchema, toSubmitCommand } from '../contracts';

/** What to do with a message once its handling finished. */
type Disposition =
  | { action: 'ack'; result: string }
  | { action: 'retry'; reason: string }
  | { action: 'dlq'; reason: string; code: string };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * SQS consumer for wager-transactions.fifo.
 *
 *  - reuses the very same SubmitWagerTransaction use case as HTTP;
 *  - de-duplicates through the persistent inbox (consumer, messageId), written
 *    in the same SQL transaction as the financial change;
 *  - deletes (acks) a message only after that transaction committed;
 *  - business outcomes (PROCESSED / REJECTED / PENDING_REFERENCE / unknown
 *    wallet) are terminal -> ack; transient errors -> visibility backoff;
 *    permanent errors or exhausted attempts -> DLQ;
 *  - messages of one MessageGroupId (= wallet) are handled sequentially,
 *    different groups in parallel;
 *  - on shutdown it stops polling, finishes in-flight messages and returns
 *    not-yet-started ones to the queue (visibility 0).
 */
@Injectable()
export class WagerTransactionsConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private running = false;
  private readonly abort = new AbortController();
  private pollers: Promise<void>[] = [];
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(STRUCTURED_LOGGER) private readonly logger: StructuredLogger,
    private readonly sqs: SqsGateway,
    private readonly submit: SubmitWagerTransaction,
    private readonly metrics: PrometheusMetrics,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.CONSUMER_ENABLED) this.start();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const pollerCount = Math.max(1, Math.ceil(this.config.CONSUMER_CONCURRENCY / 10));
    this.pollers = Array.from({ length: pollerCount }, () => this.poll());
    this.logger.info('sqs consumer started', { pollers: pollerCount });
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abort.abort();
    const drained = Promise.allSettled([...this.pollers, ...this.inFlight]).then(() => true);
    const timedOut = sleep(this.config.CONSUMER_SHUTDOWN_TIMEOUT_MS).then(() => false);
    const finished = await Promise.race([drained, timedOut]);
    this.logger.info('sqs consumer stopped', { drained: finished });
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const { transactions } = await this.sqs.queueUrls();
        const response = await this.sqs.client.send(
          new ReceiveMessageCommand({
            QueueUrl: transactions,
            MaxNumberOfMessages: Math.min(10, Math.max(1, this.config.CONSUMER_CONCURRENCY)),
            WaitTimeSeconds: this.config.CONSUMER_WAIT_TIME_SECONDS,
            VisibilityTimeout: this.config.CONSUMER_VISIBILITY_TIMEOUT_SECONDS,
            MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
          }),
          { abortSignal: this.abort.signal },
        );
        const messages = response.Messages ?? [];
        if (messages.length === 0) continue;
        const work = this.dispatch(messages);
        this.inFlight.add(work);
        await work.finally(() => this.inFlight.delete(work));
      } catch (error) {
        if (!this.running) break;
        this.logger.warn('sqs receive failed', { error: error instanceof Error ? error.message : String(error) });
        await sleep(1_000);
      }
    }
  }

  /** Same group sequentially (FIFO per wallet), groups in parallel. */
  private async dispatch(messages: Message[]): Promise<void> {
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const group = message.Attributes?.MessageGroupId ?? message.MessageId ?? 'default';
      groups.set(group, [...(groups.get(group) ?? []), message]);
    }
    await Promise.all(
      [...groups.values()].map(async (group) => {
        for (const message of group) {
          if (this.running) {
            await this.handle(message);
          } else {
            await this.release(message);
          }
        }
      }),
    );
  }

  async handle(message: Message): Promise<void> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    let disposition: Disposition;
    let envelopeMessageId: string | undefined;
    try {
      const envelope = parseOrThrow(queueEnvelopeSchema, JSON.parse(message.Body ?? ''));
      envelopeMessageId = envelope.messageId;
      disposition = await LogContext.run(
        { correlationId: envelope.correlationId ?? envelope.messageId, messageId: envelope.messageId },
        async () => {
          const result = await this.submit.execute(toSubmitCommand(envelope.data, envelope.data.idempotencyKey), {
            source: 'sqs',
            correlationId: envelope.correlationId ?? envelope.messageId,
            inbox: { consumerName: this.config.CONSUMER_NAME, messageId: envelope.messageId },
          });
          this.injectFault();
          return { action: 'ack', result: describe(result) } as const;
        },
      );
    } catch (error) {
      disposition = this.classify(error, receiveCount);
      LogContext.run({ messageId: envelopeMessageId ?? message.MessageId }, () =>
        this.logger.warn('sqs message failed', {
          disposition: disposition.action,
          reason: 'reason' in disposition ? disposition.reason : undefined,
          receiveCount,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    await this.settle(message, disposition, receiveCount);
  }

  private classify(error: unknown, receiveCount: number): Disposition {
    if (error instanceof SyntaxError) return { action: 'dlq', reason: 'malformed-json', code: 'INVALID_PAYLOAD' };
    if (error instanceof ApplicationError) {
      switch (error.category) {
        case 'not-found':
          return { action: 'ack', result: 'not-found' };
        case 'validation':
        case 'conflict':
        case 'integrity':
          return { action: 'dlq', reason: error.category, code: error.code };
        case 'transient':
          break;
      }
    }
    // transient or unknown: retry until the attempt budget is spent
    if (receiveCount >= this.config.CONSUMER_MAX_ATTEMPTS) {
      return { action: 'dlq', reason: 'max-attempts', code: error instanceof ApplicationError ? error.code : 'UNEXPECTED' };
    }
    return { action: 'retry', reason: error instanceof TransientInfrastructureError ? error.reason : 'unexpected' };
  }

  private async settle(message: Message, disposition: Disposition, receiveCount: number): Promise<void> {
    const { transactions, dlq } = await this.sqs.queueUrls();
    try {
      switch (disposition.action) {
        case 'ack':
          await this.sqs.client.send(new DeleteMessageCommand({ QueueUrl: transactions, ReceiptHandle: message.ReceiptHandle }));
          this.metrics.sqsMessages.inc({ result: disposition.result });
          return;
        case 'retry': {
          const delay = Math.min(900, this.config.CONSUMER_RETRY_BASE_SECONDS * 2 ** (receiveCount - 1));
          await this.sqs.client.send(
            new ChangeMessageVisibilityCommand({ QueueUrl: transactions, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: delay }),
          );
          this.metrics.retry('sqs', disposition.reason);
          this.metrics.sqsMessages.inc({ result: 'retry' });
          return;
        }
        case 'dlq':
          // Send first, then delete: a crash in between only duplicates the DLQ entry.
          await this.sqs.client.send(
            new SendMessageCommand({
              QueueUrl: dlq,
              MessageBody: message.Body ?? '',
              MessageGroupId: message.Attributes?.MessageGroupId ?? 'dlq',
              MessageDeduplicationId: createHash('sha256').update(message.MessageId ?? message.Body ?? '').digest('hex').slice(0, 64),
              MessageAttributes: {
                reason: { DataType: 'String', StringValue: disposition.reason },
                errorCode: { DataType: 'String', StringValue: disposition.code },
              },
            }),
          );
          await this.sqs.client.send(new DeleteMessageCommand({ QueueUrl: transactions, ReceiptHandle: message.ReceiptHandle }));
          this.metrics.dlqMessages.inc({ reason: disposition.reason });
          this.metrics.sqsMessages.inc({ result: 'dlq' });
          return;
      }
    } catch (error) {
      // The message becomes visible again after the timeout; the inbox makes the redelivery harmless.
      this.logger.error('could not settle sqs message', {
        action: disposition.action,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async release(message: Message): Promise<void> {
    try {
      const { transactions } = await this.sqs.queueUrls();
      await this.sqs.client.send(
        new ChangeMessageVisibilityCommand({ QueueUrl: transactions, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: 0 }),
      );
    } catch (error) {
      this.logger.warn('could not release message on shutdown', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Test-only: simulate a worker dying after the commit and before the ack. */
  private injectFault(): void {
    if (this.config.FAULT_INJECTION === 'crash-after-commit') {
      this.logger.warn('fault injection: crashing after commit, before ack');
      process.exit(137);
    }
  }
}

const describe = (result: SubmitResult): string =>
  result.type === 'duplicate-message' ? 'duplicate' : result.outcome.idempotentReplay ? 'replay' : result.outcome.status.toLowerCase();
