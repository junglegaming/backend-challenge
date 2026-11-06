import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/shared/money';
import { WalletRecord } from '../../src/infrastructure/persistence/entities/records';
import { type TestDatabase, createTestDatabase } from './support/test-database';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});

const wallet = (balance: unknown): WalletRecord =>
  Object.assign(new WalletRecord(), {
    id: randomUUID(),
    playerId: randomUUID(),
    currency: 'BRL',
    balance,
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

describe('MoneyAmountType through MikroORM against PostgreSQL', () => {
  test('persists and reloads decimal strings exactly (including values float cannot represent)', async () => {
    for (const amount of ['0.10', '0.30', '12345678901234567.89', '999999999999999999.99', '0.00']) {
      const record = wallet(amount);
      const em = db.orm.em.fork();
      em.persist(record);
      await em.flush();

      const loaded = await db.orm.em.fork().findOneOrFail(WalletRecord, { id: record.id });
      expect(typeof loaded.balance).toBe('string');
      expect(loaded.balance).toBe(amount);
      expect(Money.from({ amount: loaded.balance, currency: loaded.currency }).toString()).toBe(amount);

      const [raw] = await db.run<{ balance: string }>('select balance from wallets where id = ?', [record.id]);
      expect(raw!.balance).toBe(amount);
    }
  });

  test('Money values are written through the type as scale-2 strings', async () => {
    const record = wallet(Money.from({ amount: '7.5', currency: 'BRL' }));
    const em = db.orm.em.fork();
    em.persist(record);
    await em.flush();
    const [raw] = await db.run<{ balance: string }>('select balance from wallets where id = ?', [record.id]);
    expect(raw!.balance).toBe('7.50');
  });

  test('a JS number never reaches the database', async () => {
    for (const bad of [0.1, 25, Number.NaN]) {
      const em = db.orm.em.fork();
      em.persist(wallet(bad));
      await expect(em.flush()).rejects.toThrow(TypeError);
    }
  });

  test('a negative balance written through the ORM is still stopped by the database CHECK', async () => {
    const em = db.orm.em.fork();
    em.persist(wallet('-1.00'));
    await expect(em.flush()).rejects.toMatchObject({ code: '23514', constraint: 'wallets_balance_non_negative_ck' });
  });

  test('columns are numeric(20,2) / char(3) in the real schema', async () => {
    const rows = await db.run<{ table_name: string; column_name: string; data_type: string; numeric_scale: number | null }>(
      `select table_name, column_name, data_type, numeric_scale from information_schema.columns
        where table_schema = 'public'
          and (column_name in ('balance','amount','balance_before','balance_after','balance_snapshot') or column_name = 'currency')`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      if (r.column_name === 'currency') expect(r.data_type).toBe('character');
      else {
        expect(r.data_type).toBe('numeric');
        expect(Number(r.numeric_scale)).toBe(2);
      }
    }
  });
});
