import { Migrator } from "@mikro-orm/migrations";
import { defineConfig } from "@mikro-orm/postgresql";
import { ALL_ENTITIES } from "./entities";
import { MIGRATIONS } from "./migrations";

export interface OrmConnectionOptions {
  url: string;
  poolMin?: number;
  poolMax?: number;
  statementTimeoutMs?: number;
  debug?: boolean;
}

export function buildOrmConfig(opts: OrmConnectionOptions) {
  return defineConfig({
    clientUrl: opts.url,
    entities: ALL_ENTITIES,
    extensions: [Migrator],
    // Every unit of work must fork its own EntityManager; the global one is never used implicitly.
    allowGlobalContext: false,
    implicitTransactions: false,
    debug: opts.debug ?? false,
    pool: { min: opts.poolMin ?? 2, max: opts.poolMax ?? 10, idleTimeoutMillis: 30_000 },
    driverOptions: {
      // Defence in depth: no single statement may hold a connection forever.
      statement_timeout: opts.statementTimeoutMs ?? 5_000,
      application_name: "wagering-processor",
    },
    migrations: {
      tableName: "schema_migrations",
      migrationsList: MIGRATIONS,
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      emit: "ts",
    },
    discovery: { warnWhenNoEntities: true },
  });
}
