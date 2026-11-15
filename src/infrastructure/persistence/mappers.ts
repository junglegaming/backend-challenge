import type { FailureCode } from '../../domain/failure-code';
import { InboxMessage } from '../../domain/inbox-message';
import { Money } from '../../domain/money';
import { OutboxMessage } from '../../domain/outbox-message';
import { WagerTransaction, type WagerTransactionKind, type WagerTransactionStatus } from '../../domain/wager-transaction';
import { Wallet } from '../../domain/wallet';
import { type LedgerDirection, WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import type {
  InboxRecord,
  LedgerEntryRecord,
  OutboxRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './entities/records';

/** Data Mappers: the only code that knows both the domain model and the table layout. */

const toDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));
const optionalDate = (value: Date | string | null | undefined): Date | undefined =>
  value === null || value === undefined ? undefined : toDate(value);
const optional = <T>(value: T | null | undefined): T | undefined => value ?? undefined;

export const WalletMapper = {
  toDomain(r: WalletRecord): Wallet {
    return Wallet.rehydrate({
      id: r.id,
      playerId: r.playerId,
      currency: r.currency.trim(),
      balance: Money.fromPersisted(String(r.balance), r.currency),
      version: Number(r.version),
      createdAt: toDate(r.createdAt),
      updatedAt: toDate(r.updatedAt),
    });
  },
  toRecord(w: Wallet): WalletRecord {
    return {
      id: w.id,
      playerId: w.playerId,
      currency: w.currency,
      balance: w.balance.formatAmount(),
      version: w.version,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
    };
  },
};

export const LedgerEntryMapper = {
  toDomain(r: LedgerEntryRecord): WalletLedgerEntry {
    const currency = r.currency.trim();
    return WalletLedgerEntry.rehydrate({
      id: r.id,
      walletId: r.walletId,
      transactionId: r.transactionId,
      direction: r.direction as LedgerDirection,
      money: Money.fromPersisted(String(r.amount), currency),
      balanceBefore: Money.fromPersisted(String(r.balanceBefore), currency),
      balanceAfter: Money.fromPersisted(String(r.balanceAfter), currency),
      walletVersion: Number(r.walletVersion),
      createdAt: toDate(r.createdAt),
    });
  },
  toRecord(e: WalletLedgerEntry): LedgerEntryRecord {
    return {
      id: e.id,
      walletId: e.walletId,
      transactionId: e.transactionId,
      direction: e.direction,
      amount: e.money.formatAmount(),
      currency: e.money.currency,
      balanceBefore: e.balanceBefore.formatAmount(),
      balanceAfter: e.balanceAfter.formatAmount(),
      walletVersion: e.walletVersion,
      createdAt: e.createdAt,
    };
  },
};

export const WagerTransactionMapper = {
  toDomain(r: WagerTransactionRecord): WagerTransaction {
    const currency = r.currency.trim();
    return WagerTransaction.rehydrate({
      id: r.id,
      providerId: r.providerId,
      externalTransactionId: r.externalTransactionId,
      idempotencyKey: r.idempotencyKey,
      payloadHash: r.payloadHash.trim(),
      walletId: r.walletId,
      playerId: r.playerId,
      roundId: r.roundId,
      gameId: r.gameId,
      kind: r.kind as WagerTransactionKind,
      money: Money.fromPersisted(String(r.amount), currency),
      referenceExternalTransactionId: optional(r.referenceExternalTransactionId),
      createdAt: toDate(r.createdAt),
      status: r.status as WagerTransactionStatus,
      referenceTransactionId: optional(r.referenceTransactionId),
      failureCode: optional(r.failureCode) as FailureCode | undefined,
      processedAt: optionalDate(r.processedAt),
      resultBalance:
        r.resultBalance === null || r.resultBalance === undefined
          ? undefined
          : Money.fromPersisted(String(r.resultBalance), currency),
      referenceAttempts: Number(r.referenceAttempts),
      nextReferenceCheckAt: optionalDate(r.nextReferenceCheckAt),
      updatedAt: toDate(r.updatedAt),
    });
  },
  toRecord(tx: WagerTransaction): WagerTransactionRecord {
    return {
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
      amount: tx.money.formatAmount(),
      currency: tx.money.currency,
      referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
      referenceTransactionId: tx.referenceTransactionId ?? null,
      status: tx.status,
      failureCode: tx.failureCode ?? null,
      resultBalance: tx.resultBalance?.formatAmount() ?? null,
      referenceAttempts: tx.referenceAttempts,
      nextReferenceCheckAt: tx.nextReferenceCheckAt ?? null,
      createdAt: tx.createdAt,
      updatedAt: tx.updatedAt,
      processedAt: tx.processedAt ?? null,
    };
  },
};

export const InboxMapper = {
  toDomain(r: InboxRecord): InboxMessage {
    return InboxMessage.rehydrate({
      consumerName: r.consumerName,
      messageId: r.messageId,
      payloadHash: r.payloadHash.trim(),
      receivedAt: toDate(r.receivedAt),
      processedAt: optionalDate(r.processedAt),
    });
  },
};

/** Raw rows (snake_case) returned by the outbox claim query. */
export interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown> | string;
  occurred_at: Date | string;
  attempts: number;
  next_attempt_at: Date | string;
  published_at: Date | string | null;
  sequence?: string;
}

export const OutboxMapper = {
  fromRow(r: OutboxRow): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: r.id,
      aggregateId: r.aggregate_id,
      eventType: r.event_type,
      payload: typeof r.payload === 'string' ? (JSON.parse(r.payload) as Record<string, unknown>) : r.payload,
      occurredAt: toDate(r.occurred_at),
      attempts: Number(r.attempts),
      nextAttemptAt: toDate(r.next_attempt_at),
      publishedAt: optionalDate(r.published_at),
    });
  },
  toRecord(m: OutboxMessage): OutboxRecord {
    return {
      id: m.id,
      aggregateId: m.aggregateId,
      eventType: m.eventType,
      // MikroORM normalises insert params in place; the domain payload is frozen
      payload: structuredClone(m.payload) as Record<string, unknown>,
      occurredAt: m.occurredAt,
      attempts: m.attempts,
      nextAttemptAt: m.nextAttemptAt ?? m.occurredAt,
      publishedAt: m.publishedAt ?? null,
      lockedBy: null,
      lockedUntil: null,
      lastError: null,
    };
  },
};
