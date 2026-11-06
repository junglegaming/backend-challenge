import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { buildOrmConfig } from '../../../src/infrastructure/persistence/mikro-orm.config';

const baseUrl = process.env.DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5432/wagering';

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

export interface TestDatabase {
  orm: MikroORM;
  url: string;
  queries: string[];
  run<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  drop(): Promise<void>;
}

/**
 * Each suite gets its own database, migrated from scratch: the ledger is append-only
 * (no DELETE/TRUNCATE), so cleaning up is done by dropping the whole database.
 */
export async function createTestDatabase(options: { migrate?: boolean } = {}): Promise<TestDatabase> {
  const name = `wagering_test_${randomUUID().replaceAll('-', '')}`;
  const admin = await MikroORM.init({
    clientUrl: withDatabase(baseUrl, 'postgres'),
    entities: [],
    discovery: { warnWhenNoEntities: false },
  });
  await admin.em.getConnection().execute(`create database ${name}`);
  await admin.close();

  const url = withDatabase(baseUrl, name);
  const queries: string[] = [];
  const orm = await MikroORM.init({
    ...buildOrmConfig(url),
    debug: ['query'],
    colors: false,
    logger: (message: string) => queries.push(message),
  });
  if (options.migrate ?? true) await orm.migrator.up();
  queries.length = 0;

  return {
    orm,
    url,
    queries,
    run: (sql, params = []) => orm.em.getConnection().execute(sql, params) as Promise<never[]>,
    async drop() {
      await orm.close();
      const cleaner = await MikroORM.init({
        clientUrl: withDatabase(baseUrl, 'postgres'),
        entities: [],
        discovery: { warnWhenNoEntities: false },
      });
      await cleaner.em.getConnection().execute(`drop database if exists ${name} with (force)`);
      await cleaner.close();
    },
  };
}
