import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { Injectable } from "@nestjs/common";
import { Configuration } from "../../config/config";
import { QUEUES } from "../../observability/health/dependencies";
import { canonicalHash } from "../../shared/application/canonical-json";
import { OutboxMessage } from "../domain/outbox-message";

export function deadLetterDeduplicationId(messageId: string, reason: string): string {
  const identity = `${messageId}:${reason}`;
  // SQS caps deduplication IDs at 128 characters, including the appended reason.
  return identity.length <= 128 ? identity : canonicalHash(identity);
}

@Injectable()
export class SqsTransport {
  readonly client: SQSClient;
  private readonly urls = new Map<string, string>();
  constructor(private readonly configuration: Configuration) {
    const config = configuration.values.sqs;
    this.client = new SQSClient({
      ...config,
      ...(config.credentials ? { credentials: { ...config.credentials } } : {}),
      md5: false,
      maxAttempts: 1,
      useQueueUrlAsEndpoint: false,
    });
  }
  async queue(name: string): Promise<string> {
    const cached = this.urls.get(name);
    if (cached) return cached;
    const { QueueUrl } = await this.client.send(new GetQueueUrlCommand({ QueueName: name }), {
      abortSignal: AbortSignal.timeout(2000),
    });
    if (!QueueUrl) throw new Error("Missing queue URL");
    this.urls.set(name, QueueUrl);
    return QueueUrl;
  }
  async receive(
    name: string,
    signal: AbortSignal,
    waitSeconds = this.configuration.values.consumer.waitSeconds,
  ): Promise<Message[]> {
    const config = this.configuration.values.consumer;
    const QueueUrl = await this.queue(name);
    const { Messages } = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl,
        WaitTimeSeconds: waitSeconds,
        MaxNumberOfMessages: config.batchSize,
        VisibilityTimeout: config.visibilitySeconds,
        MessageSystemAttributeNames: [
          "ApproximateReceiveCount",
          "MessageGroupId",
          "MessageDeduplicationId",
        ],
        MessageAttributeNames: ["All"],
      }),
      { abortSignal: AbortSignal.any([signal, AbortSignal.timeout((waitSeconds + 5) * 1000)]) },
    );
    return Messages ?? [];
  }
  async acknowledge(name: string, message: Message): Promise<void> {
    if (!message.ReceiptHandle) throw new Error("Missing receipt handle");
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: await this.queue(name),
        ReceiptHandle: message.ReceiptHandle,
      }),
      { abortSignal: AbortSignal.timeout(2000) },
    );
  }
  async visibility(name: string, message: Message, seconds: number): Promise<void> {
    if (!message.ReceiptHandle) throw new Error("Missing receipt handle");
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: await this.queue(name),
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: seconds,
      }),
      { abortSignal: AbortSignal.timeout(2000) },
    );
  }
  async deadLetter(message: Message, messageId: string, reason: string): Promise<void> {
    await this.send(
      QUEUES.deadLetters,
      message.Body ?? "",
      message.Attributes?.MessageGroupId ?? message.MessageId ?? "invalid",
      deadLetterDeduplicationId(messageId, reason),
      reason,
    );
  }
  async send(
    name: string,
    body: string,
    groupId: string,
    deduplicationId: string,
    reason?: string,
  ): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.queue(name),
        MessageBody: body,
        MessageGroupId: groupId,
        MessageDeduplicationId: deduplicationId,
        MessageAttributes: reason
          ? { reason: { DataType: "String", StringValue: reason } }
          : undefined,
      }),
      { abortSignal: AbortSignal.timeout(2000) },
    );
  }
  async publish(messages: OutboxMessage[]): Promise<Set<string>> {
    const result = await this.client.send(
      new SendMessageBatchCommand({
        QueueUrl: await this.queue(QUEUES.events),
        Entries: messages.map((message) => ({
          Id: message.id,
          MessageBody: JSON.stringify(message.payload),
          MessageGroupId: message.aggregateId,
          MessageDeduplicationId: message.id,
        })),
      }),
      { abortSignal: AbortSignal.timeout(2000) },
    );
    return new Set(result.Successful?.flatMap((entry) => (entry.Id ? [entry.Id] : [])));
  }
  close(): void {
    this.client.destroy();
  }
}
