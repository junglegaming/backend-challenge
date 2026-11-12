import { LockMode } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import { Money } from "../../domain/money/money";
import type { FailureCode } from "../../domain/shared/failure-code";
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from "../../domain/wagering/wager-transaction";
import { WagerTransactionRow } from "../entities";

/** A PENDING_REFERENCE transaction whose next attempt is due. */
export interface DuePendingReference {
  id: string;
  walletId: string;
}

/** Reads and writes WagerTransaction. */
export class WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(tx: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionRow, {
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
      correlationId: tx.correlationId,
      createdAt: tx.createdAt,
      ...stateColumns(tx),
    });
  }

  /** Persists the mutable lifecycle columns (status, result, scheduling). */
  async updateState(tx: WagerTransaction): Promise<void> {
    await this.em.nativeUpdate(WagerTransactionRow, { id: tx.id }, stateColumns(tx));
  }

  async findById(id: string): Promise<WagerTransaction | null> {
    return this.findOne({ id });
  }

  async findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | null> {
    return this.findOne({ providerId, idempotencyKey });
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
    return this.findOne({ providerId, externalTransactionId });
  }

  /**
   * Locks a pending transaction for the reference worker. SKIP LOCKED lets
   * several workers run at once without ever picking the same row.
   */
  async lockPendingReference(id: string, now: Date): Promise<WagerTransaction | null> {
    const row = await this.em.findOne(
      WagerTransactionRow,
      { id, status: "PENDING_REFERENCE", nextReferenceAttemptAt: { $lte: now } },
      { lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE, disableIdentityMap: true },
    );
    return row ? toDomain(row) : null;
  }

  async findDuePendingReferences(now: Date, limit: number): Promise<DuePendingReference[]> {
    const rows = await this.em.find(
      WagerTransactionRow,
      { status: "PENDING_REFERENCE", nextReferenceAttemptAt: { $lte: now } },
      { fields: ["id", "walletId"], orderBy: { nextReferenceAttemptAt: "asc" }, limit, disableIdentityMap: true },
    );
    return rows.map((row) => ({ id: row.id, walletId: row.walletId }));
  }

  /** True if a PROCESSED REFUND/ROLLBACK already reverses `transactionId`. */
  async isReversed(transactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRow, {
      referenceTransactionId: transactionId,
      kind: { $in: ["REFUND", "ROLLBACK"] },
      status: "PROCESSED",
    });
    return count > 0;
  }

  private async findOne(where: Partial<WagerTransactionRow>): Promise<WagerTransaction | null> {
    const row = await this.em.findOne(WagerTransactionRow, where, { disableIdentityMap: true });
    return row ? toDomain(row) : null;
  }
}

function stateColumns(tx: WagerTransaction) {
  return {
    status: tx.status,
    referenceTransactionId: tx.referenceTransactionId ?? null,
    failureCode: tx.failureCode ?? null,
    balanceAfter: tx.balanceAfter?.toString() ?? null,
    referenceAttempts: tx.referenceAttempts,
    nextReferenceAttemptAt: tx.nextReferenceAttemptAt ?? null,
    processedAt: tx.processedAt ?? null,
    updatedAt: new Date(),
  };
}

function toDomain(row: WagerTransactionRow): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.providerId,
    externalTransactionId: row.externalTransactionId,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    walletId: row.walletId,
    playerId: row.playerId,
    roundId: row.roundId,
    gameId: row.gameId,
    kind: row.kind as WagerTransactionKind,
    money: Money.fromPersistence(row.amount, row.currency),
    referenceExternalTransactionId: row.referenceExternalTransactionId ?? undefined,
    correlationId: row.correlationId,
    createdAt: row.createdAt,
    status: row.status as WagerTransactionStatus,
    referenceTransactionId: row.referenceTransactionId ?? undefined,
    failureCode: (row.failureCode as FailureCode | null) ?? undefined,
    processedAt: row.processedAt ?? undefined,
    balanceAfter: row.balanceAfter ? Money.fromPersistence(row.balanceAfter, row.currency) : undefined,
    referenceAttempts: row.referenceAttempts,
    nextReferenceAttemptAt: row.nextReferenceAttemptAt ?? undefined,
  });
}

