import { buildCore, type Core, type CoreConfig } from "../../src/composition/core";
import type { SubmitWagerCommand } from "../../src/modules/wagering/application/process-wager-transaction";
import type { ExternalWagerKind } from "../../src/modules/wagering/domain/wager-transaction-kind";
import { type AppLogger, type AppMetrics, noopMetrics } from "../../src/shared/application/observability";
import { createTestDatabase, type TestDatabase } from "./test-db";

export const silentLogger: AppLogger = { debug() {}, info() {}, warn() {}, error() {} };

export function coreConfig(db: TestDatabase, overrides: Partial<CoreConfig> = {}): CoreConfig {
  return {
    DATABASE_URL: db.appUrl,
    DB_POOL_MIN: 0,
    DB_POOL_MAX: 20,
    DB_LOCK_TIMEOUT_MS: 5000,
    DB_STATEMENT_TIMEOUT_MS: 10_000,
    DB_TX_MAX_ATTEMPTS: 5,
    PENDING_REF_BASE_MS: 50,
    PENDING_REF_MAX_MS: 200,
    PENDING_REF_MAX_ATTEMPTS: 3,
    PENDING_REF_BATCH_SIZE: 50,
    PENDING_REF_LEASE_MS: 5000,
    SUPPORTED_CURRENCIES: ["BRL", "USD", "EUR"],
    ...overrides,
  };
}

export interface CoreHarness {
  db: TestDatabase;
  core: Core;
  close(): Promise<void>;
}

export async function startCore(
  overrides: Partial<CoreConfig> = {},
  deps: { metrics?: AppMetrics; logger?: AppLogger } = {},
): Promise<CoreHarness> {
  const db = await createTestDatabase();
  const core = await buildCore(coreConfig(db, overrides), {
    logger: deps.logger ?? silentLogger,
    metrics: deps.metrics ?? noopMetrics,
  });
  return {
    db,
    core,
    close: async () => {
      await core.close();
      await db.drop();
    },
  };
}

let seq = 0;
export const uniq = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++seq}`;

export function wagerCommand(
  wallet: { id: string; playerId: string },
  kind: ExternalWagerKind,
  amount: string,
  overrides: Partial<SubmitWagerCommand> = {},
): SubmitWagerCommand {
  const providerId = overrides.providerId ?? "provider-a";
  const externalTransactionId = overrides.externalTransactionId ?? uniq("ext");
  return {
    providerId,
    externalTransactionId,
    idempotencyKey: overrides.idempotencyKey ?? `${providerId}:${externalTransactionId}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind,
    money: { amount, currency: "BRL" },
    channel: "http",
    correlationId: uniq("corr"),
    ...overrides,
  };
}

export const newPlayerId = () => Bun.randomUUIDv7();
