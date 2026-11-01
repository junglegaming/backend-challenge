import type { EventEmitter } from "node:events";
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

type BorrowedClient = EventEmitter & { release(error?: Error | boolean): void };

function discardBrokenClients(pool: EventEmitter) {
  const handlers = new WeakMap<BorrowedClient, (error: Error) => void>();
  pool.on("acquire", (client: BorrowedClient) => {
    const discard = (error: Error) => {
      // Kysely 0.29 controlled transactions retain a checkout if both COMMIT
      // and ROLLBACK fail. A fatal connection must leave the pool immediately.
      const release = client.release;
      client.release = () => {};
      release(error);
    };
    handlers.set(client, discard);
    client.once("error", discard);
  });
  pool.on("release", (_error: Error | undefined, client: BorrowedClient) => {
    const handler = handlers.get(client);
    if (handler) client.removeListener("error", handler);
    handlers.delete(client);
  });
}

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
    driverOptions: { onPoolCreated: discardBrokenClients },
    debug: false,
  });
}
