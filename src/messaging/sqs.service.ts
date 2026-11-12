import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  type Message as SqsWireMessage,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/config";
import { logger } from "../observability/logger";

export interface ResolvedQueues {
  wagerQueueUrl: string;
  wagerDlqUrl: string;
  eventsQueueUrl: string;
}

/**
 * Thin wrapper around the AWS SQS SDK.
 *
 * Ensures that the required FIFO queues (`wager-transactions.fifo`,
 * `wager-transactions-dlq.fifo` and `wallet-events.fifo`) exist at startup
 * with a redrive policy attached, so local development and integration tests
 * work out of the box without external shell scripts.
 */
@Injectable()
export class SqsService implements OnModuleInit, OnModuleDestroy {
  private readonly client: SQSClient;
  private queues?: ResolvedQueues;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.client = new SQSClient({
      region: config.sqs.region,
      ...(config.sqs.endpoint ? { endpoint: config.sqs.endpoint } : {}),
      credentials: {
        accessKeyId: config.sqs.accessKeyId,
        secretAccessKey: config.sqs.secretAccessKey,
      },
    });
  }

  async onModuleInit(): Promise<void> {
    await this.ensureQueues();
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }

  /** Idempotently creates or resolves the FIFO queues and DLQ redrive policy. */
  async ensureQueues(): Promise<ResolvedQueues> {
    if (this.queues) {
      return this.queues;
    }

    const wagerDlqUrl = await this.ensureFifoQueue(this.config.sqs.wagerDlqName);
    const dlqAttrs = await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: wagerDlqUrl,
        AttributeNames: ["QueueArn"],
      }),
    );
    const dlqArn = dlqAttrs.Attributes?.QueueArn;

    const wagerQueueUrl = await this.ensureFifoQueue(
      this.config.sqs.wagerQueueName,
      dlqArn
        ? {
            RedrivePolicy: JSON.stringify({
              deadLetterTargetArn: dlqArn,
              maxReceiveCount: String(this.config.sqs.maxReceiveCount),
            }),
          }
        : undefined,
    );
    const eventsQueueUrl = await this.ensureFifoQueue(this.config.sqs.eventsQueueName);

    this.queues = { wagerQueueUrl, wagerDlqUrl, eventsQueueUrl };
    logger.info(
      {
        wagerQueue: this.config.sqs.wagerQueueName,
        wagerDlq: this.config.sqs.wagerDlqName,
        eventsQueue: this.config.sqs.eventsQueueName,
      },
      "SQS FIFO queues ready",
    );
    return this.queues;
  }

  async receiveWagerMessages(maxMessages = 10, waitTimeSeconds?: number): Promise<SqsWireMessage[]> {
    const { wagerQueueUrl } = await this.ensureQueues();
    const res = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: wagerQueueUrl,
        MaxNumberOfMessages: maxMessages,
        WaitTimeSeconds: waitTimeSeconds ?? this.config.sqs.waitTimeSeconds,
        VisibilityTimeout: this.config.sqs.visibilityTimeoutSeconds,
        AttributeNames: ["All"],
        MessageSystemAttributeNames: ["All"],
        MessageAttributeNames: ["All"],
      }),
    );
    return res.Messages ?? [];
  }

  async ackWagerMessage(receiptHandle: string): Promise<void> {
    const { wagerQueueUrl } = await this.ensureQueues();
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: wagerQueueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  async changeWagerMessageVisibility(receiptHandle: string, visibilityTimeoutSeconds: number): Promise<void> {
    const { wagerQueueUrl } = await this.ensureQueues();
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: wagerQueueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: Math.max(0, Math.floor(visibilityTimeoutSeconds)),
      }),
    );
  }

  /** Explicitly moves a permanently invalid/poison message to the DLQ and removes it from the main queue. */
  async sendToDlqAndAck(
    rawBody: string,
    receiptHandle: string,
    messageGroupId: string,
    deduplicationId: string,
    reason: string,
  ): Promise<void> {
    const { wagerDlqUrl } = await this.ensureQueues();
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: wagerDlqUrl,
        MessageBody: rawBody,
        MessageGroupId: sanitizeFifoToken(messageGroupId || "dlq"),
        MessageDeduplicationId: sanitizeFifoToken(deduplicationId || `dlq-${Date.now()}`),
        MessageAttributes: {
          DlqReason: { DataType: "String", StringValue: reason.slice(0, 250) },
        },
      }),
    );
    await this.ackWagerMessage(receiptHandle);
  }

  /** Publishes an integration event envelope to the events FIFO queue. */
  async publishIntegrationEvent(
    eventId: string,
    aggregateId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const { eventsQueueUrl } = await this.ensureQueues();
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: eventsQueueUrl,
        MessageBody: JSON.stringify(payload),
        MessageGroupId: sanitizeFifoToken(aggregateId),
        MessageDeduplicationId: sanitizeFifoToken(eventId),
        MessageAttributes: {
          EventType: { DataType: "String", StringValue: eventType },
        },
      }),
    );
  }

  /** Helper used by tests and scripts to enqueue a wager command onto `wager-transactions.fifo`. */
  async sendWagerMessage(
    body: Record<string, unknown>,
    messageGroupId: string,
    deduplicationId: string,
  ): Promise<void> {
    const { wagerQueueUrl } = await this.ensureQueues();
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: wagerQueueUrl,
        MessageBody: JSON.stringify(body),
        MessageGroupId: sanitizeFifoToken(messageGroupId),
        MessageDeduplicationId: sanitizeFifoToken(deduplicationId),
      }),
    );
  }

  /** Helper used by tests to inspect messages on either the events queue or the DLQ. */
  async receiveFromQueue(queueUrl: string, maxMessages = 10, waitTimeSeconds = 1): Promise<SqsWireMessage[]> {
    const res = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: maxMessages,
        WaitTimeSeconds: waitTimeSeconds,
        AttributeNames: ["All"],
        MessageAttributeNames: ["All"],
      }),
    );
    return res.Messages ?? [];
  }

  /** Cheap reachability probe used by `GET /health/ready`. */
  async ping(): Promise<void> {
    const { wagerQueueUrl } = await this.ensureQueues();
    await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: wagerQueueUrl,
        AttributeNames: ["ApproximateNumberOfMessages"],
      }),
    );
  }

  private async ensureFifoQueue(name: string, extraAttributes?: Record<string, string>): Promise<string> {
    const isFifo = name.endsWith(".fifo");
    try {
      const created = await this.client.send(
        new CreateQueueCommand({
          QueueName: name,
          Attributes: {
            ...(isFifo
              ? {
                  FifoQueue: "true",
                  ContentBasedDeduplication: "false",
                }
              : {}),
            VisibilityTimeout: String(this.config.sqs.visibilityTimeoutSeconds),
            ...extraAttributes,
          },
        }),
      );
      if (created.QueueUrl) {
        return created.QueueUrl;
      }
    } catch {
      // Fall back to GetQueueUrl if the queue already exists with slightly different attributes.
    }
    const existing = await this.client.send(new GetQueueUrlCommand({ QueueName: name }));
    if (!existing.QueueUrl) {
      throw new Error(`Unable to resolve SQS queue URL for ${name}`);
    }
    return existing.QueueUrl;
  }
}

function sanitizeFifoToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, "_").slice(0, 128) || "default";
}

