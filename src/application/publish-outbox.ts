import { config } from '../config';
import { OutboxMessage } from '../domain/messaging';
import { logger } from '../observability/logger';
import { metrics } from '../observability/metrics';
import { EventPublisher, UnitOfWork } from './ports';

/**
 * Publica eventos pendentes. Seguro com vários publishers: cada um trava um lote diferente
 * (FOR UPDATE SKIP LOCKED) e o lock dura até o commit que marca `published_at`.
 *
 * Processo morto no meio → a transação aborta, os locks caem e outra instância publica.
 * Publicou e morreu antes do commit → o evento sai de novo: at-least-once, o consumidor
 * deduplica por eventId (também enviado como MessageDeduplicationId).
 */
export class PublishOutbox {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: EventPublisher,
  ) {}

  /** Devolve quantas mensagens o lote tinha (0 = nada a fazer). */
  runOnce(): Promise<number> {
    return this.uow.run(async (store) => {
      const now = new Date();
      const batch = await store.claimDueOutbox(config.outbox.batchSize, now);
      // Falhou um evento de uma wallet: os seguintes dela esperam, para não inverter a ordem.
      const blockedAggregates = new Set<string>();
      for (const chunk of chunksWithDistinctAggregates(batch)) {
        const sendable = chunk.filter((message) => !blockedAggregates.has(message.aggregateId));
        if (sendable.length === 0) continue;
        let failed: Set<string>;
        try {
          failed = await this.publisher.publish(sendable);
        } catch (error) {
          failed = new Set(sendable.map((message) => message.id));
          logger.warn({ events: sendable.length, err: error }, 'outbox publish failed');
        }
        for (const message of sendable) {
          if (failed.has(message.id)) {
            blockedAggregates.add(message.aggregateId);
            message.scheduleRetry(now);
            metrics.retries.inc({ source: 'outbox' });
          } else {
            message.markPublished(new Date());
            metrics.outboxPublished.inc({ event_type: message.eventType });
          }
          store.saveOutbox(message);
        }
      }
      return batch.length;
    });
  }
}

const SQS_BATCH_LIMIT = 10;

/**
 * Divide o lote em envios de até 10 mensagens, com no máximo UMA por wallet em cada envio. Assim
 * dois eventos da mesma wallet nunca vão na mesma chamada: o segundo só é enviado depois de sabermos
 * o resultado do primeiro, e a ordem por wallet se mantém mesmo com falha parcial do lote.
 */
export function chunksWithDistinctAggregates(batch: OutboxMessage[]): OutboxMessage[][] {
  const chunks: OutboxMessage[][] = [];
  let remaining = batch;
  while (remaining.length > 0) {
    const chunk: OutboxMessage[] = [];
    const deferred: OutboxMessage[] = [];
    const seen = new Set<string>();
    for (const message of remaining) {
      if (chunk.length < SQS_BATCH_LIMIT && !seen.has(message.aggregateId)) chunk.push(message);
      else deferred.push(message);
      seen.add(message.aggregateId);
    }
    chunks.push(chunk);
    remaining = deferred;
  }
  return chunks;
}
