import { type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand, SQSClient, type Message,
} from '@aws-sdk/client-sqs';
import { IdempotencyConflictError, InvalidRequestError, PermanentMessageError, WalletNotFoundError } from '../../application/errors';
import type { ConsumeWagerMessage } from '../../application/wagering/consume-wager-message';
import { InvalidMoneyError } from '../../domain/shared/domain-error';
import { InvalidTransactionError } from '../../domain/wagering/wagering.errors';
import { correlationId, runWithContext, validCorrelationId } from '../../application/observability/context';
import { NOOP_TELEMETRY, type Telemetry } from '../../application/observability/telemetry';
import { JsonLogger } from '../observability/json-logger';
import { createHash } from 'node:crypto';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { extractTrace, traced } from '../../application/observability/tracing';

const VISIBILITY_SECONDS = 60;

export class SqsWagerConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new JsonLogger(SqsWagerConsumer.name);
  private stopping = false;
  private receiveAbort: AbortController | undefined;
  private loopPromise: Promise<void> | undefined;

  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
    private readonly consume: ConsumeWagerMessage,
    private readonly telemetry: Telemetry = NOOP_TELEMETRY,
  ) {}

  onModuleInit(): void {
    this.loopPromise = this.loop();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    this.receiveAbort?.abort();
    await this.loopPromise;
    this.client.destroy();
  }

  async handle(message: Message): Promise<void> {
    let envelope: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(message.Body ?? '');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) envelope = parsed as Record<string, unknown>;
    } catch { /* The consumer validates the body. */ }
    const messageId = typeof envelope.messageId === 'string' ? envelope.messageId : message.MessageId;
    const id = validCorrelationId(envelope.correlationId) ? envelope.correlationId
      : messageId && !validCorrelationId(messageId) ? createHash('sha256').update(messageId).digest('hex') : correlationId(messageId);
    const traceparent = message.MessageAttributes?.traceparent?.StringValue;
    const tracestate = message.MessageAttributes?.tracestate?.StringValue;
    const parent = extractTrace({
      ...(traceparent ? { traceparent } : {}),
      ...(tracestate ? { tracestate } : {}),
    });
    return traced('SQS process', SpanKind.CONSUMER, (span) => {
      span.setAttribute('messaging.system', 'aws_sqs');
      return runWithContext({ correlationId: id, ...(messageId ? { messageId } : {}) }, () => this.handleInContext(message, () =>
        span.setStatus({ code: SpanStatusCode.ERROR })));
    }, parent);
  }

  private async handleInContext(message: Message, markError: () => void): Promise<void> {
    const started = performance.now();
    const receipt = message.ReceiptHandle;
    if (!receipt || message.Body === undefined) throw new Error('SQS message lacks receipt handle or body');
    const count = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    if (count > 1) this.telemetry.retry('sqs');
    const heartbeat = setInterval(() => {
      void this.client.send(new ChangeMessageVisibilityCommand({
        QueueUrl: this.queueUrl, ReceiptHandle: receipt, VisibilityTimeout: VISIBILITY_SECONDS,
      })).catch(() => this.logger.error('Failed to extend SQS visibility'));
    }, 20_000);
    heartbeat.unref();
    try {
      try {
        await this.consume.execute(message.Body);
      } catch (error) {
        markError();
        const permanent = error instanceof InvalidRequestError || error instanceof InvalidMoneyError
          || error instanceof InvalidTransactionError || error instanceof IdempotencyConflictError
          || error instanceof WalletNotFoundError || error instanceof PermanentMessageError;
        this.logger.error(`${permanent ? 'Permanent' : 'Transient or unexpected'} SQS processing failure (receive ${count})`);
        const delay = Math.min(300, 2 ** Math.min(Math.max(count - 1, 0), 8));
        await this.client.send(new ChangeMessageVisibilityCommand({
          QueueUrl: this.queueUrl, ReceiptHandle: receipt, VisibilityTimeout: delay,
        }));
        return;
      }
      await this.client.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: receipt }));
    } finally {
      clearInterval(heartbeat);
      this.telemetry.latency('sqs', (performance.now() - started) / 1000);
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      this.receiveAbort = new AbortController();
      try {
        const response = await this.client.send(new ReceiveMessageCommand({
          QueueUrl: this.queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 10,
          VisibilityTimeout: VISIBILITY_SECONDS, MessageSystemAttributeNames: ['ApproximateReceiveCount'],
          MessageAttributeNames: ['traceparent', 'tracestate'],
        }), { abortSignal: this.receiveAbort.signal });
        for (const message of response.Messages ?? []) await this.handle(message);
      } catch (error) {
        if (this.stopping && error instanceof Error && error.name === 'AbortError') break;
        this.logger.error('SQS receive, visibility or ack failed; message will be redelivered');
        if (!this.stopping) await Bun.sleep(1000);
      } finally {
        this.receiveAbort = undefined;
      }
    }
  }
}
