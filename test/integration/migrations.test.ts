import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { InitialSchema1710000000000 } from '../../src/database/migrations/1710000000000-InitialSchema';
import { FixLedgerInvariant1710000000001 } from '../../src/database/migrations/1710000000001-FixLedgerInvariant';

describe('PostgreSQL migrations (isolated schema)', () => {
  const schema = `migration_test_${randomUUID().replaceAll('-', '')}`;
  let admin: DataSource;
  let migrated: DataSource;
  beforeAll(async () => {
    if (!process.env.DATABASE_URL)
      throw new Error('Set DATABASE_URL before migration integration tests');
    admin = new DataSource({ type: 'postgres', url: process.env.DATABASE_URL });
    await admin.initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    migrated = new DataSource({
      type: 'postgres',
      url: process.env.DATABASE_URL,
      schema,
      migrationsTableName: 'typeorm_migrations',
      migrations: [InitialSchema1710000000000, FixLedgerInvariant1710000000001],
      extra: { options: `-c search_path=${schema}` },
    });
    await migrated.initialize();
  });
  afterAll(async () => {
    if (migrated?.isInitialized) await migrated.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  });
  test('applies both migrations and reverts them in reverse order', async () => {
    const applied = await migrated.runMigrations();
    expect(applied.map((m) => m.name)).toEqual([
      'InitialSchema1710000000000',
      'FixLedgerInvariant1710000000001',
    ]);
    const tables = await migrated.query(
      `SELECT to_regclass($1) AS wallets,to_regclass($2) AS ledger,to_regclass($3) AS outbox`,
      [`${schema}.wallets`, `${schema}.wallet_ledger_entries`, `${schema}.outbox_messages`],
    );
    expect(tables[0].wallets).toBeTruthy();
    expect(tables[0].ledger).toBeTruthy();
    expect(tables[0].outbox).toBeTruthy();
    await migrated.undoLastMigration();
    const oneLeft = await migrated.query(
      `SELECT name FROM "${schema}".typeorm_migrations ORDER BY id`,
    );
    expect(oneLeft.map((m: { name: string }) => m.name)).toEqual(['InitialSchema1710000000000']);
    await migrated.undoLastMigration();
    const afterDown = await migrated.query(
      `SELECT to_regclass($1) AS wallets,to_regclass($2) AS outbox`,
      [`${schema}.wallets`, `${schema}.outbox_messages`],
    );
    expect(afterDown[0].wallets).toBeNull();
    expect(afterDown[0].outbox).toBeNull();
  }, 30_000);
});
