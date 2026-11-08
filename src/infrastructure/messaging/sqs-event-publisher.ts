import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher, PendingOutboxMessage } from '../../application/outbox/publish-outbox';
import { SpanKind } from '@opentelemetry/api';
import { captureTrace, extractTrace, traced } from '../../application/observability/tracing';

export class SqsEventPublisher implements EventPublisher {
  constructor(private readonly client: SQSClient, private readonly queueUrl: string) {}

  async publish(message: PendingOutboxMessage): Promise<void> {
    await traced('SQS publish', SpanKind.PRODUCER, async (span) => {
      span.setAttribute('messaging.system', 'aws_sqs');
      const carrier = captureTrace();
      await this.client.send(new SendMessageCommand({
      QueueUrl: this.queueUrl,
      MessageBody: JSON.stringify(message.payload),
      MessageGroupId: message.aggregateId,
      MessageDeduplicationId: message.id,
      MessageAttributes: {
        ...(carrier.traceparent ? { traceparent: { DataType: 'String', StringValue: carrier.traceparent } } : {}),
        ...(carrier.tracestate ? { tracestate: { DataType: 'String', StringValue: carrier.tracestate } } : {}),
      },
      }), { abortSignal: AbortSignal.timeout(20_000) });
    }, extractTrace(message.traceContext));
  }

  close(): void {
    this.client.destroy();
  }
}
