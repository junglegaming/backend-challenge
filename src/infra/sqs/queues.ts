import { CreateQueueCommand, GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { config } from '../../config';

export const createSqsClient = (): SQSClient =>
  new SQSClient({
    endpoint: config.sqs.endpoint,
    region: config.sqs.region,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
    maxAttempts: 2,
  });

/** Token de injeção das URLs das filas. */
export const QUEUES = 'QUEUES';

export interface QueueUrls {
  input: string;
  dlq: string;
  events: string;
}

/**
 * Cria as filas se não existirem (idempotente) e devolve as URLs. Em produção isso seria IaC;
 * aqui garante que `docker compose up` basta. A redrive policy move para a DLQ, sem código nosso,
 * qualquer mensagem recebida mais que `maxReceiveCount` vezes.
 */
export async function ensureQueues(sqs: SQSClient): Promise<QueueUrls> {
  const create = async (name: string, attributes: Record<string, string> = {}): Promise<string> => {
    const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: 'true', ...attributes } }));
    return QueueUrl!;
  };
  const dlq = await create(config.sqs.dlq);
  const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ['QueueArn'] }));
  const input = await create(config.sqs.inputQueue, {
    VisibilityTimeout: String(config.sqs.visibilityTimeoutSeconds),
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: Attributes!.QueueArn, maxReceiveCount: config.sqs.maxReceiveCount }),
  });
  const events = await create(config.sqs.eventsQueue);
  return { input, dlq, events };
}

export async function queueDepth(sqs: SQSClient, queueUrl: string): Promise<number> {
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['ApproximateNumberOfMessages'] }),
  );
  return Number(Attributes?.ApproximateNumberOfMessages ?? 0);
}
