import { Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand, SQSClient, type Message,
} from '@aws-sdk/client-sqs';
import { IdempotencyConflictError, InvalidRequestError, PermanentMessageError, WalletNotFoundError } from '../../application/errors';
import type { ConsumeWagerMessage } from '../../application/wagering/consume-wager-message';
import { InvalidMoneyError } from '../../domain/shared/domain-error';
import { InvalidTransactionError } from '../../domain/wagering/wagering.errors';

const VISIBILITY_SECONDS = 60;

export class SqsWagerConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SqsWagerConsumer.name);
  private stopping = false;
  private receiveAbort: AbortController | undefined;
  private loopPromise: Promise<void> | undefined;

  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
    private readonly consume: ConsumeWagerMessage,
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
    const receipt = message.ReceiptHandle;
    if (!receipt || message.Body === undefined) throw new Error('SQS message lacks receipt handle or body');
    const count = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    const heartbeat = setInterval(() => {
      void this.client.send(new ChangeMessageVisibilityCommand({
        QueueUrl: this.queueUrl, ReceiptHandle: receipt, VisibilityTimeout: VISIBILITY_SECONDS,
      })).catch((error: unknown) => this.logger.error('Failed to extend SQS visibility', error instanceof Error ? error.stack : String(error)));
    }, 20_000);
    heartbeat.unref();
    try {
      try {
        await this.consume.execute(message.Body);
      } catch (error) {
        const permanent = error instanceof InvalidRequestError || error instanceof InvalidMoneyError
          || error instanceof InvalidTransactionError || error instanceof IdempotencyConflictError
          || error instanceof WalletNotFoundError || error instanceof PermanentMessageError;
        this.logger.error(`${permanent ? 'Permanent' : 'Transient or unexpected'} SQS processing failure (receive ${count})`,
          error instanceof Error ? error.stack : String(error));
        const delay = Math.min(300, 2 ** Math.min(Math.max(count - 1, 0), 8));
        await this.client.send(new ChangeMessageVisibilityCommand({
          QueueUrl: this.queueUrl, ReceiptHandle: receipt, VisibilityTimeout: delay,
        }));
        return;
      }
      await this.client.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: receipt }));
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      this.receiveAbort = new AbortController();
      try {
        const response = await this.client.send(new ReceiveMessageCommand({
          QueueUrl: this.queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 10,
          VisibilityTimeout: VISIBILITY_SECONDS, MessageSystemAttributeNames: ['ApproximateReceiveCount'],
        }), { abortSignal: this.receiveAbort.signal });
        for (const message of response.Messages ?? []) await this.handle(message);
      } catch (error) {
        if (this.stopping && error instanceof Error && error.name === 'AbortError') break;
        this.logger.error('SQS receive, visibility or ack failed; message will be redelivered',
          error instanceof Error ? error.stack : String(error));
        if (!this.stopping) await Bun.sleep(1000);
      } finally {
        this.receiveAbort = undefined;
      }
    }
  }
}
