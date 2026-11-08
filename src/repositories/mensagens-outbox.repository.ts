import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { MensagemOutboxEntity } from '../database/entidades';
import { OutboxMessage } from '../domain/outbox-message';

/** Tabela outbox_messages: eventos gravados junto com a mudança, publicados depois. */
export class MensagensOutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async adicionar(mensagens: OutboxMessage[]): Promise<void> {
    await this.em.insertMany(
      MensagemOutboxEntity,
      mensagens.map((m) => ({
        id: m.id,
        aggregateId: m.aggregateId,
        eventType: m.eventType,
        payload: { ...m.payload },
        occurredAt: m.occurredAt,
        attempts: m.attempts,
        nextAttemptAt: m.nextAttemptAt ?? m.occurredAt,
        publishedAt: null,
      })),
    );
  }

  /**
   * Pega e trava eventos prontos para publicar (FOR UPDATE SKIP LOCKED):
   * duas instâncias rodando juntas pegam eventos diferentes. Mudanças feitas
   * nas linhas devolvidas são salvas no commit (Unit of Work do MikroORM).
   */
  async travarPendentes(limite: number): Promise<MensagemOutboxEntity[]> {
    return this.em.find(
      MensagemOutboxEntity,
      { publishedAt: null, nextAttemptAt: { $lte: new Date() } },
      { orderBy: { occurredAt: 'asc' }, limit: limite, lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE },
    );
  }

  /** Há quantos segundos o evento pendente mais antigo está esperando. */
  async atrasoEmSegundos(): Promise<number> {
    const [linha] = await this.em.execute(
      `select extract(epoch from now() - min(occurred_at))::float as lag
         from outbox_messages where published_at is null`,
    );
    return linha?.lag ?? 0;
  }
}
