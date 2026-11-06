import { EntitySchema } from '@mikro-orm/core';
import { MoneyAmountType } from '../money-amount.type';
import {
  InboxMessageRecord,
  OutboxMessageRecord,
  WageringTransactionRecord,
  WalletLedgerEntryRecord,
  WalletRecord,
} from './records';

const money = () => ({ type: MoneyAmountType, columnType: 'numeric(20,2)' }) as const;
const currency = () => ({ type: 'string', columnType: 'char(3)' }) as const;
const timestamp = () => ({ type: 'Date', columnType: 'timestamptz' }) as const;

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid' },
    currency: currency(),
    balance: money(),
    version: { type: 'number', columnType: 'integer', default: 1 },
    createdAt: timestamp(),
    updatedAt: timestamp(),
  },
});

export const WageringTransactionSchema = new EntitySchema<WageringTransactionRecord>({
  class: WageringTransactionRecord,
  tableName: 'wagering_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string', columnType: 'text' },
    externalTransactionId: { type: 'string', columnType: 'text' },
    idempotencyKey: { type: 'string', columnType: 'text' },
    payloadHash: { type: 'string', columnType: 'text' },
    walletId: { type: 'uuid' },
    playerId: { type: 'uuid' },
    roundId: { type: 'string', columnType: 'text' },
    gameId: { type: 'string', columnType: 'text' },
    kind: { type: 'string', columnType: 'text' },
    amount: money(),
    currency: currency(),
    referenceExternalTransactionId: { type: 'string', columnType: 'text', nullable: true },
    referenceTransactionId: { type: 'uuid', nullable: true },
    status: { type: 'string', columnType: 'text' },
    failureCode: { type: 'string', columnType: 'text', nullable: true },
    balanceSnapshot: { ...money(), nullable: true },
    createdAt: timestamp(),
    processedAt: { ...timestamp(), nullable: true },
  },
});

export const WalletLedgerEntrySchema = new EntitySchema<WalletLedgerEntryRecord>({
  class: WalletLedgerEntryRecord,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    seq: { type: 'string', columnType: 'bigint', persist: false },
    walletId: { type: 'uuid' },
    transactionId: { type: 'uuid' },
    direction: { type: 'string', columnType: 'text' },
    amount: money(),
    currency: currency(),
    balanceBefore: money(),
    balanceAfter: money(),
    createdAt: timestamp(),
  },
});

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', columnType: 'text', primary: true },
    messageId: { type: 'string', columnType: 'text', primary: true },
    payloadHash: { type: 'string', columnType: 'text' },
    receivedAt: timestamp(),
    processedAt: { ...timestamp(), nullable: true },
  },
});

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'uuid' },
    eventType: { type: 'string', columnType: 'text' },
    payload: { type: 'json', columnType: 'jsonb' },
    occurredAt: timestamp(),
    attempts: { type: 'number', columnType: 'integer', default: 0 },
    nextAttemptAt: timestamp(),
    publishedAt: { ...timestamp(), nullable: true },
  },
});

export const schemas = [
  WalletSchema,
  WageringTransactionSchema,
  WalletLedgerEntrySchema,
  InboxMessageSchema,
  OutboxMessageSchema,
];
