import type { EntityManager } from "@mikro-orm/postgresql";
import type { InboxMessage } from "../../domain/messaging/inbox-message";

/** Persistent deduplication of consumed messages. */
export class InboxRepository {
  constructor(private readonly em: EntityManager) {}

  /**
   * Inserts the inbox row. Returns false when (consumer, messageId) already
   * exists, i.e. the message was already processed and committed.
   *
   * ON CONFLICT DO NOTHING waits for a concurrent transaction holding the same
   * key: if it commits we get "false", if it rolls back we insert. This is what
   * makes two simultaneous deliveries of one message safe.
   */
  async tryInsert(message: InboxMessage): Promise<boolean> {
    const rows = await this.em.execute<{ message_id: string }[]>(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING message_id`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt, message.processedAt ?? null],
    );
    return rows.length === 1;
  }
}

