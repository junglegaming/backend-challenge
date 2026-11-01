import { Injectable } from "@nestjs/common";
import { TransactionContext } from "../../shared/application/unit-of-work";
import { managerFor } from "../../shared/infrastructure/unit-of-work";
import { InboxClaim, InboxStore, OutboxWriter } from "../../wagering/application/ports/messaging";
import { InboxMessage } from "../domain/inbox-message";
import { OutboxMessage } from "../domain/outbox-message";
import { InboxRecord, OutboxRecord } from "./records";

function outboxFromRecord(record: OutboxRecord): OutboxMessage {
  return OutboxMessage.rehydrate({ ...record, publishedAt: record.publishedAt ?? undefined });
}

@Injectable()
export class SqlInboxStore extends InboxStore {
  override async claim(tx: TransactionContext, message: InboxMessage): Promise<InboxClaim> {
    const em = managerFor(tx);
    const rows = await em.execute<{ message_id: string }[]>(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
       VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING message_id`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt],
    );
    if (rows.length) return { inserted: true };
    const row = await em.findOneOrFail(
      InboxRecord,
      { consumerName: message.consumerName, messageId: message.messageId },
      { refresh: true },
    );
    return {
      inserted: false,
      existing: InboxMessage.rehydrate({ ...row, processedAt: row.processedAt ?? undefined }),
    };
  }
  override async markProcessed(tx: TransactionContext, message: InboxMessage): Promise<void> {
    if (!message.isProcessed()) throw new Error("Inbox must be processed before persistence");
    await managerFor(tx).nativeUpdate(
      InboxRecord,
      { consumerName: message.consumerName, messageId: message.messageId },
      { processedAt: message.processedAt },
    );
  }
}

@Injectable()
export class SqlOutboxRepository extends OutboxWriter {
  override async append(tx: TransactionContext, message: OutboxMessage): Promise<void> {
    await managerFor(tx).insert(OutboxRecord, {
      id: message.id,
      aggregateId: message.aggregateId,
      eventType: message.eventType,
      payload: message.payload,
      occurredAt: message.occurredAt,
      attempts: message.attempts,
      nextAttemptAt: message.nextAttemptAt,
      publishedAt: message.publishedAt,
    });
  }
  async claimDue(tx: TransactionContext, now: Date, limit: number): Promise<OutboxMessage[]> {
    const em = managerFor(tx);
    const rows = await em.execute<Record<string, unknown>[]>(
      `SELECT * FROM outbox_messages WHERE published_at IS NULL AND next_attempt_at <= ?
       ORDER BY next_attempt_at, id LIMIT ? FOR UPDATE SKIP LOCKED`,
      [now, limit],
    );
    return rows.map((row) => outboxFromRecord(em.map(OutboxRecord, row)));
  }
  async saveRetries(tx: TransactionContext, messages: OutboxMessage[]): Promise<void> {
    if (!messages.length) return;
    await managerFor(tx).execute(
      `UPDATE outbox_messages AS target
       SET attempts = source.attempts, next_attempt_at = source.next_attempt_at
       FROM (VALUES ${messages.map(() => "(?::uuid, ?::integer, ?::timestamptz)").join(",")})
         AS source(id, attempts, next_attempt_at)
       WHERE target.id = source.id`,
      messages.flatMap((message) => [message.id, message.attempts, message.nextAttemptAt]),
    );
  }
  async markPublished(tx: TransactionContext, ids: string[], at: Date): Promise<void> {
    if (!ids.length) return;
    await managerFor(tx).execute(
      `UPDATE outbox_messages SET published_at = ?
       WHERE id IN (${ids.map(() => "?").join(",")}) AND published_at IS NULL`,
      [at, ...ids],
    );
  }
}
