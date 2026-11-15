import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { AppConfig } from '../config/app-config';

export interface QueueUrls {
  transactions: string;
  dlq: string;
  events: string;
}

/** Owns the SQS client and resolves queue URLs lazily (and caches them). */
export class SqsGateway {
  readonly client: SQSClient;
  private urls: QueueUrls | undefined;

  constructor(private readonly config: AppConfig) {
    this.client = new SQSClient({
      region: config.AWS_REGION,
      // With LocalStack the returned QueueUrl host may not be resolvable from
      // every network: always talk to the configured endpoint instead.
      ...(config.AWS_ENDPOINT_URL ? { endpoint: config.AWS_ENDPOINT_URL, useQueueUrlAsEndpoint: false } : {}),
      credentials: { accessKeyId: config.AWS_ACCESS_KEY_ID, secretAccessKey: config.AWS_SECRET_ACCESS_KEY },
      maxAttempts: 3,
    });
  }

  async queueUrls(): Promise<QueueUrls> {
    if (!this.urls) {
      const [transactions, dlq, events] = await Promise.all([
        this.url(this.config.SQS_TRANSACTIONS_QUEUE),
        this.url(this.config.SQS_TRANSACTIONS_DLQ),
        this.url(this.config.SQS_EVENTS_QUEUE),
      ]);
      this.urls = { transactions, dlq, events };
    }
    return this.urls;
  }

  async approximateDepth(queueUrl: string): Promise<number> {
    const result = await this.client.send(
      new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['ApproximateNumberOfMessages'] }),
    );
    return Number(result.Attributes?.ApproximateNumberOfMessages ?? 0);
  }

  /** Readiness probe: the queue can be resolved and queried. */
  async ping(): Promise<void> {
    const urls = await this.queueUrls();
    await this.approximateDepth(urls.transactions);
  }

  /**
   * Idempotent provisioning (CreateQueue returns the existing queue). The
   * redrive policy is a safety net: the consumer already moves messages to the
   * DLQ itself after CONSUMER_MAX_ATTEMPTS, SQS does it one receive later.
   */
  async ensureQueues(): Promise<QueueUrls> {
    const fifo = { FifoQueue: 'true', ContentBasedDeduplication: 'false' };
    const dlq = await this.client.send(new CreateQueueCommand({ QueueName: this.config.SQS_TRANSACTIONS_DLQ, Attributes: fifo }));
    const dlqArn = await this.client.send(
      new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl!, AttributeNames: ['QueueArn'] }),
    );
    await this.client.send(
      new CreateQueueCommand({
        QueueName: this.config.SQS_TRANSACTIONS_QUEUE,
        Attributes: {
          ...fifo,
          VisibilityTimeout: String(this.config.CONSUMER_VISIBILITY_TIMEOUT_SECONDS),
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: dlqArn.Attributes!.QueueArn,
            maxReceiveCount: this.config.CONSUMER_MAX_ATTEMPTS + 1,
          }),
        },
      }),
    );
    await this.client.send(new CreateQueueCommand({ QueueName: this.config.SQS_EVENTS_QUEUE, Attributes: fifo }));
    this.urls = undefined;
    return this.queueUrls();
  }

  destroy(): void {
    this.client.destroy();
  }

  private async url(name: string): Promise<string> {
    const result = await this.client.send(new GetQueueUrlCommand({ QueueName: name }));
    if (!result.QueueUrl) throw new Error(`Queue ${name} not found`);
    return result.QueueUrl;
  }
}
