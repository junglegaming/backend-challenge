import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { ConcurrencyConflictError } from '../../../application/errors';
import type { InboxMessage } from '../../../domain/inbox-message';
import { Money } from '../../../domain/money';
import type { OutboxMessage } from '../../../domain/outbox-message';
import type {
  InboxRepository,
  LedgerPage,
  LedgerRepository,
  LedgerTotals,
  OutboxRepository,
  TransactionScope,
  WagerTransactionRepository,
  WalletRepository,
} from '../../../domain/ports/repositories';
import { type WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../../domain/wager-transaction';
import type { Wallet } from '../../../domain/wallet';
import {
  InboxRecord,
  LedgerEntryRecord,
  OutboxRecord,
  WagerTransactionRecord,
  WalletRecord,
} from '../entities/records';
import {
  InboxMapper,
  LedgerEntryMapper,
  OutboxMapper,
  type OutboxRow,
  WagerTransactionMapper,
  WalletMapper,
} from '../mappers';

/*
 * Repositories bound to one EntityManager fork (= one SQL transaction).
 *
 * Reads go through MikroORM (metadata, mapping, LockMode). Writes are explicit
 * (em.insert / em.nativeUpdate / SQL) instead of Unit-of-Work change tracking:
 * on the hot path we want to control statement order and to express
 * conditional updates (WHERE version = ?, WHERE status = ?) whose affected-row
 * count proves that nobody else wrote in between. `refresh: true` makes every
 * read hit the database, so the identity map never serves stale state.
 */

class MikroWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletRecord, { id }, { refresh: true });
    return record ? WalletMapper.toDomain(record) : undefined;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletRecord, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
    return record ? WalletMapper.toDomain(record) : undefined;
  }

  async save(wallet: Wallet): Promise<void> {
    const record = WalletMapper.toRecord(wallet);
    if (wallet.isNew()) {
      await this.em.insert(WalletRecord, record);
    } else if (wallet.version !== wallet.persistedVersion) {
      const affected = await this.em.nativeUpdate(
        WalletRecord,
        { id: wallet.id, version: wallet.persistedVersion },
        { balance: record.balance, version: record.version, updatedAt: record.updatedAt },
      );
      if (affected !== 1) {
        throw new ConcurrencyConflictError(`Wallet ${wallet.id} changed concurrently (expected v${wallet.persistedVersion})`);
      }
    }
    const entries = wallet.pullUncommittedEntries();
    if (entries.length > 0) {
      await this.em.insertMany(LedgerEntryRecord, entries.map(LedgerEntryMapper.toRecord));
    }
  }
}

class MikroLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async page(walletId: string, afterSequence: string | undefined, limit: number): Promise<LedgerPage> {
    const rows = await this.em.execute<Array<Record<string, unknown>>>(
      `SELECT id, sequence::text AS sequence, wallet_id, transaction_id, direction, amount::text AS amount, currency,
              balance_before::text AS balance_before, balance_after::text AS balance_after, wallet_version, created_at
         FROM wallet_ledger_entries
        WHERE wallet_id = ? AND sequence > ?
        ORDER BY sequence
        LIMIT ?`,
      [walletId, afterSequence ?? '0', limit + 1],
    );
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const entries = pageRows.map((r) =>
      LedgerEntryMapper.toDomain({
        id: r.id as string,
        walletId: r.wallet_id as string,
        transactionId: r.transaction_id as string,
        direction: r.direction as string,
        amount: r.amount as string,
        currency: r.currency as string,
        balanceBefore: r.balance_before as string,
        balanceAfter: r.balance_after as string,
        walletVersion: Number(r.wallet_version),
        createdAt: r.created_at as Date,
      }),
    );
    const last = pageRows[pageRows.length - 1];
    return { entries, nextAfterSequence: hasMore && last ? (last.sequence as string) : undefined };
  }

  async totals(walletId: string, currency: string): Promise<LedgerTotals> {
    const [row] = await this.em.execute<Array<{ net: string; entries: number }>>(
      `SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::numeric(20, 2)::text AS net,
              COUNT(*)::int AS entries
         FROM wallet_ledger_entries
        WHERE wallet_id = ?`,
      [walletId],
    );
    return { net: Money.fromPersisted(row?.net ?? '0.00', currency), entries: Number(row?.entries ?? 0) };
  }
}

class MikroWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | undefined> {
    return this.one({ id });
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    return this.one({ idempotencyKey });
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.one({ providerId, externalTransactionId });
  }

  async isReversed(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  async save(tx: WagerTransaction): Promise<void> {
    const record = WagerTransactionMapper.toRecord(tx);
    if (tx.isNew()) {
      await this.em.insert(WagerTransactionRecord, record);
      return;
    }
    const affected = await this.em.nativeUpdate(
      WagerTransactionRecord,
      { id: tx.id, status: tx.persistedStatus },
      {
        status: record.status,
        failureCode: record.failureCode,
        resultBalance: record.resultBalance,
        referenceTransactionId: record.referenceTransactionId,
        referenceAttempts: record.referenceAttempts,
        nextReferenceCheckAt: record.nextReferenceCheckAt,
        processedAt: record.processedAt,
        updatedAt: record.updatedAt,
      },
    );
    if (affected !== 1) {
      throw new ConcurrencyConflictError(`Transaction ${tx.id} changed concurrently`);
    }
  }

  async claimDuePendingReferences(leaseMs: number, limit: number): Promise<Array<{ id: string; walletId: string }>> {
    const rows = await this.em.execute<Array<{ id: string; wallet_id: string }>>(
      `UPDATE wager_transactions t
          SET next_reference_check_at = now() + (? * interval '1 millisecond')
        WHERE t.id IN (
              SELECT id FROM wager_transactions
               WHERE status = 'PENDING_REFERENCE' AND next_reference_check_at <= now()
               ORDER BY next_reference_check_at
               LIMIT ?
               FOR UPDATE SKIP LOCKED)
       RETURNING t.id, t.wallet_id`,
      [leaseMs, limit],
    );
    return rows.map((r) => ({ id: r.id, walletId: r.wallet_id }));
  }

  async wakeDependents(providerId: string, externalTransactionId: string): Promise<number> {
    const rows = await this.em.execute<Array<{ id: string }>>(
      `UPDATE wager_transactions
          SET next_reference_check_at = now()
        WHERE status = 'PENDING_REFERENCE'
          AND provider_id = ? AND reference_external_transaction_id = ?
          AND next_reference_check_at > now()
       RETURNING id`,
      [providerId, externalTransactionId],
    );
    return rows.length;
  }

  private async one(where: Partial<WagerTransactionRecord>): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionRecord, where, { refresh: true });
    return record ? WagerTransactionMapper.toDomain(record) : undefined;
  }
}

class MikroInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async tryReceive(message: InboxMessage): Promise<boolean> {
    const rows = await this.em.execute<Array<{ message_id: string }>>(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING message_id`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt, message.processedAt ?? null],
    );
    return rows.length === 1;
  }

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const record = await this.em.findOne(InboxRecord, { consumerName, messageId }, { refresh: true });
    return record ? InboxMapper.toDomain(record) : undefined;
  }
}

const OUTBOX_COLUMNS = 'id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at';

class MikroOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async add(messages: readonly OutboxMessage[]): Promise<void> {
    await this.em.insertMany(OutboxRecord, messages.map(OutboxMapper.toRecord));
  }

  /**
   * Lease-based claim. SKIP LOCKED makes concurrent claimers pick disjoint
   * rows; the lease (locked_until, using the DB clock) keeps the rows away
   * from other publishers after this short transaction commits, and lets
   * another instance take over if this one dies mid-publish.
   */
  async claimBatch(owner: string, leaseMs: number, limit: number): Promise<OutboxMessage[]> {
    const rows = await this.em.execute<OutboxRow[]>(
      `UPDATE outbox_messages o
          SET locked_by = ?, locked_until = now() + (? * interval '1 millisecond')
        WHERE o.id IN (
              SELECT id FROM outbox_messages
               WHERE published_at IS NULL
                 AND next_attempt_at <= now()
                 AND (locked_until IS NULL OR locked_until < now())
               ORDER BY next_attempt_at, sequence
               LIMIT ?
               FOR UPDATE SKIP LOCKED)
       RETURNING ${OUTBOX_COLUMNS}, sequence`,
      [owner, leaseMs, limit],
    );
    // RETURNING does not preserve the sub-select order
    return rows.sort((a, b) => Number(a.sequence) - Number(b.sequence)).map(OutboxMapper.fromRow);
  }

  async markPublished(ids: readonly string[], at: Date): Promise<number> {
    if (ids.length === 0) return 0;
    const rows = await this.em.execute<Array<{ id: string }>>(
      `UPDATE outbox_messages
          SET published_at = ?, locked_by = NULL, locked_until = NULL, last_error = NULL
        WHERE id IN (${ids.map(() => '?').join(', ')}) AND published_at IS NULL
       RETURNING id`,
      [at, ...ids],
    );
    return rows.length;
  }

  async scheduleRetry(message: OutboxMessage, owner: string, error: string): Promise<void> {
    await this.em.execute(
      `UPDATE outbox_messages
          SET attempts = ?, next_attempt_at = ?, locked_by = NULL, locked_until = NULL, last_error = ?
        WHERE id = ? AND locked_by = ? AND published_at IS NULL`,
      [message.attempts, message.nextAttemptAt ?? new Date(), error.slice(0, 2000), message.id, owner],
    );
  }

  async stats(): Promise<{ pending: number; oldestPendingAgeSeconds: number }> {
    const [row] = await this.em.execute<Array<{ pending: number; age: number | string }>>(
      `SELECT COUNT(*)::int AS pending,
              COALESCE(EXTRACT(EPOCH FROM (now() - MIN(occurred_at))), 0)::float8 AS age
         FROM outbox_messages
        WHERE published_at IS NULL`,
    );
    return { pending: Number(row?.pending ?? 0), oldestPendingAgeSeconds: Number(row?.age ?? 0) };
  }
}

export class MikroTransactionScope implements TransactionScope {
  readonly wallets: WalletRepository;
  readonly ledger: LedgerRepository;
  readonly transactions: WagerTransactionRepository;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;

  constructor(em: EntityManager) {
    this.wallets = new MikroWalletRepository(em);
    this.ledger = new MikroLedgerRepository(em);
    this.transactions = new MikroWagerTransactionRepository(em);
    this.inbox = new MikroInboxRepository(em);
    this.outbox = new MikroOutboxRepository(em);
  }
}
