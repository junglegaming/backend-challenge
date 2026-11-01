import { EntitySchema } from "@mikro-orm/core";

export class InboxRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt?: Date;
}

export const InboxSchema = new EntitySchema<InboxRecord>({
  class: InboxRecord,
  tableName: "inbox_messages",
  properties: {
    consumerName: { type: "string", primary: true },
    messageId: { type: "string", primary: true },
    payloadHash: { type: "string", columnType: "char(64)" },
    receivedAt: { type: "Date", columnType: "timestamptz" },
    processedAt: { type: "Date", columnType: "timestamptz", nullable: true },
  },
});

export class OutboxRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Readonly<Record<string, unknown>>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date;
  publishedAt?: Date;
}

export const OutboxSchema = new EntitySchema<OutboxRecord>({
  class: OutboxRecord,
  tableName: "outbox_messages",
  properties: {
    id: { type: "string", columnType: "uuid", primary: true },
    aggregateId: { type: "string" },
    eventType: { type: "string" },
    payload: { type: "json", columnType: "jsonb" },
    occurredAt: { type: "Date", columnType: "timestamptz" },
    attempts: { type: "integer" },
    nextAttemptAt: { type: "Date", columnType: "timestamptz" },
    publishedAt: { type: "Date", columnType: "timestamptz", nullable: true },
  },
});
