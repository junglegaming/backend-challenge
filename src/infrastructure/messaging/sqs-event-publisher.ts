import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher, PendingOutboxMessage } from '../../application/outbox/publish-outbox';

export class SqsEventPublisher implements EventPublisher {
  constructor(private readonly client: SQSClient, private readonly queueUrl: string) {}

  async publish(message: PendingOutboxMessage): Promise<void> {
    await this.client.send(new SendMessageCommand({
      QueueUrl: this.queueUrl,
      MessageBody: JSON.stringify(message.payload),
      MessageGroupId: message.aggregateId,
      MessageDeduplicationId: message.id,
    }), { abortSignal: AbortSignal.timeout(20_000) });
  }

  close(): void {
    this.client.destroy();
  }
}
