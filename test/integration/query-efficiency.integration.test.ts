import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  WageringTransactionRecord,
  WalletLedgerEntryRecord,
} from '../../src/infrastructure/persistence/entities/records';
import { insertEntry, insertTx, insertWallet, type WalletRow } from './support/fixtures';
import { type TestDatabase, createTestDatabase } from './support/test-database';

let db: TestDatabase;
let wallet: WalletRow;
let betId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  wallet = await insertWallet(db, { balance: '1000.00' });
  // A mix of statuses so the partial indexes have something to exclude.
  for (let i = 0; i < 40; i++) {
    const id = await insertTx(db, wallet, { kind: 'BET', status: 'PROCESSED', amount: '1.00' });
    if (i === 0) betId = id;
    await insertEntry(db, { walletId: wallet.id, transactionId: id, before: '100.00', amount: '1.00', after: '99.00' });
  }
  for (let i = 0; i < 10; i++) {
    await insertTx(db, wallet, { kind: 'REFUND', status: 'PENDING_REFERENCE', referenceExternalTransactionId: `ref-${i}` });
    await insertTx(db, wallet, { kind: 'BET', status: 'REJECTED' });
  }
  await db.run('analyze');
  await db.run('vacuum wallet_ledger_entries'); // sets the visibility map so index-only scans are viable
});

afterAll(async () => {
  await db.drop();
});

/** Runs EXPLAIN with sequential scans disabled, so the plan proves an index CAN serve the access path. */
async function plan(sql: string, params: unknown[] = []): Promise<string> {
  return db.orm.em.fork().transactional(async (em) => {
    const connection = em.getConnection();
    const ctx = em.getTransactionContext();
    await connection.execute('set local enable_seqscan = off', [], 'run', ctx);
    await connection.execute('set local enable_bitmapscan = off', [], 'run', ctx);
    const rows = (await connection.execute(`explain ${sql}`, params, 'all', ctx)) as Array<Record<string, string>>;
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  });
}

describe('every hot access path is served by an index (no sequential scans, no sorts)', () => {
  test('idempotency lookup', async () => {
    expect(await plan('select * from wagering_transactions where idempotency_key = ?', ['provider-a:x'])).toContain(
      'wagering_transactions_idempotency_key_uq',
    );
  });

  test('provider + external id lookup (also resolves reversal references)', async () => {
    expect(
      await plan('select * from wagering_transactions where provider_id = ? and external_transaction_id = ?', ['provider-a', 'x']),
    ).toContain('wagering_transactions_provider_external_uq');
  });

  test('"who is waiting for this reference?" uses the small partial index', async () => {
    expect(
      await plan(
        `select id from wagering_transactions
          where status = 'PENDING_REFERENCE' and provider_id = ? and reference_external_transaction_id = ?`,
        ['provider-a', 'ref-1'],
      ),
    ).toContain('wagering_transactions_waiting_reference_idx');
  });

  test('worker scan of waiting transactions is ordered by the index (no Sort)', async () => {
    const p = await plan(`select id from wagering_transactions where status = 'PENDING_REFERENCE' order by created_at limit 100`);
    expect(p).toContain('wagering_transactions_pending_reference_scan_idx');
    expect(p).not.toContain('Sort');
  });

  test('retry worker uses the partial due-time index with SKIP LOCKED', async () => {
    const p = await plan(`select id from wagering_transactions
      where status = 'PENDING_REFERENCE' and reference_next_attempt_at <= now()
      order by reference_next_attempt_at, id limit 1 for no key update skip locked`);
    expect(p).toContain('wagering_transactions_reference_due_idx');
    expect(p).not.toContain('Sort');
  });

  test('"was this reference already reversed?" hits a reversal unique index', async () => {
    expect(
      await plan(
        `select 1 from wagering_transactions
          where reference_transaction_id = ? and status = 'PROCESSED' and kind in ('REFUND','ROLLBACK')`,
        [betId],
      ),
    ).toMatch(/wagering_transactions_(single_reversal|reversal_per_kind)_uq/);
  });

  test('wallet transaction history, newest first, without a Sort', async () => {
    const p = await plan('select * from wagering_transactions where wallet_id = ? order by created_at desc limit 20', [wallet.id]);
    expect(p).toContain('wagering_transactions_wallet_idx');
    expect(p).not.toContain('Sort');
  });

  test('wallet by (player_id, currency)', async () => {
    expect(await plan('select * from wallets where player_id = ? and currency = ?', [wallet.playerId, 'BRL'])).toContain(
      'wallets_player_currency_uq',
    );
  });

  test('ledger entry of a transaction (single and batched)', async () => {
    expect(await plan('select * from wallet_ledger_entries where transaction_id = ?', [betId])).toContain(
      'wallet_ledger_entries_transaction_idx',
    );
    expect(await plan('select * from wallet_ledger_entries where transaction_id in (?, ?)', [betId, randomUUID()])).toContain(
      'wallet_ledger_entries_transaction_idx',
    );
  });

  test('ledger keyset page (cursor = seq): index range scan, no OFFSET, no Sort', async () => {
    const p = await plan('select * from wallet_ledger_entries where wallet_id = ? and seq > ? order by seq limit 50', [wallet.id, 0]);
    expect(p).toContain('wallet_ledger_entries_wallet_seq_idx');
    expect(p).not.toContain('Sort');
  });

  test('reconciliation sum is an index-only scan (direction and amount are INCLUDEd)', async () => {
    const p = await plan(
      `select coalesce(sum(case when direction = 'CREDIT' then amount else -amount end), 0) as balance, count(*)
         from wallet_ledger_entries where wallet_id = ?`,
      [wallet.id],
    );
    expect(p).toContain('Index Only Scan');
    expect(p).toContain('wallet_ledger_entries_wallet_seq_idx');
  });

  test('outbox claim for publishers: pending partial index, ordered, SKIP LOCKED', async () => {
    const p = await plan(
      `select id from outbox_messages
        where published_at is null and next_attempt_at <= now()
        order by next_attempt_at limit 10 for update skip locked`,
    );
    expect(p).toContain('outbox_messages_pending_idx');
    expect(p).not.toContain('Sort');
  });
});

describe('no N+1: query count does not grow with the number of rows', () => {
  const selects = () => db.queries.filter((q) => /\bselect\b/i.test(q)).length;

  async function loadWalletWithEntries(limit: number): Promise<{ queries: number; rows: number; entries: number }> {
    const em = db.orm.em.fork();
    db.queries.length = 0;
    const txs = await em.find(WageringTransactionRecord, { walletId: wallet.id, status: 'PROCESSED' }, { limit });
    const entries = await em.find(WalletLedgerEntryRecord, { transactionId: { $in: txs.map((t) => t.id) } });
    return { queries: selects(), rows: txs.length, entries: entries.length };
  }

  test('transactions + their ledger entries cost 2 queries for 5 rows and for 40 rows alike', async () => {
    const small = await loadWalletWithEntries(5);
    const large = await loadWalletWithEntries(40);
    expect(small).toEqual({ queries: 2, rows: 5, entries: 5 });
    expect(large).toEqual({ queries: 2, rows: 40, entries: 40 });
  });

  test('records expose foreign keys as scalars: nothing can lazy-load behind your back', async () => {
    const em = db.orm.em.fork();
    const [tx] = await em.find(WageringTransactionRecord, { walletId: wallet.id }, { limit: 1 });
    db.queries.length = 0;
    expect(typeof tx!.walletId).toBe('string');
    expect(typeof tx!.referenceTransactionId === 'string' || tx!.referenceTransactionId == null).toBe(true);
    expect(selects()).toBe(0);
  });
});
