import { Migrator } from "@mikro-orm/migrations";
import { defineConfig, type Options, PostgreSqlDriver } from "@mikro-orm/postgresql";
import type { AppConfig } from "../config/config";
import { ALL_SCHEMAS } from "./entities";
import { Migration20261112000000Initial } from "./migrations/Migration20261112000000Initial";

/**
 * MikroORM configuration.
 *
 * Migrations are listed explicitly (instead of discovered from disk) so they
 * work the same way under Bun, in tests and inside the Docker image.
 */
export function buildOrmConfig(config: AppConfig): Options {
  return defineConfig({
    driver: PostgreSqlDriver,
    host: config.database.host,
    port: config.database.port,
    dbName: config.database.name,
    user: config.database.user,
    password: config.database.password,
    entities: ALL_SCHEMAS,
    pool: { min: 0, max: config.database.poolMax },
    debug: false,
    allowGlobalContext: false,
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    migrations: {
      transactional: true,
      allOrNothing: true,
      migrationsList: [{ name: "Migration20261112000000Initial", class: Migration20261112000000Initial }],
    },
  });
}

