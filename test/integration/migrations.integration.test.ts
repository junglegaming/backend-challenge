import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type TestDatabase, createTestDatabase } from './support/test-database';
import { insertTx, insertWallet } from './support/fixtures';
import { expectWalletMatchesLedger } from './support/http-app';

let db: TestDatabase;

const tables = ['wallets', 'wagering_transactions', 'wallet_ledger_entries', 'inbox_messages', 'outbox_messages'];

async function existing(): Promise<string[]> {
  const rows = await db.run<{ table_name: string }>(
    `select table_name from information_schema.tables where table_schema = 'public' and table_name = any(?::text[])`,
    [`{${tables.join(',')}}`],
  );
  return rows.map((r) => r.table_name).sort();
}

async function functions(): Promise<string[]> {
  const rows = await db.run<{ proname: string }>(
    `select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and proname in ('forbid_mutation','wallets_guard_update','wagering_transactions_guard_update')`,
  );
  return rows.map((r) => r.proname).sort();
}

describe('migrations (real PostgreSQL, throwaway database)', () => {
  beforeAll(async () => {
    db = await createTestDatabase({ migrate: false });
  });
  afterAll(async () => {
    await db.drop();
  });

  test('up creates every table and function', async () => {
    await db.orm.migrator.up();
    expect(await existing()).toEqual([...tables].sort());
    expect(await functions()).toEqual(['forbid_mutation', 'wagering_transactions_guard_update', 'wallets_guard_update']);
    expect(await db.orm.migrator.getPending()).toHaveLength(0);
  });

  test('every migration is reversible, one step at a time, down to an empty schema', async () => {
    const executed = (await db.orm.migrator.getExecuted()).length;
    expect(executed).toBe(7);
    for (let remaining = executed - 1; remaining >= 0; remaining--) {
      await db.orm.migrator.down();
      expect(await db.orm.migrator.getExecuted()).toHaveLength(remaining);
    }
    expect(await existing()).toEqual([]);
    expect(await functions()).toEqual([]);
  });

  test('re-applies cleanly after a full rollback and leaves nothing pending', async () => {
    await db.orm.migrator.up();
    expect(await existing()).toEqual([...tables].sort());
    expect(await db.orm.migrator.getPending()).toHaveLength(0);
  });

  test('indexes of the access paths exist', async () => {
    const rows = await db.run<{ indexname: string }>(`select indexname from pg_indexes where schemaname = 'public'`);
    const names = rows.map((r) => r.indexname);
    for (const expected of [
      'wagering_transactions_reversal_per_kind_uq',
      'wagering_transactions_single_reversal_uq',
      'wagering_transactions_waiting_reference_idx',
      'wagering_transactions_pending_reference_scan_idx',
      'wagering_transactions_reference_due_idx',
      'wagering_transactions_wallet_idx',
      'wallet_ledger_entries_wallet_seq_idx',
      'wallet_ledger_entries_transaction_idx',
      'outbox_messages_pending_idx',
      'inbox_messages_pk',
    ]) {
      expect(names).toContain(expected);
    }
  });

  test('upgrade preserves existing pending rows and makes them immediately eligible', async () => {
    await db.orm.migrator.down();
    await db.orm.migrator.down();
    const wallet = await insertWallet(db, { balance: '0.00' });
    const id = await insertTx(db, wallet, {
      kind: 'REFUND', status: 'PENDING_REFERENCE', referenceExternalTransactionId: 'missing',
    });
    await db.orm.migrator.up();
    const [row] = await db.run<{ reference_retry_count: number; due: boolean }>(
      `select reference_retry_count, reference_next_attempt_at <= now() as due
       from wagering_transactions where id = ?`, [id],
    );
    expect(row).toEqual({ reference_retry_count: 0, due: true });
    await expectWalletMatchesLedger(db, wallet.id);
  });
});
