import { config } from '../config';
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
      for (const message of batch) {
        if (blockedAggregates.has(message.aggregateId)) continue;
        try {
          await this.publisher.publish(message);
          message.markPublished(new Date());
          metrics.outboxPublished.inc({ event_type: message.eventType });
        } catch (error) {
          blockedAggregates.add(message.aggregateId);
          message.scheduleRetry(now);
          metrics.retries.inc({ source: 'outbox' });
          logger.warn({ eventId: message.id, eventType: message.eventType, attempts: message.attempts, err: error }, 'outbox publish failed');
        }
        store.saveOutbox(message);
      }
      return batch.length;
    });
  }
}
