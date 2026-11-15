import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import type { PoolClient } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { buildOrmConfig } from '../../src/infrastructure/persistence/orm-config';
import { createTestEnvironment, type TestEnvironment } from '../support/harness';

/**
 * The guarantees of section 6 must hold at the schema level, even for writes
 * that bypass the application. These tests talk to PostgreSQL directly.
 */
let env: TestEnvironment;

beforeAll(async () => {
  env = await createTestEnvironment();
});
afterAll(async () => {
  await env.teardown();
});

/** Runs statements in one transaction and returns the error raised (at statement or COMMIT time). */
const failure = async (work: (c: PoolClient) => Promise<unknown>): Promise<string | undefined> => {
  const client = await env.db.connect();
  try {
    await client.query('BEGIN');
    await work(client);
    await client.query('COMMIT');
    return undefined;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    return (error as Error).message;
  } finally {
    client.release();
  }
};

const ok = async (work: (c: PoolClient) => Promise<unknown>) => expect(await failure(work)).toBeUndefined();

interface Seed {
  walletId: string;
  playerId: string;
  txId: string;
}

/** A consistent wallet: balance 100 backed by one OPENING transaction + ledger entry. */
const seedWallet = async (c: PoolClient): Promise<Seed> => {
  const walletId = uuidv7();
  const playerId = uuidv7();
  const txId = uuidv7();
  await c.query(`INSERT INTO wallets VALUES ($1, $2, 'BRL', 100.00, 1, now(), now())`, [walletId, playerId]);
  await c.query(
    `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
       round_id, game_id, kind, amount, currency, status, result_balance, created_at, updated_at, processed_at)
     VALUES ($1, 'internal', $4, $5, repeat('a', 64), $2, $3, 'r', 'g', 'OPENING', 100.00, 'BRL', 'PROCESSED', 100.00, now(), now(), now())`,
    [txId, walletId, playerId, `opening:${txId}`, `internal:opening:${txId}`],
  );
  await c.query(
    `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
     VALUES ($1, $2, $3, 'CREDIT', 100.00, 'BRL', 0, 100.00, 1, now())`,
    [uuidv7(), walletId, txId],
  );
  return { walletId, playerId, txId };
};

const committedSeed = async (): Promise<Seed> => {
  const client = await env.db.connect();
  try {
    await client.query('BEGIN');
    const seed = await seedWallet(client);
    await client.query('COMMIT');
    return seed;
  } finally {
    client.release();
  }
};

const insertTx = (c: PoolClient, s: Seed, fields: Partial<Record<string, string>> = {}) => {
  const id = fields.id ?? uuidv7();
  const ext = fields.ext ?? `ext-${id}`;
  return c.query(
    `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
       round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id, status, failure_code,
       created_at, updated_at, processed_at, next_reference_check_at)
     VALUES ($1, $2, $3, $4, repeat('a', 64), $5, $6, 'r', 'g', $7, $8, 'BRL', $9, $10, $11, $12, now(), now(), $13, $14)`,
    [
      id,
      fields.provider ?? 'provider-a',
      ext,
      fields.key ?? `provider-a:${ext}`,
      s.walletId,
      s.playerId,
      fields.kind ?? 'BET',
      fields.amount ?? '10.00',
      fields.refExt ?? null,
      fields.refId ?? null,
      fields.status ?? 'PROCESSED',
      fields.failure ?? null,
      (fields.status ?? 'PROCESSED') === 'PROCESSED' ? new Date() : null,
      fields.status === 'PENDING_REFERENCE' ? new Date() : null,
    ],
  );
};

describe('migrations', () => {
  test('are reversible (down then up again)', async () => {
    const orm = await MikroORM.init(buildOrmConfig(env.config.DATABASE_URL, 1));
    try {
      const migrator = orm.getMigrator();
      expect((await migrator.getPendingMigrations()).length).toBe(0);
      await migrator.down();
      const { rows } = await env.db.query(`SELECT to_regclass('public.wallets') AS t`);
      expect(rows[0].t).toBeNull();
      await migrator.up();
      expect((await migrator.getExecutedMigrations()).length).toBe(1);
    } finally {
      await orm.close(true);
    }
  });
});

describe('wallet constraints', () => {
  test('one wallet per (player, currency)', async () => {
    const seed = await committedSeed();
    const error = await failure((c) => c.query(`INSERT INTO wallets VALUES ($1, $2, 'BRL', 0, 1, now(), now())`, [uuidv7(), seed.playerId]));
    expect(error).toContain('wallets_player_id_currency_key');
    // another currency is fine
    await ok((c) => c.query(`INSERT INTO wallets VALUES ($1, $2, 'USD', 0, 1, now(), now())`, [uuidv7(), seed.playerId]));
  });

  test('balance can never be negative', async () => {
    const error = await failure((c) => c.query(`INSERT INTO wallets VALUES ($1, $2, 'BRL', -0.01, 1, now(), now())`, [uuidv7(), uuidv7()]));
    expect(error).toContain('check constraint');
  });

  test('a balance change without the matching ledger entry fails at COMMIT', async () => {
    const seed = await committedSeed();
    const error = await failure((c) => c.query(`UPDATE wallets SET balance = 90, version = 2 WHERE id = $1`, [seed.walletId]));
    expect(error).toContain('diverges from ledger head');
  });

  test('a balance change must bump the version (and the version only moves with the balance)', async () => {
    const seed = await committedSeed();
    expect(await failure((c) => c.query(`UPDATE wallets SET balance = 90 WHERE id = $1`, [seed.walletId]))).toContain('increment version');
    expect(await failure((c) => c.query(`UPDATE wallets SET version = 5 WHERE id = $1`, [seed.walletId]))).toContain('version may only change');
  });

  test('a wallet with funds but no ledger cannot be created', async () => {
    const error = await failure((c) => c.query(`INSERT INTO wallets VALUES ($1, $2, 'BRL', 50, 1, now(), now())`, [uuidv7(), uuidv7()]));
    expect(error).toContain('without ledger entries');
  });

  test('a consistent debit (transaction + entry + wallet) commits', async () => {
    const seed = await committedSeed();
    await ok(async (c) => {
      const id = uuidv7();
      await insertTx(c, seed, { id });
      await c.query(
        `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
         VALUES ($1, $2, $3, 'DEBIT', 10.00, 'BRL', 100.00, 90.00, 2, now())`,
        [uuidv7(), seed.walletId, id],
      );
      await c.query(`UPDATE wallets SET balance = 90, version = 2 WHERE id = $1`, [seed.walletId]);
    });
  });
});

describe('ledger constraints', () => {
  test('ledger rows are append-only (no UPDATE, DELETE or TRUNCATE)', async () => {
    const seed = await committedSeed();
    expect(await failure((c) => c.query(`UPDATE wallet_ledger_entries SET amount = 1 WHERE wallet_id = $1`, [seed.walletId]))).toContain('forbidden');
    expect(await failure((c) => c.query(`DELETE FROM wallet_ledger_entries WHERE wallet_id = $1`, [seed.walletId]))).toContain('forbidden');
    expect(await failure((c) => c.query(`TRUNCATE wallet_ledger_entries CASCADE`))).toContain('forbidden');
  });

  test('entries must be arithmetically balanced', async () => {
    const seed = await committedSeed();
    const error = await failure(async (c) => {
      const id = uuidv7();
      await insertTx(c, seed, { id });
      await c.query(
        `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
         VALUES ($1, $2, $3, 'DEBIT', 10.00, 'BRL', 100.00, 95.00, 2, now())`,
        [uuidv7(), seed.walletId, id],
      );
    });
    expect(error).toContain('wallet_ledger_entries_balanced');
  });

  test('entries must chain onto the previous one', async () => {
    const seed = await committedSeed();
    const error = await failure(async (c) => {
      const id = uuidv7();
      await insertTx(c, seed, { id });
      await c.query(
        `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
         VALUES ($1, $2, $3, 'DEBIT', 10.00, 'BRL', 50.00, 40.00, 2, now())`,
        [uuidv7(), seed.walletId, id],
      );
    });
    expect(error).toContain('ledger chain broken');
  });

  test('at most one entry per (transaction, wallet)', async () => {
    const seed = await committedSeed();
    const error = await failure((c) =>
      c.query(
        `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
         VALUES ($1, $2, $3, 'CREDIT', 1.00, 'BRL', 100.00, 101.00, 2, now())`,
        [uuidv7(), seed.walletId, seed.txId],
      ),
    );
    expect(error).toContain('wallet_ledger_entries_transaction_wallet_key');
  });
});

describe('transaction constraints', () => {
  test('idempotency key and (provider, external id) are unique', async () => {
    const seed = await committedSeed();
    await ok((c) => insertTx(c, seed, { ext: 'dup-ext', key: 'dup-key' }));
    expect(await failure((c) => insertTx(c, seed, { ext: 'other', key: 'dup-key' }))).toContain('wager_transactions_idempotency_key_key');
    expect(await failure((c) => insertTx(c, seed, { ext: 'dup-ext', key: 'other-key' }))).toContain('wager_transactions_provider_external_key');
  });

  test('a transaction can be reversed only once (REFUND or ROLLBACK)', async () => {
    const seed = await committedSeed();
    const betId = uuidv7();
    await ok((c) => insertTx(c, seed, { id: betId, ext: 'bet-x' }));
    await ok((c) => insertTx(c, seed, { kind: 'REFUND', refExt: 'bet-x', refId: betId }));
    const error = await failure((c) => insertTx(c, seed, { kind: 'ROLLBACK', refExt: 'bet-x', refId: betId }));
    expect(error).toContain('wager_transactions_single_reversal');
  });

  test('REFUND/ROLLBACK require a reference; OPENING is internal only; failure code iff REJECTED/FAILED', async () => {
    const seed = await committedSeed();
    expect(await failure((c) => insertTx(c, seed, { kind: 'REFUND' }))).toContain('wager_transactions_reference_required');
    expect(await failure((c) => insertTx(c, seed, { kind: 'OPENING' }))).toContain('wager_transactions_opening_internal');
    expect(await failure((c) => insertTx(c, seed, { status: 'REJECTED' }))).toContain('wager_transactions_failure_code');
  });

  test('terminal transactions are immutable and transactions are never deleted', async () => {
    const seed = await committedSeed();
    expect(await failure((c) => c.query(`UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'X' WHERE id = $1`, [seed.txId]))).toContain(
      'is terminal',
    );
    expect(await failure((c) => c.query(`DELETE FROM wager_transactions WHERE id = $1`, [seed.txId]))).toContain('forbidden');
  });

  test('business columns of a pending transaction are write-once', async () => {
    const seed = await committedSeed();
    const id = uuidv7();
    await ok((c) => insertTx(c, seed, { id, kind: 'REFUND', refExt: 'later', status: 'PENDING_REFERENCE' }));
    expect(await failure((c) => c.query(`UPDATE wager_transactions SET amount = 999 WHERE id = $1`, [id]))).toContain('immutable');
  });
});

describe('inbox / outbox constraints', () => {
  test('inbox is unique per (consumer, message)', async () => {
    await ok((c) => c.query(`INSERT INTO inbox_messages VALUES ('c1', 'm1', repeat('a', 64), now(), now())`));
    expect(await failure((c) => c.query(`INSERT INTO inbox_messages VALUES ('c1', 'm1', repeat('a', 64), now(), now())`))).toContain('duplicate key');
    await ok((c) => c.query(`INSERT INTO inbox_messages VALUES ('c2', 'm1', repeat('a', 64), now(), now())`));
  });

  test('an outbox event payload is immutable once written', async () => {
    const id = uuidv7();
    await ok((c) =>
      c.query(`INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at) VALUES ($1, $1, 'E', '{}', now(), now())`, [id]),
    );
    expect(await failure((c) => c.query(`UPDATE outbox_messages SET payload = '{"x":1}' WHERE id = $1`, [id]))).toContain('immutable');
    await ok((c) => c.query(`UPDATE outbox_messages SET attempts = 1 WHERE id = $1`, [id]));
  });
});
