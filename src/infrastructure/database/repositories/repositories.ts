import { LockMode } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import type {
  InboxRepository,
  OutboxRepository,
  OutboxStats,
} from "../../../modules/messaging/application/messaging-ports";
import type { InboxMessage } from "../../../modules/messaging/domain/inbox-message";
import type { OutboxMessage } from "../../../modules/messaging/domain/outbox-message";
import type {
  ClaimedPendingReference,
  ExternalRef,
  IdempotencyRef,
  SubmissionFailureRepository,
  WagerTransactionRepository,
} from "../../../modules/wagering/application/wagering-ports";
import {
  type SubmissionChannel,
  SubmissionFailure,
  type SubmissionFailureCategory,
} from "../../../modules/wagering/domain/submission-failure";
import type { WagerTransaction } from "../../../modules/wagering/domain/wager-transaction";
import type {
  LedgerAggregate,
  LedgerRepository,
  WalletRepository,
} from "../../../modules/wallet/application/wallet-ports";
import { postingsFor, walletAccount } from "../../../modules/wallet/domain/double-entry";
import type { Wallet } from "../../../modules/wallet/domain/wallet";
import type { WalletLedgerEntry } from "../../../modules/wallet/domain/wallet-ledger-entry";
import { WalletAlreadyExistsError } from "../../../shared/application/errors";
import { Money } from "../../../shared/domain/money";
import { isUniqueViolation } from "../db-errors";
import {
  InboxMessageRecord,
  LedgerEntryRecord,
  LedgerPostingRecord,
  OutboxMessageRecord,
  SubmissionFailureRecord,
  WagerTransactionRecord,
  WalletRecord,
} from "../entities";
import {
  inboxMapper,
  ledgerMapper,
  type OutboxRow,
  outboxMapper,
  toDate,
  wagerMapper,
  walletMapper,
} from "./mappers";

/** Raised when a row moved underneath a conditional write; the whole transaction is retried. */
export class OptimisticConcurrencyError extends Error {
  readonly code = "OPTIMISTIC_CONFLICT";
}

/** Unique violation on an idempotency constraint: a concurrent twin committed first. Retrying turns it into replay/conflict. */
export class IdempotencyRaceError extends Error {
  readonly code = "IDEMPOTENCY_RACE";
}

const IDEMPOTENCY_CONSTRAINTS = [
  "wager_tx_provider_idempotency_uk",
  "wager_tx_provider_external_uk",
  "wager_tx_single_reversal_uk",
];

export class MikroWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(wallet: Wallet): Promise<void> {
    try {
      await this.em.insert(WalletRecord, walletMapper.toRecord(wallet));
    } catch (error) {
      if (isUniqueViolation(error, "wallets_player_currency_uk")) {
        throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
      }
      throw error;
    }
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const row = await this.em.findOne(WalletRecord, { id }, { disableIdentityMap: true });
    return row ? walletMapper.toDomain(row) : undefined;
  }

  async lockById(id: string): Promise<Wallet | undefined> {
    const row = await this.em.findOne(
      WalletRecord,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, disableIdentityMap: true },
    );
    return row ? walletMapper.toDomain(row) : undefined;
  }

  async saveBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    const affected = await this.em.nativeUpdate(
      WalletRecord,
      { id: wallet.id, version: expectedVersion },
      { balanceAmount: wallet.balance.toString(), version: wallet.version, updatedAt: wallet.updatedAt },
    );
    if (affected !== 1) {
      throw new OptimisticConcurrencyError(
        `wallet ${wallet.id} changed underneath (expected v${expectedVersion})`,
      );
    }
  }
}

export class MikroWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | undefined> {
    return this.one({ id });
  }

  async findByProviderExternalId(providerId: string, externalTransactionId: string) {
    return this.one({ providerId, externalTransactionId });
  }

  async findIdempotencyCandidates(idempotencyKey: string, providerId: string, externalTransactionId: string) {
    const rows = await this.em.find(
      WagerTransactionRecord,
      { providerId, $or: [{ idempotencyKey }, { externalTransactionId }] },
      { disableIdentityMap: true, limit: 2 },
    );
    const txs = rows.map(wagerMapper.toDomain);
    return {
      byKey: txs.find((t) => t.idempotencyKey === idempotencyKey),
      byExternal: txs.find(
        (t) => t.providerId === providerId && t.externalTransactionId === externalTransactionId,
      ),
    };
  }

  async lockById(id: string): Promise<WagerTransaction | undefined> {
    const row = await this.em.findOne(
      WagerTransactionRecord,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, disableIdentityMap: true },
    );
    return row ? wagerMapper.toDomain(row) : undefined;
  }

  async insertMany(txs: readonly WagerTransaction[]): Promise<void> {
    if (txs.length === 0) return;
    try {
      await this.em.insertMany(WagerTransactionRecord, txs.map(wagerMapper.toRecord));
    } catch (error) {
      if (IDEMPOTENCY_CONSTRAINTS.some((c) => isUniqueViolation(error, c))) {
        throw new IdempotencyRaceError(`concurrent duplicate among ${txs.length} transaction(s)`, {
          cause: error,
        });
      }
      throw error;
    }
  }

  async findIdempotencyCandidatesMany(keys: readonly IdempotencyRef[], pairs: readonly ExternalRef[]) {
    if (keys.length === 0 && pairs.length === 0) return [];
    const rows = await this.em.find(
      WagerTransactionRecord,
      {
        $or: [
          ...keys.map((k) => ({ providerId: k.providerId, idempotencyKey: k.idempotencyKey })),
          ...pairs.map((p) => ({ providerId: p.providerId, externalTransactionId: p.externalTransactionId })),
        ],
      },
      { disableIdentityMap: true },
    );
    return rows.map(wagerMapper.toDomain);
  }

  async findByProviderExternalIds(pairs: readonly ExternalRef[]) {
    if (pairs.length === 0) return [];
    const rows = await this.em.find(
      WagerTransactionRecord,
      {
        $or: pairs.map((p) => ({ providerId: p.providerId, externalTransactionId: p.externalTransactionId })),
      },
      { disableIdentityMap: true },
    );
    return rows.map(wagerMapper.toDomain);
  }

  async reversedAmong(transactionIds: readonly string[]): Promise<Set<string>> {
    if (transactionIds.length === 0) return new Set();
    const rows = await this.em.find(
      WagerTransactionRecord,
      {
        referenceTransactionId: { $in: [...transactionIds] },
        kind: { $in: ["REFUND", "ROLLBACK"] },
        status: "PROCESSED",
      },
      { fields: ["referenceTransactionId"], disableIdentityMap: true },
    );
    return new Set(rows.map((r) => r.referenceTransactionId).filter((id): id is string => !!id));
  }

  async nudgeDependentsMany(walletId: string, references: readonly ExternalRef[], now: Date) {
    if (references.length === 0) return 0;
    return this.em.nativeUpdate(
      WagerTransactionRecord,
      {
        walletId,
        status: "PENDING_REFERENCE",
        nextReferenceRetryAt: { $gt: now },
        $or: references.map((r) => ({
          providerId: r.providerId,
          referenceExternalTransactionId: r.externalTransactionId,
        })),
      },
      { nextReferenceRetryAt: now },
    );
  }

  async update(tx: WagerTransaction): Promise<void> {
    try {
      await this.em.nativeUpdate(WagerTransactionRecord, { id: tx.id }, wagerMapper.lifecycle(tx));
    } catch (error) {
      if (isUniqueViolation(error, "wager_tx_single_reversal_uk")) {
        throw new IdempotencyRaceError(`reference of ${tx.id} reversed concurrently`, { cause: error });
      }
      throw error;
    }
  }

  async isReversed(transactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId: transactionId,
      kind: { $in: ["REFUND", "ROLLBACK"] },
      status: "PROCESSED",
    });
    return count > 0;
  }

  async nudgeDependents(walletId: string, providerId: string, externalTransactionId: string, now: Date) {
    return this.em.nativeUpdate(
      WagerTransactionRecord,
      {
        walletId,
        providerId,
        referenceExternalTransactionId: externalTransactionId,
        status: "PENDING_REFERENCE",
        nextReferenceRetryAt: { $gt: now },
      },
      { nextReferenceRetryAt: now },
    );
  }

  async claimDuePendingReferences(
    now: Date,
    limit: number,
    leaseUntil: Date,
  ): Promise<ClaimedPendingReference[]> {
    const rows = await this.em.execute<{ id: string; wallet_id: string }[]>(
      `UPDATE wager_transactions t
          SET next_reference_retry_at = ?
         FROM (SELECT id FROM wager_transactions
                WHERE status = 'PENDING_REFERENCE' AND next_reference_retry_at <= ?
                ORDER BY next_reference_retry_at
                LIMIT ?
                FOR UPDATE SKIP LOCKED) due
        WHERE t.id = due.id
      RETURNING t.id, t.wallet_id`,
      [leaseUntil, now, limit],
    );
    return rows.map((r) => ({ id: r.id, walletId: r.wallet_id }));
  }

  async countPendingReferences(): Promise<number> {
    return this.em.count(WagerTransactionRecord, { status: "PENDING_REFERENCE" });
  }

  private async one(
    where: Partial<
      Pick<WagerTransactionRecord, "id" | "idempotencyKey" | "providerId" | "externalTransactionId">
    >,
  ) {
    const row = await this.em.findOne(WagerTransactionRecord, where, { disableIdentityMap: true });
    return row ? wagerMapper.toDomain(row) : undefined;
  }
}

export class MikroLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async insertMany(
    entries: readonly { entry: WalletLedgerEntry; counterpartyAccount: string }[],
  ): Promise<void> {
    if (entries.length === 0) return;
    // One multi-row statement, in version order: the chain trigger (BEFORE INSERT, per row) sees the rows inserted
    // earlier by the same statement, so v(n) is validated against v(n-1) exactly as with separate inserts.
    await this.em.insertMany(
      LedgerEntryRecord,
      entries.map(({ entry }) => ledgerMapper.toRecord(entry)),
    );
    await this.em.insertMany(
      LedgerPostingRecord,
      entries.flatMap(({ entry, counterpartyAccount }) =>
        postingsFor(entry, counterpartyAccount).map((p) => ({
          id: Bun.randomUUIDv7(),
          transactionId: entry.transactionId,
          account: p.account,
          direction: p.direction,
          amount: p.money.toString(),
          currency: p.money.currency,
          createdAt: entry.createdAt,
        })),
      ),
    );
  }

  async page(walletId: string, _currency: string, beforeVersion: number | undefined, limit: number) {
    const rows = await this.em.find(
      LedgerEntryRecord,
      beforeVersion === undefined ? { walletId } : { walletId, walletVersion: { $lt: beforeVersion } },
      { orderBy: { walletVersion: "desc" }, limit, disableIdentityMap: true },
    );
    return rows.map(ledgerMapper.toDomain);
  }

  async aggregate(walletId: string, currency: string): Promise<LedgerAggregate> {
    // Sums are computed in SQL NUMERIC and returned as text: no float ever touches the amounts.
    const [row] = await this.em.execute<
      { credits: string; debits: string; entries: string; max_version: number; chain_breaks: string }[]
    >(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'CREDIT'), 0)::numeric(20, 2)::text AS credits,
              COALESCE(SUM(amount) FILTER (WHERE direction = 'DEBIT'), 0)::numeric(20, 2)::text  AS debits,
              COUNT(*)::text                                                                   AS entries,
              COALESCE(MAX(wallet_version), 0)                                                 AS max_version,
              COUNT(*) FILTER (WHERE prev_after IS NOT NULL AND prev_after <> balance_before)::text AS chain_breaks
         FROM (SELECT amount, direction, wallet_version, balance_before,
                      LAG(balance_after) OVER (ORDER BY wallet_version) AS prev_after
                 FROM wallet_ledger_entries WHERE wallet_id = ?) e`,
      [walletId],
    );
    if (!row) throw new Error("aggregate query returned no rows");
    const [journal] = await this.em.execute<{ wallet_balance: string; unbalanced: string }[]>(
      `SELECT (SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::numeric(20, 2)::text
                 FROM ledger_postings WHERE account = ?) AS wallet_balance,
              (SELECT COUNT(*)::text FROM (
                 SELECT p.transaction_id
                   FROM ledger_postings p
                  WHERE p.transaction_id IN (SELECT transaction_id FROM wallet_ledger_entries WHERE wallet_id = ?)
                  GROUP BY p.transaction_id
                 HAVING SUM(CASE p.direction WHEN 'DEBIT' THEN p.amount ELSE -p.amount END) <> 0) u) AS unbalanced`,
      [walletAccount(walletId), walletId],
    );
    return {
      credits: Money.fromSigned({ amount: row.credits, currency }),
      debits: Money.fromSigned({ amount: row.debits, currency }),
      entries: Number.parseInt(row.entries, 10),
      maxVersion: row.max_version,
      chainBreaks: Number.parseInt(row.chain_breaks, 10),
      unbalancedJournals: Number.parseInt(journal?.unbalanced ?? "0", 10),
      journalBalance: Money.fromSigned({ amount: journal?.wallet_balance ?? "0.00", currency }),
    };
  }
}

export class MikroInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async tryInsertMany(messages: readonly InboxMessage[]): Promise<Set<string>> {
    if (messages.length === 0) return new Set();
    // Rows are inserted (and their unique-index entries locked) in a fixed order: two batches that share
    // messageIds can wait on each other but never deadlock.
    const ordered = [...messages].sort((a, b) =>
      a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0,
    );
    const rows = await this.em.execute<{ message_id: string }[]>(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES ${ordered.map(() => "(?, ?, ?, ?, ?)").join(", ")}
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING message_id`,
      ordered.flatMap((m) => [
        m.consumerName,
        m.messageId,
        m.payloadHash,
        m.receivedAt,
        m.processedAt ?? null,
      ]),
    );
    return new Set(rows.map((r) => r.message_id));
  }

  async findMany(consumerName: string, messageIds: readonly string[]): Promise<InboxMessage[]> {
    if (messageIds.length === 0) return [];
    const rows = await this.em.find(
      InboxMessageRecord,
      { consumerName, messageId: { $in: [...messageIds] } },
      { disableIdentityMap: true },
    );
    return rows.map(inboxMapper.toDomain);
  }

  async deleteMany(consumerName: string, messageIds: readonly string[]): Promise<void> {
    if (messageIds.length === 0) return;
    await this.em.nativeDelete(InboxMessageRecord, { consumerName, messageId: { $in: [...messageIds] } });
  }

  async purgeReceivedBefore(cutoff: Date, limit: number): Promise<number> {
    const rows = await this.em.execute<{ message_id: string }[]>(
      `DELETE FROM inbox_messages
        WHERE ctid IN (SELECT ctid FROM inbox_messages WHERE received_at < ? LIMIT ?)
      RETURNING message_id`,
      [cutoff, limit],
    );
    return rows.length;
  }
}

export class MikroOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async add(messages: readonly OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.em.insertMany(OutboxMessageRecord, messages.map(outboxMapper.toRecord));
  }

  async claimDue(now: Date, limit: number, leaseUntil: Date, owner: string): Promise<OutboxMessage[]> {
    const rows = await this.em.execute<OutboxRow[]>(
      `UPDATE outbox_messages o
          SET locked_until = ?, locked_by = ?
         FROM (SELECT id FROM outbox_messages
                WHERE published_at IS NULL
                  AND next_attempt_at <= ?
                  AND (locked_until IS NULL OR locked_until < ?)
                ORDER BY seq
                LIMIT ?
                FOR UPDATE SKIP LOCKED) due
        WHERE o.id = due.id
      RETURNING o.id, o.aggregate_id, o.event_type, o.event_version, o.payload, o.occurred_at,
                o.attempts, o.next_attempt_at, o.published_at, o.last_error, o.seq`,
      [leaseUntil, owner, now, now, limit],
    );
    // RETURNING does not preserve the subquery order.
    rows.sort((a, b) =>
      Number(BigInt((a as unknown as { seq: string }).seq) - BigInt((b as unknown as { seq: string }).seq)),
    );
    return rows.map(outboxMapper.fromRow);
  }

  async markPublished(ids: readonly string[], at: Date): Promise<void> {
    if (ids.length === 0) return;
    await this.em.execute(
      `UPDATE outbox_messages
          SET published_at = ?, attempts = attempts + 1, locked_until = NULL, locked_by = NULL, last_error = NULL
        WHERE id = ANY(?::uuid[]) AND published_at IS NULL`,
      [at, `{${ids.join(",")}}`],
    );
  }

  async scheduleRetry(message: OutboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      OutboxMessageRecord,
      { id: message.id, publishedAt: null },
      {
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt ?? new Date(),
        lastError: message.lastError ?? null,
        lockedUntil: null,
        lockedBy: null,
      },
    );
  }

  async releaseLeases(owner: string): Promise<number> {
    return this.em.nativeUpdate(
      OutboxMessageRecord,
      { lockedBy: owner, publishedAt: null },
      { lockedUntil: null, lockedBy: null },
    );
  }

  async stats(): Promise<OutboxStats> {
    const [row] = await this.em.execute<{ pending: string; oldest: string | Date | null }[]>(
      `SELECT COUNT(*)::text AS pending, MIN(occurred_at) AS oldest FROM outbox_messages WHERE published_at IS NULL`,
    );
    return {
      pending: Number.parseInt(row?.pending ?? "0", 10),
      oldestPendingOccurredAt: row?.oldest ? toDate(row.oldest) : undefined,
    };
  }
}

const optional = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v);

export class MikroSubmissionFailureRepository implements SubmissionFailureRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(failure: SubmissionFailure): Promise<void> {
    const s = failure.toState();
    await this.em.insert(SubmissionFailureRecord, {
      id: s.id,
      channel: s.channel,
      reasonCode: s.reasonCode,
      category: s.category,
      retryable: s.retryable,
      providerId: s.providerId ?? null,
      externalTransactionId: s.externalTransactionId ?? null,
      idempotencyKey: s.idempotencyKey ?? null,
      walletId: s.walletId ?? null,
      messageId: s.messageId ?? null,
      transactionId: s.transactionId ?? null,
      payloadHash: s.payloadHash ?? null,
      detail: s.detail ?? null,
      receiveCount: s.receiveCount ?? null,
      correlationId: s.correlationId ?? null,
      occurredAt: s.occurredAt,
    });
  }

  async listByExternalId(providerId: string, externalTransactionId: string, limit: number) {
    const rows = await this.em.find(
      SubmissionFailureRecord,
      { providerId, externalTransactionId },
      { orderBy: { occurredAt: "desc" }, limit, disableIdentityMap: true },
    );
    return rows.map((r) =>
      SubmissionFailure.rehydrate({
        id: r.id,
        channel: r.channel as SubmissionChannel,
        reasonCode: r.reasonCode,
        category: r.category as SubmissionFailureCategory,
        retryable: r.retryable,
        providerId: optional(r.providerId),
        externalTransactionId: optional(r.externalTransactionId),
        idempotencyKey: optional(r.idempotencyKey),
        walletId: optional(r.walletId),
        messageId: optional(r.messageId),
        transactionId: optional(r.transactionId),
        payloadHash: optional(r.payloadHash),
        detail: optional(r.detail),
        receiveCount: optional(r.receiveCount),
        correlationId: optional(r.correlationId),
        occurredAt: toDate(r.occurredAt),
      }),
    );
  }

  async purgeOccurredBefore(cutoff: Date, limit: number): Promise<number> {
    const rows = await this.em.execute<{ id: string }[]>(
      `DELETE FROM wager_submission_failures
        WHERE id IN (SELECT id FROM wager_submission_failures WHERE occurred_at < ? LIMIT ?)
      RETURNING id`,
      [cutoff, limit],
    );
    return rows.length;
  }
}
