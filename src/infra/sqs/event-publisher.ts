import { SendMessageBatchCommand, SQSClient } from '@aws-sdk/client-sqs';
import { EventPublisher } from '../../application/ports';
import { OutboxMessage } from '../../domain/messaging';

export class SqsEventPublisher extends EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {
    super();
  }

  /** Uma chamada ao SQS por lote (o limite do SendMessageBatch é 10), em vez de uma por evento. */
  async publish(messages: OutboxMessage[]): Promise<Set<string>> {
    const { Failed = [] } = await this.sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: this.queueUrl,
        Entries: messages.map((message) => ({
          Id: message.id,
          MessageBody: JSON.stringify(message.payload),
          // Ordenação e dedup do broker são otimização: a garantia é o eventId no consumidor.
          MessageGroupId: message.aggregateId,
          MessageDeduplicationId: message.id,
          MessageAttributes: { eventType: { DataType: 'String', StringValue: message.eventType } },
        })),
      }),
    );
    return new Set(Failed.map((failure) => failure.Id!));
  }
}
