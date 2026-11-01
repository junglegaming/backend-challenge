import { Migrator } from "@mikro-orm/migrations";
import { defineConfig } from "@mikro-orm/postgresql";
import { Migration202610310001 } from "./database/migrations/Migration202610310001";
import { parseConfiguration } from "./src/config/config";
import { InboxSchema, OutboxSchema } from "./src/messaging/infrastructure/records";
import {
  LedgerSchema,
  WagerTransactionSchema,
  WalletSchema,
} from "./src/wagering/infrastructure/records";

export function databaseOptions(database: ReturnType<typeof parseConfiguration>["database"]) {
  return defineConfig({
    ...database,
    entities: [WalletSchema, WagerTransactionSchema, LedgerSchema, InboxSchema, OutboxSchema],
    extensions: [Migrator],
    migrations: {
      migrationsList: [Migration202610310001],
      transactional: true,
      allOrNothing: true,
      snapshotOnMigrate: false,
      emit: "ts",
    },
    pool: { min: 0, max: 10 },
    debug: false,
  });
}
