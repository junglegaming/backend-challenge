import type { EntityManager } from '@mikro-orm/postgresql';
import { InboxMessage } from '../domain/inbox-message';

/** Tabela inbox_messages: mensagens da fila já processadas (detecta reentrega). */
export class MensagensInboxRepository {
  constructor(private readonly em: EntityManager) {}

  /**
   * Grava a mensagem; devolve false se ela já existia (duplicata).
   * Se outra transação estiver gravando a mesma mensagem, o Postgres espera
   * ela terminar antes de responder.
   */
  async tentarInserir(mensagem: InboxMessage): Promise<boolean> {
    const linhas = await this.em.execute(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       values (?, ?, ?, ?, ?) on conflict do nothing returning message_id`,
      [
        mensagem.consumerName,
        mensagem.messageId,
        mensagem.payloadHash,
        mensagem.receivedAt,
        mensagem.processedAt ?? null,
      ],
    );
    return linhas.length === 1;
  }
}
