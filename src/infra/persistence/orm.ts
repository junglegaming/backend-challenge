import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, PostgreSqlDriver } from '@mikro-orm/postgresql';
import { config } from '../../config';
import { Migration20261119000000_init } from './migrations/Migration20261119000000_init';
import { records } from './records';

export const ormConfig = (clientUrl = config.databaseUrl) =>
  defineConfig({
    driver: PostgreSqlDriver,
    clientUrl,
    entities: records,
    extensions: [Migrator],
    // Lista explícita: sem descoberta por glob, o mesmo comportamento em Bun, testes e container.
    migrations: { snapshot: false, migrationsList: [{ name: 'Migration20261119000000_init', class: Migration20261119000000_init }] },
    pool: { min: 2, max: 20 },
  });
