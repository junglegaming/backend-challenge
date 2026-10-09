import { defineEntity, p } from "@mikro-orm/postgresql";

/*
 * Persistence records (MikroORM `defineEntity`, no decorators). They mirror the tables 1:1 and are
 * mapped to/from domain aggregates by explicit mappers, so the domain never depends on the ORM.
 *
 * Money columns are NUMERIC(20,2) mapped with `decimal("string")`: the driver returns exact decimal strings
 * and no value ever passes through a JS `number`.
 */

export const WalletRecordSchema = defineEntity({
  name: "WalletRecord",
  tableName: "wallets",
  properties: {
    id: p.uuid().primary(),
    playerId: p.uuid(),
    currency: p.string().length(3),
    balanceAmount: p.decimal("string").precision(20).scale(2),
    version: p.integer(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
});
export class WalletRecord extends WalletRecordSchema.class {}
WalletRecordSchema.setClass(WalletRecord);

export const WagerTransactionRecordSchema = defineEntity({
  name: "WagerTransactionRecord",
  tableName: "wager_transactions",
  properties: {
    id: p.uuid().primary(),
    providerId: p.string(),
    externalTransactionId: p.string(),
    idempotencyKey: p.string(),
    payloadHash: p.string(),
    walletId: p.uuid(),
    playerId: p.uuid(),
    roundId: p.string(),
    gameId: p.string(),
    kind: p.string(),
    amount: p.decimal("string").precision(20).scale(2),
    currency: p.string().length(3),
    referenceExternalTransactionId: p.string().nullable(),
    referenceTransactionId: p.uuid().nullable(),
    status: p.string(),
    failureCode: p.string().nullable(),
    resultBalanceAmount: p.decimal("string").precision(20).scale(2).nullable(),
    referenceAttempts: p.integer(),
    nextReferenceRetryAt: p.datetime().nullable(),
    createdAt: p.datetime(),
    processedAt: p.datetime().nullable(),
  },
});
export class WagerTransactionRecord extends WagerTransactionRecordSchema.class {}
WagerTransactionRecordSchema.setClass(WagerTransactionRecord);

export const LedgerEntryRecordSchema = defineEntity({
  name: "LedgerEntryRecord",
  tableName: "wallet_ledger_entries",
  properties: {
    id: p.uuid().primary(),
    walletId: p.uuid(),
    transactionId: p.uuid(),
    direction: p.string(),
    amount: p.decimal("string").precision(20).scale(2),
    currency: p.string().length(3),
    balanceBefore: p.decimal("string").precision(20).scale(2),
    balanceAfter: p.decimal("string").precision(20).scale(2),
    walletVersion: p.integer(),
    createdAt: p.datetime(),
  },
});
export class LedgerEntryRecord extends LedgerEntryRecordSchema.class {}
LedgerEntryRecordSchema.setClass(LedgerEntryRecord);

export const InboxMessageRecordSchema = defineEntity({
  name: "InboxMessageRecord",
  tableName: "inbox_messages",
  properties: {
    consumerName: p.string().primary(),
    messageId: p.string().primary(),
    payloadHash: p.string(),
    receivedAt: p.datetime(),
    processedAt: p.datetime().nullable(),
  },
});
export class InboxMessageRecord extends InboxMessageRecordSchema.class {}
InboxMessageRecordSchema.setClass(InboxMessageRecord);

export const OutboxMessageRecordSchema = defineEntity({
  name: "OutboxMessageRecord",
  tableName: "outbox_messages",
  properties: {
    id: p.uuid().primary(),
    seq: p.bigint("string").persist(false),
    aggregateId: p.uuid(),
    eventType: p.string(),
    eventVersion: p.integer(),
    payload: p.json<Record<string, unknown>>(),
    occurredAt: p.datetime(),
    attempts: p.integer(),
    nextAttemptAt: p.datetime(),
    lockedUntil: p.datetime().nullable(),
    lockedBy: p.string().nullable(),
    publishedAt: p.datetime().nullable(),
    lastError: p.string().nullable(),
  },
});
export class OutboxMessageRecord extends OutboxMessageRecordSchema.class {}
OutboxMessageRecordSchema.setClass(OutboxMessageRecord);

export const LedgerPostingRecordSchema = defineEntity({
  name: "LedgerPostingRecord",
  tableName: "ledger_postings",
  properties: {
    id: p.uuid().primary(),
    transactionId: p.uuid(),
    account: p.string(),
    direction: p.string(),
    amount: p.decimal("string").precision(20).scale(2),
    currency: p.string().length(3),
    createdAt: p.datetime(),
  },
});
export class LedgerPostingRecord extends LedgerPostingRecordSchema.class {}
LedgerPostingRecordSchema.setClass(LedgerPostingRecord);

export const SubmissionFailureRecordSchema = defineEntity({
  name: "SubmissionFailureRecord",
  tableName: "wager_submission_failures",
  properties: {
    id: p.uuid().primary(),
    channel: p.string(),
    reasonCode: p.string(),
    category: p.string(),
    retryable: p.boolean(),
    providerId: p.string().nullable(),
    externalTransactionId: p.string().nullable(),
    idempotencyKey: p.string().nullable(),
    walletId: p.uuid().nullable(),
    messageId: p.string().nullable(),
    transactionId: p.uuid().nullable(),
    payloadHash: p.string().nullable(),
    detail: p.string().nullable(),
    receiveCount: p.integer().nullable(),
    correlationId: p.string().nullable(),
    occurredAt: p.datetime(),
  },
});
export class SubmissionFailureRecord extends SubmissionFailureRecordSchema.class {}
SubmissionFailureRecordSchema.setClass(SubmissionFailureRecord);

export const ALL_ENTITIES = [
  WalletRecordSchema,
  WagerTransactionRecordSchema,
  LedgerEntryRecordSchema,
  InboxMessageRecordSchema,
  OutboxMessageRecordSchema,
  LedgerPostingRecordSchema,
  SubmissionFailureRecordSchema,
];
