import { MikroORM } from "@mikro-orm/postgresql";
import { type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../../src/app.module";
import { type AppConfig, type AppRole, loadConfig } from "../../src/config/config";
import { TransactionRunner } from "../../src/database/transaction-runner";
import { ReconcileWalletUseCase } from "../../src/application/reconcile-wallet.use-case";
import { NestPinoLogger } from "../../src/observability/logger";

export interface TestAppInstance {
  app: INestApplication;
  baseUrl: string;
  config: AppConfig;
  orm: MikroORM;
  txRunner: TransactionRunner;
  close: () => Promise<void>;
}

/**
 * Boots a real NestJS instance connected to the real PostgreSQL and MiniStack
 * containers. By default background polling loops (`consumer`, `outbox`,
 * `pending-ref`) are disabled unless requested via `roles`, so tests can drive
 * ticks deterministically or spin up full multi-role instances when needed.
 */
export async function createTestApp(overrides?: {
  roles?: AppRole[];
  instanceId?: string;
  maxReceiveCount?: number;
  pendingRefMaxAttempts?: number;
  pendingRefBaseDelayMs?: number;
  lockTimeoutMs?: number;
  outboxLeaseMs?: number;
}): Promise<TestAppInstance> {
  const base = loadConfig({
    ...process.env,
    NODE_ENV: "test",
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? "silent",
    APP_ROLES: (overrides?.roles ?? ["api"]).join(","),
    INSTANCE_ID: overrides?.instanceId ?? `test-${Math.random().toString(36).slice(2, 8)}`,
    ...(overrides?.maxReceiveCount ? { SQS_MAX_RECEIVE_COUNT: String(overrides.maxReceiveCount) } : {}),
    ...(overrides?.pendingRefMaxAttempts
      ? { PENDING_REF_MAX_ATTEMPTS: String(overrides.pendingRefMaxAttempts) }
      : {}),
    ...(overrides?.pendingRefBaseDelayMs
      ? { PENDING_REF_BASE_DELAY_MS: String(overrides.pendingRefBaseDelayMs) }
      : {}),
    ...(overrides?.lockTimeoutMs ? { LOCK_TIMEOUT_MS: String(overrides.lockTimeoutMs) } : {}),
    ...(overrides?.outboxLeaseMs ? { OUTBOX_LEASE_MS: String(overrides.outboxLeaseMs) } : {}),
  });

  const app = await NestFactory.create(AppModule.register(base), {
    logger: new NestPinoLogger(),
  });
  app.enableShutdownHooks();
  await app.listen(0, "127.0.0.1");

  const server = app.getHttpServer() as { address: () => { port: number } };
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    app,
    baseUrl,
    config: base,
    orm: app.get(MikroORM),
    txRunner: app.get(TransactionRunner),
    close: async () => {
      await app.close();
    },
  };
}

/**
 * Truncates all tables cleanly between test suites (temporarily disabling the
 * append-only triggers via session_replication_role = replica, then restoring).
 */
export async function resetDatabase(orm: MikroORM): Promise<void> {
  const em = orm.em.fork();
  await em.transactional(async (tx) => {
    await tx.execute("SET LOCAL session_replication_role = 'replica'");
    await tx.execute(
      "TRUNCATE TABLE outbox_messages, inbox_messages, wallet_ledger_entries, wager_transactions, wallets RESTART IDENTITY CASCADE",
    );
  });
}

/**
 * Asserts the global invariant required by Section 13 of the challenge:
 * for every wallet in the database, `wallet.balance == ledger reconstructed balance`.
 */
export async function assertAllWalletsReconciled(instance: TestAppInstance): Promise<void> {
  const rows = await instance.orm.em
    .fork()
    .execute<{ id: string }[]>("SELECT id FROM wallets ORDER BY created_at ASC");
  const reconciler = instance.app.get(ReconcileWalletUseCase);

  for (const row of rows) {
    const res = await reconciler.execute(row.id);
    if (!res.consistent) {
      throw new Error(
        `Invariant violation on wallet ${row.id}: stored=${res.storedBalance.amount}, ledger=${res.calculatedBalance.amount}, diff=${res.difference.amount}`,
      );
    }
  }
}

