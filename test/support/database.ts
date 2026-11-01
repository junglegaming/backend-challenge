import { expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { parseConfiguration } from "../../src/config/config";
import { TransactionContext } from "../../src/shared/application/unit-of-work";
import { Money } from "../../src/shared/domain/money";
import { Database } from "../../src/shared/infrastructure/database";
import { MikroOrmUnitOfWork, managerFor } from "../../src/shared/infrastructure/unit-of-work";
import { WalletBalanceChanged } from "../../src/wagering/domain/events";
import {
  WagerTransaction,
  WagerTransactionKind,
} from "../../src/wagering/domain/wager-transaction";
import { Wallet } from "../../src/wagering/domain/wallet";
import {
  SqlLedgerRepository,
  SqlWagerTransactionRepository,
  SqlWalletRepository,
} from "../../src/wagering/infrastructure/repositories";

export function testDatabase(overrides: { dbName?: string; referenceTtlMs?: number } = {}) {
  if (process.env.WAGERING_STACK_MANAGED !== "1")
    throw new Error("Use the declared stack suite script");
  const values = parseConfiguration({
    ...process.env,
    DB_HOST: "127.0.0.1",
    DB_PORT: process.env.POSTGRES_HOST_PORT ?? "15432",
    DB_NAME: overrides.dbName ?? "wagering",
    DB_USER: "wagering",
    DB_PASSWORD: process.env.POSTGRES_PASSWORD ?? "local-wagering-only",
    SQS_ENDPOINT: "http://127.0.0.1:14566",
    AWS_REGION: "us-east-1",
    AWS_ACCESS_KEY_ID: "local",
    AWS_SECRET_ACCESS_KEY: "local",
    AUTH_ISSUER: "http://keycloak:8080/realms/wagering",
    AUTH_JWKS_URL: "http://127.0.0.1:18080/realms/wagering/protocol/openid-connect/certs",
    ...(overrides.referenceTtlMs === undefined
      ? {}
      : { REFERENCE_TTL_MS: String(overrides.referenceTtlMs) }),
  });
  const database = new Database({ values });
  return { database, uow: new MikroOrmUnitOfWork(database), values };
}

// Manual repository/use-case tests must not race the stack's active workers.
// This uses the same real PostgreSQL server and versioned production migration.
export async function scratchDatabase(options: { referenceTtlMs?: number } = {}) {
  const admin = testDatabase();
  const orm = await admin.database.orm;
  const dbName = `fixture_${randomUUID().replaceAll("-", "")}`;
  await orm.em.getConnection().execute(`CREATE DATABASE ${dbName}`);
  const fixture = testDatabase({ dbName, ...options });
  try {
    await (await fixture.database.orm).migrator.up();
  } catch (error) {
    await fixture.database.onModuleDestroy();
    await orm.em.getConnection().execute(`DROP DATABASE ${dbName}`);
    await admin.database.onModuleDestroy();
    throw error;
  }
  return {
    ...fixture,
    cleanup: async () => {
      await fixture.database.onModuleDestroy();
      await orm.em.getConnection().execute(`DROP DATABASE ${dbName}`);
      await admin.database.onModuleDestroy();
    },
  };
}

export async function assertLedgerInvariant(
  database: Database,
  requested?: string | string[],
): Promise<void> {
  const orm = await database.orm;
  const walletIds = typeof requested === "string" ? [requested] : requested;
  if (walletIds?.length === 0) return;
  const rows = await orm.em.getConnection().execute<{ id: string; consistent: boolean }[]>(
    `WITH ordered AS (
        SELECT e.*, t.kind, row_number() OVER history AS position,
          lag(e.balance_after) OVER history AS previous_balance,
          lag(e.wallet_version) OVER history AS previous_version
        FROM wallet_ledger_entries e JOIN wager_transactions t ON t.id = e.transaction_id
        WINDOW history AS (PARTITION BY e.wallet_id ORDER BY e.wallet_version)
      ), histories AS (
        SELECT wallet_id, sum(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END) AS rebuilt,
          max(wallet_version) AS last_version,
          (array_agg(balance_after ORDER BY wallet_version DESC))[1] AS last_balance,
          bool_and(CASE WHEN position = 1 THEN balance_before = 0 AND wallet_version = CASE WHEN kind = 'OPENING' THEN 1 ELSE 2 END
            ELSE balance_before = previous_balance AND wallet_version = previous_version + 1 END) AS chain_valid
        FROM ordered GROUP BY wallet_id
      )
      SELECT w.id, (w.balance = COALESCE(h.rebuilt, 0) AND
        CASE WHEN h.wallet_id IS NULL THEN w.version = 1 AND w.balance = 0
          ELSE h.chain_valid AND w.version = h.last_version AND w.balance = h.last_balance END) AS consistent
      FROM wallets w LEFT JOIN histories h ON h.wallet_id = w.id
      ${walletIds ? `WHERE w.id IN (${walletIds.map(() => "?").join(",")})` : ""}`,
    walletIds ?? [],
  );
  if (walletIds) expect(new Set(rows.map((row) => row.id)).size).toBe(new Set(walletIds).size);
  for (const row of rows)
    expect(row.consistent, `ledger chain and balance invariant for ${row.id}`).toBe(true);
}

export async function insertRow(
  tx: TransactionContext,
  table: string,
  data: Record<string, unknown>,
): Promise<void> {
  const keys = Object.keys(data);
  await managerFor(tx).execute(
    `INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
    Object.values(data),
  );
}

export function rawWallet(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    player_id: randomUUID(),
    currency: "BRL",
    balance: "0.00",
    version: 1,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}
export function rawTransaction(
  walletId: string = randomUUID(),
  overrides: Record<string, unknown> = {},
) {
  return {
    id: randomUUID(),
    provider_id: "provider-a",
    external_transaction_id: randomUUID(),
    idempotency_key: randomUUID(),
    payload_hash: "a".repeat(64),
    wallet_id: walletId,
    player_id: randomUUID(),
    round_id: "round",
    game_id: "game",
    kind: "BET",
    amount: "1.00",
    currency: "BRL",
    status: "PENDING",
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

export async function seedOpening(tx: TransactionContext, amount = "100.00") {
  const now = new Date();
  const id = randomUUID();
  const transactionId = randomUUID();
  const { wallet, ledgerEntry } = Wallet.open({
    id,
    playerId: randomUUID(),
    initialBalance: Money.from({ amount, currency: "BRL" }),
    openingTransactionId: transactionId,
    openingEntryId: randomUUID(),
    at: now,
  });
  await new SqlWalletRepository().insert(tx, wallet);
  const transaction = WagerTransaction.create(
    {
      id: transactionId,
      providerId: "internal",
      externalTransactionId: id,
      idempotencyKey: id,
      payloadHash: "a".repeat(64),
      walletId: id,
      playerId: wallet.playerId,
      roundId: id,
      gameId: "opening",
      kind: WagerTransactionKind.Opening,
      money: wallet.balance,
      createdAt: now,
    },
    "internal",
  );
  if (ledgerEntry) {
    transaction.markProcessed(undefined, now, wallet.balance);
    await new SqlWagerTransactionRepository().insert(tx, transaction);
    await new SqlLedgerRepository().insert(tx, ledgerEntry);
  }
  return {
    wallet,
    transaction,
    ledgerEntry,
    event: ledgerEntry
      ? WalletBalanceChanged.from(wallet, ledgerEntry, {
          eventId: randomUUID(),
          correlationId: randomUUID(),
          occurredAt: now,
        })
      : undefined,
  };
}
