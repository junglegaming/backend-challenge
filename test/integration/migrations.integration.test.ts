import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { buildOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';

const url = process.env.DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5432/wagering';
let orm: MikroORM;

const hasForbidMutation = async () =>
  (await orm.em.getConnection().execute("select 1 from pg_proc where proname = 'forbid_mutation'")).length === 1;

describe('migrations (real PostgreSQL)', () => {
  beforeAll(async () => {
    orm = await MikroORM.init(buildOrmConfig(url));
  });

  afterAll(async () => {
    await orm.migrator.up();
    await orm.close();
  });

  test('are reversible and re-appliable', async () => {
    await orm.migrator.up();
    expect(await hasForbidMutation()).toBe(true);

    await orm.migrator.down({ to: 0 });
    expect(await hasForbidMutation()).toBe(false);

    await orm.migrator.up();
    expect(await hasForbidMutation()).toBe(true);
    expect(await orm.migrator.getPending()).toHaveLength(0);
  });
});
