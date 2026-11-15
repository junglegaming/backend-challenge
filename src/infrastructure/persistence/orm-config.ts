import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, type Options, PostgreSqlDriver } from '@mikro-orm/postgresql';
import { ENTITY_SCHEMAS } from './entities/records';
import { Migration20261114000001_initial_schema } from './migrations/Migration20261114000001_initial_schema';

/**
 * Migrations are registered explicitly (no glob discovery), which keeps them
 * working identically under Bun, in tests and inside the container image.
 */
export const MIGRATIONS = [
  { name: 'Migration20261114000001_initial_schema', class: Migration20261114000001_initial_schema },
];

export const buildOrmConfig = (databaseUrl: string, poolMax = 20): Options =>
  defineConfig({
    driver: PostgreSqlDriver,
    clientUrl: databaseUrl,
    entities: ENTITY_SCHEMAS,
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    pool: { min: 0, max: poolMax },
    // dates are timestamptz, always UTC on the wire
    forceUtcTimezone: true,
    allowGlobalContext: false,
    debug: false,
    migrations: {
      tableName: 'mikro_orm_migrations',
      migrationsList: MIGRATIONS,
      transactional: true,
      allOrNothing: true,
      silent: true,
    },
  });
