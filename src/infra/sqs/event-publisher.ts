import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { EventPublisher } from '../../application/ports';
import { OutboxMessage } from '../../domain/messaging';

export class SqsEventPublisher extends EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {
    super();
  }

  async publish(message: OutboxMessage): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message.payload),
        // Ordenação e dedup do broker são otimização: a garantia é o eventId no consumidor.
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
        MessageAttributes: { eventType: { DataType: 'String', StringValue: message.eventType } },
      }),
    );
  }
}
