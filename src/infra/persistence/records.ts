import { defineEntity, InferEntity, p } from '@mikro-orm/core';

/**
 * Mapeamento de persistência, separado do domínio (que não conhece o ORM).
 * O schema real é o das migrations; aqui só o que o Unit of Work precisa ler e escrever.
 * Valores monetários trafegam como string decimal — nunca como number.
 */
export const WalletRecord = defineEntity({
  name: 'WalletRecord',
  tableName: 'wallets',
  properties: {
    id: p.uuid().primary(),
    playerId: p.uuid(),
    currency: p.string(),
    balance: p.decimal(),
    version: p.integer(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
});
export type WalletRecord = InferEntity<typeof WalletRecord>;

export const WagerTransactionRecord = defineEntity({
  name: 'WagerTransactionRecord',
  tableName: 'wager_transactions',
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
    amount: p.decimal(),
    currency: p.string(),
    referenceExternalTransactionId: p.string().nullable(),
    referenceTransactionId: p.uuid().nullable(),
    status: p.string(),
    failureCode: p.string().nullable(),
    resultingBalance: p.decimal().nullable(),
    attempts: p.integer(),
    nextAttemptAt: p.datetime().nullable(),
    createdAt: p.datetime(),
    processedAt: p.datetime().nullable(),
  },
});
export type WagerTransactionRecord = InferEntity<typeof WagerTransactionRecord>;

export const LedgerEntryRecord = defineEntity({
  name: 'LedgerEntryRecord',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: p.uuid().primary(),
    walletId: p.uuid(),
    transactionId: p.uuid(),
    direction: p.string(),
    amount: p.decimal(),
    currency: p.string(),
    balanceBefore: p.decimal(),
    balanceAfter: p.decimal(),
    createdAt: p.datetime(),
  },
});

export const OutboxRecord = defineEntity({
  name: 'OutboxRecord',
  tableName: 'outbox_messages',
  properties: {
    id: p.uuid().primary(),
    aggregateId: p.string(),
    eventType: p.string(),
    payload: p.json<Record<string, unknown>>(),
    occurredAt: p.datetime(),
    attempts: p.integer(),
    nextAttemptAt: p.datetime().nullable(),
    publishedAt: p.datetime().nullable(),
  },
});
export type OutboxRecord = InferEntity<typeof OutboxRecord>;

export const records = [WalletRecord, WagerTransactionRecord, LedgerEntryRecord, OutboxRecord];
