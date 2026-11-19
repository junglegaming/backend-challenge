import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { z } from 'zod';
import { IdempotencyConflictError, MessageIdConflictError, WalletNotFoundError } from '../../application/errors';
import { sha256 } from '../../application/payload-hash';
import { SubmitWagerTransaction } from '../../application/submit-wager-transaction';
import { config } from '../../config';
import { ValidationError } from '../../domain/errors';
import { logger } from '../../observability/logger';
import { metrics } from '../../observability/metrics';
import type { QueueUrls } from './queues';

const envelopeSchema = z.object({
  messageId: z.string().min(1).max(200),
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.string().optional(),
  correlationId: z.string().optional(),
  data: z.looseObject({ idempotencyKey: z.string() }),
});

/**
 * Consumidor de `wager-transactions.fifo`. Reutiliza o mesmo caso de uso do HTTP.
 *
 *   resultado de negócio (inclusive REJECTED)  → ack (terminal, já persistido)
 *   erro permanente (payload, conflito, wallet) → DLQ explícita + ack
 *   erro transitório (banco fora, lock timeout) → sem ack; visibilidade com backoff; o redrive
 *                                                 do SQS leva à DLQ após maxReceiveCount
 *
 * O ack (DeleteMessage) só acontece depois que `execute` retorna, isto é, depois do commit.
 */
export class WagerTransactionsConsumer {
  private stopping = false;
  private loop?: Promise<void>;

  constructor(
    private readonly sqs: SQSClient,
    private readonly queues: QueueUrls,
    private readonly submit: SubmitWagerTransaction,
  ) {}

  start(): void {
    this.loop = this.run();
  }

  /**
   * SIGTERM: para de receber, conclui o que está em andamento e devolve o que não começou.
   * O long poll em curso NÃO é abortado: abortar no cliente não cancela no servidor, que ainda
   * pode entregar uma mensagem a uma requisição que ninguém mais escuta (ela só voltaria após o
   * visibility timeout, com um recebimento a menos antes da DLQ). Esperamos o poll terminar.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.race([this.loop, Bun.sleep(config.shutdownTimeoutMs)]);
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        const { Messages = [] } = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: this.queues.input,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: config.sqs.waitTimeSeconds,
            MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
          }),
        );
        // Grupos (wallets) em paralelo; dentro do grupo, em ordem.
        const groups = Map.groupBy(Messages, (m) => m.Attributes?.MessageGroupId ?? m.MessageId!);
        await Promise.all(
          [...groups.values()].map(async (group) => {
            // Falha transitória interrompe o grupo: as mensagens seguintes da wallet são devolvidas,
            // para não serem processadas na frente da que vai ser reentregue.
            let blocked = false;
            for (const message of group) {
              if (this.stopping || blocked) await this.release(message);
              else blocked = (await this.handle(message)) === 'retry';
            }
          }),
        );
      } catch (error) {
        if (this.stopping) return;
        logger.error({ err: error }, 'sqs receive failed');
        await Bun.sleep(1000);
      }
    }
  }

  private async handle(message: Message): Promise<'done' | 'retry'> {
    const body = message.Body ?? '';
    let envelope: z.infer<typeof envelopeSchema>;
    try {
      envelope = envelopeSchema.parse(JSON.parse(body));
    } catch {
      return this.deadLetter(message, 'malformed_message');
    }

    const { idempotencyKey, ...payload } = envelope.data;
    const log = logger.child({ messageId: envelope.messageId, correlationId: envelope.correlationId ?? envelope.messageId });
    try {
      await this.submit.execute({
        idempotencyKey,
        payload,
        correlationId: envelope.correlationId ?? envelope.messageId,
        inbox: { messageId: envelope.messageId, payloadHash: sha256(body) },
      });
      if (config.faultInjection === 'crash_before_ack') process.kill(process.pid, 'SIGKILL');
      await this.ack(message);
      return 'done';
    } catch (error) {
      if (error instanceof ValidationError) return this.deadLetter(message, 'invalid_payload', log);
      if (error instanceof IdempotencyConflictError) return this.deadLetter(message, 'idempotency_conflict', log);
      if (error instanceof MessageIdConflictError) return this.deadLetter(message, 'message_id_conflict', log);
      if (error instanceof WalletNotFoundError) return this.deadLetter(message, 'wallet_not_found', log);

      // Transitório: a mensagem volta para a fila depois de um backoff crescente.
      const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
      const delay = Math.min(2 ** receiveCount, config.sqs.maxRetryDelaySeconds);
      metrics.retries.inc({ source: 'sqs' });
      log.warn({ err: error, receiveCount, retryInSeconds: delay }, 'transient failure, message will be redelivered');
      await this.changeVisibility(message, delay);
      return 'retry';
    }
  }

  private async ack(message: Message): Promise<void> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.queues.input, ReceiptHandle: message.ReceiptHandle! }));
  }

  private async release(message: Message): Promise<void> {
    await this.changeVisibility(message, 0);
  }

  private async changeVisibility(message: Message, seconds: number): Promise<void> {
    await this.sqs
      .send(new ChangeMessageVisibilityCommand({ QueueUrl: this.queues.input, ReceiptHandle: message.ReceiptHandle!, VisibilityTimeout: seconds }))
      .catch((error) => logger.warn({ err: error }, 'could not change message visibility'));
  }

  private async deadLetter(message: Message, reason: string, log = logger): Promise<'done' | 'retry'> {
    try {
      await this.sendToDeadLetterQueue(message, reason);
      metrics.dlq.inc({ reason });
      log.error({ sqsMessageId: message.MessageId, reason }, 'message moved to DLQ');
      return 'done';
    } catch (error) {
      // DLQ fora do ar: a mensagem fica na fila e volta depois; o redrive do SQS é a rede final.
      log.error({ err: error, sqsMessageId: message.MessageId, reason }, 'could not move message to DLQ, leaving it for redelivery');
      return 'retry';
    }
  }

  private async sendToDeadLetterQueue(message: Message, reason: string): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.queues.dlq,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
        MessageDeduplicationId: message.MessageId!,
        MessageAttributes: { reason: { DataType: 'String', StringValue: reason } },
      }),
    );
    await this.ack(message);
  }
}
