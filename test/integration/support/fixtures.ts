import { randomUUID } from 'node:crypto';
import { expect } from 'bun:test';
import type { TestDatabase } from './test-database';

export const SQLSTATE = {
  unique: '23505',
  check: '23514',
  foreignKey: '23503',
  notNull: '23502',
  integrity: '23000', // raised by our guard/append-only triggers
} as const;

/** Asserts a statement is rejected by the DATABASE, optionally by a specific named constraint. */
export async function expectViolation(
  statement: Promise<unknown>,
  sqlState: string,
  constraint?: string,
): Promise<void> {
  let error: (Error & { code?: string; constraint?: string }) | undefined;
  try {
    await statement;
  } catch (e) {
    error = e as typeof error;
  }
  expect(error, 'expected the database to reject the statement').toBeDefined();
  expect(error!.code).toBe(sqlState);
  if (constraint) expect(error!.constraint).toBe(constraint);
}

export interface WalletRow {
  id: string;
  playerId: string;
}

export async function insertWallet(
  db: TestDatabase,
  o: { id?: string; playerId?: string; currency?: string; balance?: string; version?: number } = {},
): Promise<WalletRow> {
  const id = o.id ?? randomUUID();
  const playerId = o.playerId ?? randomUUID();
  await db.run(
    `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
     values (?, ?, ?, ?, ?, now(), now())`,
    [id, playerId, o.currency ?? 'BRL', o.balance ?? '100.00', o.version ?? 1],
  );
  return { id, playerId };
}

export interface TxOverrides {
  id?: string;
  providerId?: string;
  externalTransactionId?: string;
  idempotencyKey?: string;
  kind?: string;
  amount?: string;
  status?: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  failureCode?: string | null;
  balanceSnapshot?: string | null;
  processedAt?: 'now' | null;
}

/** Inserts a transaction; by default a consistent PENDING one. Statuses get the columns they require. */
export async function insertTx(db: TestDatabase, wallet: WalletRow, o: TxOverrides = {}): Promise<string> {
  const id = o.id ?? randomUUID();
  const status = o.status ?? 'PENDING';
  const external = o.externalTransactionId ?? `ext-${id}`;
  const processed = status === 'PROCESSED';
  // `null` means "explicitly NULL"; only `undefined` falls back to a status-consistent default.
  const pick = <T>(value: T | undefined, fallback: T): T => (value === undefined ? fallback : value);
  const processedAt = pick(o.processedAt, processed ? 'now' : null);
  await db.run(
    `insert into wagering_transactions
       (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
        round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id,
        status, failure_code, balance_snapshot, created_at, processed_at)
     values (?, ?, ?, ?, 'hash', ?, ?, 'round-1', 'game-1', ?, ?, 'BRL', ?, ?, ?, ?, ?, now(),
             ${processedAt === 'now' ? 'now()' : 'null'})`,
    [
      id,
      o.providerId ?? 'provider-a',
      external,
      o.idempotencyKey ?? `${o.providerId ?? 'provider-a'}:${external}`,
      wallet.id,
      wallet.playerId,
      o.kind ?? 'BET',
      o.amount ?? '10.00',
      o.referenceExternalTransactionId ?? null,
      o.referenceTransactionId ?? null,
      status,
      pick(o.failureCode, status === 'REJECTED' ? 'INSUFFICIENT_FUNDS' : status === 'FAILED' ? 'INTERNAL_ERROR' : null),
      pick(o.balanceSnapshot, processed ? '90.00' : null),
    ],
  );
  return id;
}

export async function insertEntry(
  db: TestDatabase,
  o: {
    walletId: string;
    transactionId: string;
    id?: string;
    direction?: string;
    amount?: string;
    before?: string;
    after?: string;
  },
): Promise<string> {
  const id = o.id ?? randomUUID();
  await db.run(
    `insert into wallet_ledger_entries
       (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
     values (?, ?, ?, ?, ?, 'BRL', ?, ?, now())`,
    [id, o.walletId, o.transactionId, o.direction ?? 'DEBIT', o.amount ?? '10.00', o.before ?? '100.00', o.after ?? '90.00'],
  );
  return id;
}
