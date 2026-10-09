import { InboxMessage } from "../../../modules/messaging/domain/inbox-message";
import { OutboxMessage } from "../../../modules/messaging/domain/outbox-message";
import type { FailureCode } from "../../../modules/wagering/domain/failure-code";
import { WagerTransaction } from "../../../modules/wagering/domain/wager-transaction";
import type {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../modules/wagering/domain/wager-transaction-kind";
import type { LedgerDirection } from "../../../modules/wallet/domain/ledger-direction";
import { Wallet } from "../../../modules/wallet/domain/wallet";
import { WalletLedgerEntry } from "../../../modules/wallet/domain/wallet-ledger-entry";
import { Money } from "../../../shared/domain/money";
import type {
  InboxMessageRecord,
  LedgerEntryRecord,
  WagerTransactionRecord,
  WalletRecord,
} from "../entities";

/** NUMERIC(20,2) arrives as an exact decimal string; it goes straight into Money (never through `number`). */
const money = (amount: string, currency: string) => Money.fromSigned({ amount, currency });
const opt = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v);
/** Raw SQL returns timestamptz as strings (MikroORM keeps them raw); entity queries return Date. */
export const toDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));
const optDate = (v: Date | string | null | undefined) =>
  v === null || v === undefined ? undefined : toDate(v);

export const walletMapper = {
  toDomain: (r: WalletRecord): Wallet =>
    Wallet.rehydrate({
      id: r.id,
      playerId: r.playerId,
      currency: r.currency,
      balance: money(r.balanceAmount, r.currency),
      version: r.version,
      createdAt: toDate(r.createdAt),
      updatedAt: toDate(r.updatedAt),
    }),
  toRecord: (w: Wallet) => ({
    id: w.id,
    playerId: w.playerId,
    currency: w.currency,
    balanceAmount: w.balance.toString(),
    version: w.version,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  }),
};

export const wagerMapper = {
  toDomain: (r: WagerTransactionRecord): WagerTransaction =>
    WagerTransaction.rehydrate({
      id: r.id,
      providerId: r.providerId,
      externalTransactionId: r.externalTransactionId,
      idempotencyKey: r.idempotencyKey,
      payloadHash: r.payloadHash,
      walletId: r.walletId,
      playerId: r.playerId,
      roundId: r.roundId,
      gameId: r.gameId,
      kind: r.kind as WagerTransactionKind,
      money: money(r.amount, r.currency),
      referenceExternalTransactionId: opt(r.referenceExternalTransactionId),
      createdAt: toDate(r.createdAt),
      status: r.status as WagerTransactionStatus,
      referenceTransactionId: opt(r.referenceTransactionId),
      failureCode: opt(r.failureCode) as FailureCode | undefined,
      processedAt: optDate(r.processedAt),
      resultBalance: r.resultBalanceAmount ? money(r.resultBalanceAmount, r.currency) : undefined,
      referenceAttempts: r.referenceAttempts,
      nextReferenceRetryAt: optDate(r.nextReferenceRetryAt),
    }),
  /** Columns that may change during the lifecycle (the DB trigger freezes everything else). */
  lifecycle: (tx: WagerTransaction) => ({
    status: tx.status,
    referenceTransactionId: tx.referenceTransactionId ?? null,
    failureCode: tx.failureCode ?? null,
    processedAt: tx.processedAt ?? null,
    resultBalanceAmount: tx.resultBalance?.toString() ?? null,
    referenceAttempts: tx.referenceAttempts,
    nextReferenceRetryAt: tx.nextReferenceRetryAt ?? null,
  }),
  toRecord: (tx: WagerTransaction) => ({
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    payloadHash: tx.payloadHash,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    amount: tx.money.toString(),
    currency: tx.money.currency,
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    createdAt: tx.createdAt,
    ...wagerMapper.lifecycle(tx),
  }),
};

export const ledgerMapper = {
  toDomain: (r: LedgerEntryRecord): WalletLedgerEntry =>
    WalletLedgerEntry.rehydrate({
      id: r.id,
      walletId: r.walletId,
      transactionId: r.transactionId,
      direction: r.direction as LedgerDirection,
      money: money(r.amount, r.currency),
      balanceBefore: money(r.balanceBefore, r.currency),
      balanceAfter: money(r.balanceAfter, r.currency),
      walletVersion: r.walletVersion,
      createdAt: toDate(r.createdAt),
    }),
  toRecord: (e: WalletLedgerEntry) => ({
    id: e.id,
    walletId: e.walletId,
    transactionId: e.transactionId,
    direction: e.direction,
    amount: e.money.toString(),
    currency: e.money.currency,
    balanceBefore: e.balanceBefore.toString(),
    balanceAfter: e.balanceAfter.toString(),
    walletVersion: e.walletVersion,
    createdAt: e.createdAt,
  }),
};

export const inboxMapper = {
  toDomain: (r: InboxMessageRecord): InboxMessage =>
    InboxMessage.rehydrate({
      consumerName: r.consumerName,
      messageId: r.messageId,
      payloadHash: r.payloadHash,
      receivedAt: toDate(r.receivedAt),
      processedAt: optDate(r.processedAt),
    }),
};

export interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  event_version: number;
  payload: Record<string, unknown> | string;
  occurred_at: Date | string;
  attempts: number;
  next_attempt_at: Date | string;
  published_at: Date | string | null;
  last_error: string | null;
}

export const outboxMapper = {
  fromRow: (r: OutboxRow): OutboxMessage =>
    OutboxMessage.rehydrate({
      id: r.id,
      aggregateId: r.aggregate_id,
      eventType: r.event_type,
      eventVersion: r.event_version,
      payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload,
      occurredAt: toDate(r.occurred_at),
      attempts: r.attempts,
      nextAttemptAt: toDate(r.next_attempt_at),
      publishedAt: optDate(r.published_at),
      lastError: opt(r.last_error),
    }),
  toRecord: (m: OutboxMessage) => ({
    id: m.id,
    aggregateId: m.aggregateId,
    eventType: m.eventType,
    eventVersion: m.eventVersion,
    payload: m.payload as Record<string, unknown>,
    occurredAt: m.occurredAt,
    attempts: m.attempts,
    nextAttemptAt: m.nextAttemptAt ?? m.occurredAt,
    lockedUntil: null,
    lockedBy: null,
    publishedAt: m.publishedAt ?? null,
    lastError: m.lastError ?? null,
  }),
};
