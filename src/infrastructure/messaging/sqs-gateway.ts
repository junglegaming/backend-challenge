import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageBatchCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";

import { injectTraceContext } from "../observability/tracing";

export interface SqsSettings {
  region: string;
  endpoint?: string | undefined;
  verifyMd5: boolean;
  wagerQueueName: string;
  wagerDlqName: string;
  eventsQueueName: string;
  maxReceiveCount: number;
  visibilityTimeoutSeconds: number;
}

export interface OutgoingEvent {
  id: string;
  groupId: string;
  body: string;
  attributes?: Record<string, string>;
}

/**
 * Thin SQS adapter. FIFO features (MessageGroupId per wallet, MessageDeduplicationId per event) are used as
 * optimisations only — correctness never depends on them (the DB inbox/idempotency/constraints do).
 */
export class SqsGateway {
  readonly client: SQSClient;
  private readonly urls = new Map<string, Promise<string>>();

  constructor(readonly settings: SqsSettings) {
    this.client = new SQSClient({
      region: settings.region,
      endpoint: settings.endpoint,
      // Emulators need static credentials; real AWS uses the default provider chain.
      ...(settings.endpoint ? { credentials: { accessKeyId: "test", secretAccessKey: "test" } } : {}),
      ...(settings.verifyMd5 ? {} : { md5: false as const }),
      maxAttempts: 3,
    });
  }

  queueUrl(name: string): Promise<string> {
    let url = this.urls.get(name);
    if (!url) {
      url = this.client.send(new GetQueueUrlCommand({ QueueName: name })).then((r) => {
        if (!r.QueueUrl) throw new Error(`queue ${name} has no URL`);
        return r.QueueUrl;
      });
      url.catch(() => this.urls.delete(name));
      this.urls.set(name, url);
    }
    return url;
  }

  /** Idempotent bootstrap: FIFO queues, DLQ and redrive policy (maxReceiveCount). */
  async ensureQueues(): Promise<void> {
    const fifo = { FifoQueue: "true", ContentBasedDeduplication: "false" };
    const dlq = await this.client.send(
      new CreateQueueCommand({ QueueName: this.settings.wagerDlqName, Attributes: fifo }),
    );
    const dlqArn = (
      await this.client.send(
        new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ["QueueArn"] }),
      )
    ).Attributes?.QueueArn;
    if (!dlqArn) throw new Error("DLQ ARN unavailable");
    await this.client.send(
      new CreateQueueCommand({
        QueueName: this.settings.wagerQueueName,
        Attributes: {
          ...fifo,
          VisibilityTimeout: String(this.settings.visibilityTimeoutSeconds),
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: dlqArn,
            maxReceiveCount: this.settings.maxReceiveCount,
          }),
        },
      }),
    );
    await this.client.send(
      new CreateQueueCommand({ QueueName: this.settings.eventsQueueName, Attributes: fifo }),
    );
  }

  async sendWager(
    body: string,
    groupId: string,
    deduplicationId: string,
    correlationId?: string,
  ): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.queueUrl(this.settings.wagerQueueName),
        MessageBody: body,
        MessageGroupId: groupId,
        MessageDeduplicationId: deduplicationId,
        MessageAttributes: {
          ...(correlationId ? { correlationId: { DataType: "String", StringValue: correlationId } } : {}),
          // W3C trace context, so the consumer span continues the producer's trace.
          ...Object.fromEntries(
            Object.entries(injectTraceContext()).map(([k, v]) => [k, { DataType: "String", StringValue: v }]),
          ),
        },
      }),
    );
  }

  async receiveWagers(max: number, waitSeconds: number, signal?: AbortSignal): Promise<Message[]> {
    const res = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: await this.queueUrl(this.settings.wagerQueueName),
        MaxNumberOfMessages: Math.min(10, max),
        WaitTimeSeconds: waitSeconds,
        MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId", "SentTimestamp"],
        MessageAttributeNames: ["All"],
      }),
      { abortSignal: signal },
    );
    return res.Messages ?? [];
  }

  async ack(receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: await this.queueUrl(this.settings.wagerQueueName),
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  /** DeleteMessageBatch in chunks of 10 (the API limit). */
  async ackMany(receiptHandles: readonly string[]): Promise<void> {
    const url = await this.queueUrl(this.settings.wagerQueueName);
    for (let i = 0; i < receiptHandles.length; i += 10) {
      const chunk = receiptHandles.slice(i, i + 10);
      const res = await this.client.send(
        new DeleteMessageBatchCommand({
          QueueUrl: url,
          Entries: chunk.map((handle, k) => ({ Id: String(k), ReceiptHandle: handle })),
        }),
      );
      if (res.Failed && res.Failed.length > 0)
        throw new Error(`${res.Failed.length} message(s) not acknowledged`);
    }
  }

  async changeVisibility(receiptHandle: string, seconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: await this.queueUrl(this.settings.wagerQueueName),
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: Math.max(0, Math.min(43_200, Math.round(seconds))),
      }),
    );
  }

  /** Explicit dead-lettering for permanent failures (poison messages), with the reason as an attribute. */
  async sendToDlq(message: Message, reason: string, detail: string): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.queueUrl(this.settings.wagerDlqName),
        MessageBody: message.Body ?? "",
        MessageGroupId: message.Attributes?.MessageGroupId ?? "dlq",
        MessageDeduplicationId: message.MessageId ?? `${Date.now()}`,
        MessageAttributes: {
          failureReason: { DataType: "String", StringValue: reason },
          failureDetail: { DataType: "String", StringValue: detail.slice(0, 250) || "-" },
        },
      }),
    );
  }

  async publishEvents(events: readonly OutgoingEvent[]): Promise<{ failedIds: string[] }> {
    if (events.length === 0) return { failedIds: [] };
    const res = await this.client.send(
      new SendMessageBatchCommand({
        QueueUrl: await this.queueUrl(this.settings.eventsQueueName),
        Entries: events.map((e, i) => ({
          Id: String(i),
          MessageBody: e.body,
          MessageGroupId: e.groupId,
          // Broker-side de-duplication (5 min window) is an optimisation; consumers still de-dupe by eventId.
          MessageDeduplicationId: e.id,
          MessageAttributes: Object.fromEntries(
            Object.entries(e.attributes ?? {}).map(([k, v]) => [k, { DataType: "String", StringValue: v }]),
          ),
        })),
      }),
    );
    const failedIds = (res.Failed ?? []).map((f) => events[Number(f.Id)]?.id).filter((x): x is string => !!x);
    return { failedIds };
  }

  async queueDepth(name: string): Promise<number> {
    const res = await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: await this.queueUrl(name),
        AttributeNames: ["ApproximateNumberOfMessages"],
      }),
    );
    return Number(res.Attributes?.ApproximateNumberOfMessages ?? 0);
  }

  /** Readiness probe: the wager queue is reachable. */
  async ping(timeoutMs: number): Promise<void> {
    await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: await this.queueUrl(this.settings.wagerQueueName),
        AttributeNames: ["QueueArn"],
      }),
      { abortSignal: AbortSignal.timeout(timeoutMs) },
    );
  }

  destroy(): void {
    this.client.destroy();
  }
}
