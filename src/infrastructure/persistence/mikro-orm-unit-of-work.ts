import { EntityManager } from '@mikro-orm/postgresql';
import { Money } from '../../domain/shared/money';
import type { FailureCode } from '../../domain/wagering/failure-code';
import type { WagerTransactionKind, WagerTransactionStatus } from '../../domain/wagering/wager-enums';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import { ApplicationError, TransientInfrastructureError } from '../../application/errors';
import type { IntegrationEvent } from '../../application/events/integration-event';
import type {
  LedgerRepository,
  InboxRepository,
  OutboxRepository,
  StoredTransaction,
  UnitOfWork,
  WageringRepositories,
  WagerTransactionRepository,
  WalletRepository,
} from '../../application/ports/wagering-repositories.port';
import { DomainError } from '../../domain/shared/domain-error';
import { NOOP_TELEMETRY, type Telemetry } from '../../application/observability/telemetry';
import { decimalText } from './decimal-text';
import { SpanKind } from '@opentelemetry/api';
import { captureTrace, parseTraceCarrier, traced, type TraceCarrier } from '../../application/observability/tracing';

export type Row = Record<string, unknown>;

/** Executes parameterised SQL inside the current MikroORM transaction. */
export class Sql {
  constructor(private readonly em: EntityManager) {}

  rows(sql: string, params: unknown[] = []): Promise<Row[]> {
    return traced('PostgreSQL query', SpanKind.CLIENT, (span) => {
      span.setAttribute('db.system.name', 'postgresql');
      return this.em.getConnection().execute(sql, params, 'all', this.em.getTransactionContext()) as Promise<Row[]>;
    });
  }

  async affected(sql: string, params: unknown[] = []): Promise<number> {
    const result = (await traced('PostgreSQL query', SpanKind.CLIENT, (span) => {
      span.setAttribute('db.system.name', 'postgresql');
      return this.em
      .getConnection()
      .execute(sql, params, 'run', this.em.getTransactionContext());
    })) as { affectedRows: number };
    return result.affectedRows;
  }
}

const TRANSACTION_COLUMNS = `id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
  player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id,
  reference_transaction_id, status, failure_code, balance_snapshot, created_at, processed_at`;

const str = (v: unknown): string => String(v);
const optional = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v));

export class SqlWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly sql: Sql) {}

  async insertIfAbsent(tx: WagerTransaction, trace?: { correlationId: string; causationId?: string | undefined }): Promise<boolean> {
    // The wallet is joined so a missing wallet makes the insert a no-op instead of aborting the SQL transaction with an FK error.
    const rows = await this.sql.rows(
      `insert into wagering_transactions
         (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id,
          game_id, kind, amount, currency, reference_external_transaction_id, status, created_at, correlation_id, causation_id, trace_context)
       select ?::uuid, ?, ?, ?, ?, w.id, ?::uuid, ?, ?, ?, ?::numeric, ?, ?, 'PENDING', ?::timestamptz, ?, ?, ?::jsonb
         from wallets w where w.id = ?::uuid
       on conflict do nothing
       returning id`,
      [
        tx.id,
        tx.providerId,
        tx.externalTransactionId,
        tx.idempotencyKey,
        tx.payloadHash,
        tx.playerId,
        tx.roundId,
        tx.gameId,
        tx.kind,
        tx.money.toString(),
        tx.money.currency,
        tx.referenceExternalTransactionId ?? null,
        tx.createdAt.toISOString(),
        trace?.correlationId ?? null,
        trace?.causationId ?? null,
        JSON.stringify(captureTrace()),
        tx.walletId,
      ],
    );
    return rows.length === 1;
  }

  async findByIdempotencyKey(key: string): Promise<StoredTransaction | undefined> {
    const [row] = await this.sql.rows(`select ${TRANSACTION_COLUMNS} from wagering_transactions where idempotency_key = ?`, [key]);
    return row ? this.toStored(row) : undefined;
  }

  async findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<StoredTransaction | undefined> {
    const [row] = await this.sql.rows(
      `select ${TRANSACTION_COLUMNS} from wagering_transactions where provider_id = ? and external_transaction_id = ?`,
      [providerId, externalTransactionId],
    );
    return row ? this.toStored(row) : undefined;
  }

  async findById(id: string): Promise<StoredTransaction | undefined> {
    const [row] = await this.sql.rows(`select ${TRANSACTION_COLUMNS} from wagering_transactions where id = ?::uuid`, [id]);
    return row ? this.toStored(row) : undefined;
  }

  async isReversed(transactionId: string): Promise<boolean> {
    const rows = await this.sql.rows(
      `select 1 from wagering_transactions
        where reference_transaction_id = ?::uuid and status = 'PROCESSED' and kind in ('REFUND','ROLLBACK')`,
      [transactionId],
    );
    return rows.length > 0;
  }

  async claimDueReference(now: Date): Promise<{ transaction: WagerTransaction; retryCount: number; correlationId?: string | undefined; causationId?: string | undefined; traceContext?: TraceCarrier | undefined } | undefined> {
    const [row] = await this.sql.rows(
      `select ${TRANSACTION_COLUMNS}, reference_retry_count, correlation_id, causation_id, trace_context from wagering_transactions
       where status = 'PENDING_REFERENCE' and reference_next_attempt_at <= ?::timestamptz
       order by reference_next_attempt_at, id limit 1 for no key update skip locked`,
      [now.toISOString()],
    );
    return row ? { transaction: this.toStored(row).transaction, retryCount: Number(row.reference_retry_count), correlationId: optional(row.correlation_id), causationId: optional(row.causation_id), traceContext: parseTraceCarrier(row.trace_context) } : undefined;
  }

  async scheduleReferenceRetry(transactionId: string, retryCount: number, nextAttemptAt: Date): Promise<void> {
    const updated = await this.sql.affected(
      `update wagering_transactions set reference_retry_count = ?, reference_next_attempt_at = ?::timestamptz
       where id = ?::uuid and status = 'PENDING_REFERENCE'`,
      [retryCount, nextAttemptAt.toISOString(), transactionId],
    );
    if (updated !== 1) throw new Error(`pending transaction ${transactionId} could not be scheduled`);
  }

  async saveOutcome(tx: WagerTransaction, balanceSnapshot: Money | undefined): Promise<void> {
    const updated = await this.sql.affected(
      `update wagering_transactions
          set status = ?, failure_code = ?, reference_transaction_id = ?::uuid,
              balance_snapshot = ?::numeric, processed_at = ?::timestamptz
        where id = ?::uuid`,
      [
        tx.status,
        tx.failureCode ?? null,
        tx.referenceTransactionId ?? null,
        tx.status === 'PROCESSED' ? (balanceSnapshot?.toString() ?? null) : null,
        tx.processedAt?.toISOString() ?? null,
        tx.id,
      ],
    );
    if (updated !== 1) throw new Error(`transaction ${tx.id} disappeared while being processed`);
  }

  private toStored(row: Row): StoredTransaction {
    const currency = str(row.currency);
    const snapshot = row.balance_snapshot == null ? undefined : decimalText(row.balance_snapshot);
    return {
      transaction: WagerTransaction.rehydrate({
        id: str(row.id),
        providerId: str(row.provider_id),
        externalTransactionId: str(row.external_transaction_id),
        idempotencyKey: str(row.idempotency_key),
        payloadHash: str(row.payload_hash),
        walletId: str(row.wallet_id),
        playerId: str(row.player_id),
        roundId: str(row.round_id),
        gameId: str(row.game_id),
        kind: str(row.kind) as WagerTransactionKind,
        money: Money.from({ amount: decimalText(row.amount), currency }),
        referenceExternalTransactionId: optional(row.reference_external_transaction_id),
        createdAt: new Date(str(row.created_at)),
        status: str(row.status) as WagerTransactionStatus,
        referenceTransactionId: optional(row.reference_transaction_id),
        failureCode: optional(row.failure_code) as FailureCode | undefined,
        processedAt: row.processed_at ? new Date(str(row.processed_at)) : undefined,
      }),
      balanceSnapshot: snapshot ? Money.from({ amount: snapshot, currency }) : undefined,
    };
  }
}

class SqlWalletRepository implements WalletRepository {
  constructor(private readonly sql: Sql) {}

  async insertIfAbsent(wallet: Wallet): Promise<boolean> {
    const rows = await this.sql.rows(
      `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
       values (?::uuid, ?::uuid, ?, ?::numeric, ?, ?::timestamptz, ?::timestamptz)
       on conflict do nothing returning id`,
      [
        wallet.id,
        wallet.playerId,
        wallet.currency,
        wallet.balance.toString(),
        wallet.version,
        wallet.createdAt.toISOString(),
        wallet.updatedAt.toISOString(),
      ],
    );
    return rows.length === 1;
  }

  async lockById(walletId: string): Promise<Wallet | undefined> {
    const [row] = await this.sql.rows(
      `select id, player_id, currency, balance, version, created_at, updated_at
         from wallets where id = ?::uuid for no key update`,
      [walletId],
    );
    if (!row) return undefined;
    const currency = str(row.currency);
    return Wallet.rehydrate({
      id: str(row.id),
      playerId: str(row.player_id),
      currency,
      balance: Money.from({ amount: decimalText(row.balance), currency }),
      version: Number(row.version),
      createdAt: new Date(str(row.created_at)),
      updatedAt: new Date(str(row.updated_at)),
    });
  }

  async saveBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    const updated = await this.sql.affected(
      `update wallets set balance = ?::numeric, version = ?, updated_at = ?::timestamptz
        where id = ?::uuid and version = ?`,
      [wallet.balance.toString(), wallet.version, wallet.updatedAt.toISOString(), wallet.id, expectedVersion],
    );
    if (updated !== 1) throw new Error(`wallet ${wallet.id} changed under its own row lock (expected version ${expectedVersion})`);
  }
}

class SqlLedgerRepository implements LedgerRepository {
  constructor(private readonly sql: Sql) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.sql.rows(
      `insert into wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       values (?::uuid, ?::uuid, ?::uuid, ?, ?::numeric, ?, ?::numeric, ?::numeric, ?::timestamptz)`,
      [
        entry.id,
        entry.walletId,
        entry.transactionId,
        entry.direction,
        entry.money.toString(),
        entry.money.currency,
        entry.balanceBefore.toString(),
        entry.balanceAfter.toString(),
        entry.createdAt.toISOString(),
      ],
    );
  }
}

class SqlOutboxRepository implements OutboxRepository {
  constructor(private readonly sql: Sql) {}

  async enqueue(event: IntegrationEvent<unknown>): Promise<void> {
    await this.sql.rows(
      `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at, trace_context)
       values (?::uuid, ?::uuid, ?, ?::jsonb, ?::timestamptz, ?::timestamptz, ?::jsonb)`,
      [event.eventId, event.aggregateId, event.eventType, JSON.stringify(event), event.occurredAt.toISOString(),
        event.occurredAt.toISOString(), JSON.stringify(captureTrace())],
    );
  }
}

class SqlInboxRepository implements InboxRepository {
  constructor(private readonly sql: Sql) {}

  async receive(consumerName: string, messageId: string, payloadHash: string, now: Date): Promise<'inserted' | 'duplicate' | 'conflict'> {
    const inserted = await this.sql.rows(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at)
       values (?, ?, ?, ?::timestamptz) on conflict (consumer_name, message_id) do nothing returning message_id`,
      [consumerName, messageId, payloadHash, now.toISOString()],
    );
    if (inserted.length) return 'inserted';
    const [existing] = await this.sql.rows(
      'select payload_hash, processed_at from inbox_messages where consumer_name = ? and message_id = ?',
      [consumerName, messageId],
    );
    if (!existing || !existing.processed_at) throw new Error('Inbox conflict without a processed message');
    return existing.payload_hash === payloadHash ? 'duplicate' : 'conflict';
  }

  async markProcessed(consumerName: string, messageId: string, now: Date): Promise<void> {
    const count = await this.sql.affected(
      'update inbox_messages set processed_at = ?::timestamptz where consumer_name = ? and message_id = ? and processed_at is null',
      [now.toISOString(), consumerName, messageId],
    );
    if (count !== 1) throw new Error('Inbox message could not be marked processed');
  }
}

/** SQLSTATE classes/codes after which nothing was committed and a retry may succeed. */
const TRANSIENT_SQLSTATES = new Set(['40001', '40P01', '55P03', '57014', '57P01', '57P02', '57P03']);
const TRANSIENT_NODE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND']);

export function isTransientDatabaseError(error: unknown): boolean {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  if (typeof code === 'string') {
    if (TRANSIENT_SQLSTATES.has(code) || code.startsWith('08') || code.startsWith('53') || TRANSIENT_NODE_CODES.has(code)) {
      return true;
    }
  }
  return typeof message === 'string' && /connection terminated|connection timeout|timeout exceeded when trying to connect/i.test(message);
}

export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly em: EntityManager,
    private readonly lockTimeoutMs = 5000,
    private readonly telemetry: Telemetry = NOOP_TELEMETRY,
  ) {}

  async run<T>(work: (repositories: WageringRepositories) => Promise<T>): Promise<T> {
    try {
      return await this.em.fork().transactional(async (em) => {
        const sql = new Sql(em);
        // Bounded wait on a contended wallet row: surfaces as a retryable 503 instead of hanging the request.
        await sql.rows(`select set_config('lock_timeout', ?, true)`, [`${this.lockTimeoutMs}ms`]);
        return work({
          transactions: new SqlWagerTransactionRepository(sql),
          wallets: new SqlWalletRepository(sql),
          ledger: new SqlLedgerRepository(sql),
          outbox: new SqlOutboxRepository(sql),
          inbox: new SqlInboxRepository(sql),
        });
      });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && (error.code === '55P03' || error.code === '40P01')) {
        this.telemetry.lockConflict();
      }
      if (error instanceof ApplicationError || error instanceof DomainError) throw error;
      if (isTransientDatabaseError(error)) {
        throw new TransientInfrastructureError('database temporarily unavailable', { cause: error });
      }
      throw error;
    }
  }
}
