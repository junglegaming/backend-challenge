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

export function testDatabase() {
  if (process.env.WAGERING_STACK_MANAGED !== "1")
    throw new Error("Use the declared stack suite script");
  const values = parseConfiguration({
    ...process.env,
    DB_HOST: "127.0.0.1",
    DB_PORT: process.env.POSTGRES_HOST_PORT ?? "15432",
    DB_NAME: "wagering",
    DB_USER: "wagering",
    DB_PASSWORD: process.env.POSTGRES_PASSWORD ?? "local-wagering-only",
    SQS_ENDPOINT: "http://127.0.0.1:14566",
    AWS_REGION: "us-east-1",
    AWS_ACCESS_KEY_ID: "local",
    AWS_SECRET_ACCESS_KEY: "local",
    AUTH_ISSUER: "http://keycloak:8080/realms/wagering",
    AUTH_JWKS_URL: "http://127.0.0.1:18080/realms/wagering/protocol/openid-connect/certs",
  });
  const database = new Database({ values });
  return { database, uow: new MikroOrmUnitOfWork(database), values };
}

export async function assertLedgerInvariant(database: Database, walletId?: string): Promise<void> {
  const orm = await database.orm;
  const rows = await orm.em
    .getConnection()
    .execute<{ id: string; balance: string; rebuilt: string }[]>(
      `SELECT w.id, w.balance::text, COALESCE(sum(CASE WHEN e.direction = 'CREDIT' THEN e.amount ELSE -e.amount END),0)::numeric(18,2)::text AS rebuilt
     FROM wallets w LEFT JOIN wallet_ledger_entries e ON e.wallet_id = w.id
     ${walletId ? "WHERE w.id = ?" : ""} GROUP BY w.id`,
      walletId ? [walletId] : [],
    );
  for (const row of rows) expect(row.balance, `ledger invariant for ${row.id}`).toBe(row.rebuilt);
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
