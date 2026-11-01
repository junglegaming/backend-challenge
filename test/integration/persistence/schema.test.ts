import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { MikroORM } from "@mikro-orm/postgresql";
import { databaseOptions } from "../../../mikro-orm.config";
import { TransactionContext } from "../../../src/shared/application/unit-of-work";
import { managerFor } from "../../../src/shared/infrastructure/unit-of-work";
import {
  assertLedgerInvariant,
  insertRow,
  rawTransaction,
  rawWallet,
  seedOpening,
  testDatabase,
} from "../../support/database";

const { database, uow, values } = testDatabase();
beforeAll(async () => {
  await database.orm;
});
afterEach(async () => {
  await assertLedgerInvariant(database);
});
afterAll(async () => {
  await database.onModuleDestroy();
});

async function violates(constraint: string, work: (tx: TransactionContext) => Promise<void>) {
  let actual: string | undefined;
  try {
    await uow.run(work);
  } catch (error) {
    actual =
      (error as { constraint?: string; cause?: { constraint?: string } }).constraint ??
      (error as { cause?: { constraint?: string } }).cause?.constraint;
  }
  expect(actual).toBe(constraint);
}

test("migration up, down, up works on an isolated scratch database", async () => {
  const admin = await database.orm;
  const dbName = `migration_${randomUUID().replaceAll("-", "")}`;
  await admin.em.getConnection().execute(`CREATE DATABASE ${dbName}`);
  try {
    const scratch = await MikroORM.init(databaseOptions({ ...values.database, dbName }));
    try {
      await scratch.migrator.up();
      expect(await scratch.em.getConnection().execute("SELECT * FROM wallets")).toEqual([]);
      await scratch.migrator.down({ to: 0 });
      const absent = await scratch.em
        .getConnection()
        .execute<{ name: string | null }[]>("SELECT to_regclass('wallets') AS name");
      expect(absent[0]?.name).toBeNull();
      await scratch.migrator.up();
      expect(
        await scratch.em.getConnection().execute("SELECT * FROM wallet_ledger_entries"),
      ).toEqual([]);
    } finally {
      await scratch.close(true);
    }
  } finally {
    await admin.em.getConnection().execute(`DROP DATABASE ${dbName}`);
  }
}, 30_000);

for (const [constraint, overrides] of [
  ["ck_wallets_balance_non_negative", { balance: "-0.01" }],
  ["ck_wallets_player_length", { player_id: "" }],
  ["ck_wallets_currency", { currency: "brl" }],
  ["ck_wallets_version", { version: 0 }],
] as const)
  test(`wallet constraint ${constraint}`, async () => {
    await violates(constraint, (tx) => insertRow(tx, "wallets", rawWallet(overrides)));
  });

test("wallet player/currency unique pair is enforced", async () => {
  await violates("uq_wallets_player_currency", async (tx) => {
    const wallet = rawWallet();
    await insertRow(tx, "wallets", wallet);
    await insertRow(tx, "wallets", { ...wallet, id: randomUUID() });
  });
});

for (const [constraint, overrides] of [
  ["ck_wager_opening_internal", { kind: "OPENING" }],
  ["ck_wager_opening_internal", { provider_id: "internal" }],
  ["ck_wager_reference_required", { kind: "REFUND" }],
  ["ck_wager_reference_required", { kind: "ROLLBACK" }],
  ["ck_wager_reference_forbidden", { reference_external_transaction_id: "ref" }],
  [
    "ck_wager_reference_forbidden",
    { kind: "OPENING", provider_id: "internal", reference_external_transaction_id: "ref" },
  ],
  ["ck_wager_failure_code", { status: "REJECTED" }],
  ["ck_wager_failure_code", { status: "FAILED" }],
  ["ck_wager_failure_code", { failure_code: "WRONG" }],
  ["ck_wager_processed", { status: "PROCESSED" }],
  [
    "ck_wager_positive_when_moving",
    {
      status: "PROCESSED",
      processed_at: new Date(),
      observed_balance: "0.00",
      observed_currency: "BRL",
      amount: "0.00",
    },
  ],
  ["ck_wager_observed_pair", { observed_balance: "0.00" }],
  ["ck_wager_observed_pair", { observed_currency: "BRL" }],
  ["ck_wager_pending_schedule", { status: "PENDING_REFERENCE" }],
  ["ck_wager_kind", { kind: "INVALID" }],
  ["ck_wager_status", { status: "INVALID" }],
  ["ck_wager_amount", { amount: "-0.01" }],
  ["ck_wager_currency", { currency: "brl" }],
  ["ck_wager_observed_non_negative", { observed_balance: "-0.01", observed_currency: "BRL" }],
  ["ck_wager_reference_attempts", { reference_attempts: -1 }],
] as const)
  test(`transaction constraint ${constraint}: ${Object.keys(overrides).join(",")}`, async () => {
    await violates(constraint, (tx) =>
      insertRow(tx, "wager_transactions", rawTransaction(undefined, overrides)),
    );
  });

for (const [constraint, field] of [
  ["uq_wager_transactions_provider_key", "idempotency_key"],
  ["uq_wager_transactions_provider_external", "external_transaction_id"],
] as const)
  test(`transaction uniqueness ${constraint}`, async () => {
    await violates(constraint, async (tx) => {
      const row = rawTransaction();
      await insertRow(tx, "wager_transactions", row);
      await insertRow(tx, "wager_transactions", rawTransaction(undefined, { [field]: row[field] }));
    });
  });

function ledgerRow(
  walletId: string,
  transactionId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: randomUUID(),
    wallet_id: walletId,
    transaction_id: transactionId,
    wallet_version: 2,
    direction: "CREDIT",
    amount: "1.00",
    currency: "BRL",
    balance_before: "100.00",
    balance_after: "101.00",
    created_at: new Date(),
    ...overrides,
  };
}

for (const [constraint, overrides] of [
  ["ck_ledger_arithmetic", { balance_after: "102.00" }],
  ["ck_ledger_version", { wallet_version: 0 }],
  // PostgreSQL evaluates named CHECKs alphabetically; invalid direction violates
  // both checks, so the earlier arithmetic check is the reported constraint.
  ["ck_ledger_arithmetic", { direction: "OTHER" }],
  ["ck_ledger_amount", { amount: "0.00", balance_after: "100.00" }],
  ["ck_ledger_before_non_negative", { balance_before: "-1.00", balance_after: "0.00" }],
  [
    "ck_ledger_after_non_negative",
    { direction: "DEBIT", balance_before: "0.00", balance_after: "-1.00" },
  ],
  ["fk_ledger_wallet_currency", { currency: "USD" }],
  ["uq_ledger_wallet_transaction", { wallet_version: 2, reuseTransaction: true }],
  ["uq_ledger_wallet_version", { wallet_version: 1 }],
] as const)
  test(`ledger constraint ${constraint}: ${Object.keys(overrides).join(",")}`, async () => {
    await violates(constraint, async (tx) => {
      const { wallet, transaction } = await seedOpening(tx);
      const other = rawTransaction(wallet.id);
      await insertRow(tx, "wager_transactions", other);
      const { reuseTransaction, ...columns } = overrides as Record<string, unknown>;
      await insertRow(
        tx,
        "wallet_ledger_entries",
        ledgerRow(wallet.id, reuseTransaction ? transaction.id : String(other.id), columns),
      );
    });
  });

test("ledger cannot refer to a transaction from another wallet", async () => {
  await violates("fk_ledger_transaction_wallet", async (tx) => {
    const { wallet } = await seedOpening(tx);
    const other = rawTransaction();
    await insertRow(tx, "wager_transactions", other);
    await insertRow(tx, "wallet_ledger_entries", ledgerRow(wallet.id, String(other.id)));
  });
});

test("a single processed reversal is enforced across REFUND and ROLLBACK, rejected reversals coexist", async () => {
  await violates("uq_wager_single_processed_reversal", async (tx) => {
    const reference = rawTransaction();
    await insertRow(tx, "wager_transactions", reference);
    const reversal = {
      kind: "REFUND",
      reference_external_transaction_id: reference.external_transaction_id,
      reference_transaction_id: reference.id,
      status: "PROCESSED",
      processed_at: new Date(),
      observed_balance: "1.00",
      observed_currency: "BRL",
    };
    await insertRow(tx, "wager_transactions", rawTransaction(undefined, reversal));
    await insertRow(
      tx,
      "wager_transactions",
      rawTransaction(undefined, {
        ...reversal,
        kind: "ROLLBACK",
        status: "REJECTED",
        failure_code: "REFERENCE_ALREADY_REVERSED",
      }),
    );
    const rows = await managerFor(tx).execute<{ count: number }[]>(
      "SELECT count(*)::int AS count FROM wager_transactions WHERE reference_transaction_id = ?",
      [reference.id],
    );
    expect(rows[0]?.count).toBe(2);
    await insertRow(
      tx,
      "wager_transactions",
      rawTransaction(undefined, { ...reversal, kind: "ROLLBACK" }),
    );
  });
});

test("inbox has a composite primary key", async () => {
  await violates("pk_inbox_messages", async (tx) => {
    const row = {
      consumer_name: "test",
      message_id: randomUUID(),
      payload_hash: "a".repeat(64),
      received_at: new Date(),
    };
    await insertRow(tx, "inbox_messages", row);
    await insertRow(tx, "inbox_messages", row);
  });
});

test("outbox attempts cannot be negative", async () => {
  await violates("ck_outbox_attempts", (tx) =>
    insertRow(tx, "outbox_messages", {
      id: randomUUID(),
      aggregate_id: "test",
      event_type: "test",
      payload: "{}",
      occurred_at: new Date(),
      next_attempt_at: new Date(),
      attempts: -1,
    }),
  );
});

for (const operation of [
  "UPDATE wallet_ledger_entries SET amount = amount",
  "DELETE FROM wallet_ledger_entries",
  "TRUNCATE wallet_ledger_entries",
])
  test(`owner cannot mutate ledger: ${operation.split(" ")[0]}`, async () => {
    await violates("ck_ledger_immutable", async (tx) => {
      await seedOpening(tx);
      const owner = await managerFor(tx).execute<{ same: boolean }[]>(
        "SELECT tableowner = current_user AS same FROM pg_tables WHERE tablename = 'wallet_ledger_entries'",
      );
      expect(owner[0]?.same).toBe(true);
      await managerFor(tx).execute(operation);
    });
  });

for (const status of ["PROCESSED", "REJECTED", "FAILED"])
  test(`terminal ${status} transaction cannot change`, async () => {
    await violates("ck_wager_terminal", async (tx) => {
      const row = rawTransaction(undefined, {
        status,
        failure_code: status === "PROCESSED" ? null : "TEST",
        processed_at: new Date(),
        observed_balance: "0.00",
        observed_currency: "BRL",
      });
      await insertRow(tx, "wager_transactions", row);
      await managerFor(tx).execute(
        "UPDATE wager_transactions SET status = 'PENDING' WHERE id = ?",
        [row.id],
      );
    });
  });

for (const operation of ["DELETE FROM wager_transactions", "TRUNCATE wager_transactions CASCADE"])
  test(`transactions cannot be removed: ${operation.split(" ")[0]}`, async () => {
    await violates("ck_wager_immutable", async (tx) => {
      await insertRow(tx, "wager_transactions", rawTransaction());
      await managerFor(tx).execute(operation);
    });
  });

for (const [column, value] of Object.entries({
  id: randomUUID(),
  provider_id: "provider-b",
  external_transaction_id: "changed",
  idempotency_key: "changed",
  payload_hash: "b".repeat(64),
  wallet_id: randomUUID(),
  player_id: "changed",
  round_id: "changed",
  game_id: "changed",
  kind: "WIN",
  amount: "2.00",
  currency: "USD",
  reference_external_transaction_id: "changed",
  reference_deadline_at: new Date(),
  created_at: new Date("2020-01-01T00:00:00Z"),
}))
  test(`business column ${column} cannot change`, async () => {
    await violates("ck_wager_business_immutable", async (tx) => {
      const row = rawTransaction();
      await insertRow(tx, "wager_transactions", row);
      await managerFor(tx).execute(`UPDATE wager_transactions SET ${column} = ? WHERE id = ?`, [
        value,
        row.id,
      ]);
    });
  });

test("pending and outbox due indexes exist with their partial predicates", async () => {
  await uow.run(async (tx) => {
    const rows = await managerFor(tx).execute<{ indexname: string; indexdef: string }[]>(
      "SELECT indexname, indexdef FROM pg_indexes WHERE indexname IN ('ix_wager_pending_due', 'ix_outbox_due')",
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.indexname === "ix_wager_pending_due")?.indexdef).toContain(
      "PENDING_REFERENCE",
    );
    expect(rows.find((r) => r.indexname === "ix_outbox_due")?.indexdef).toContain(
      "published_at IS NULL",
    );
  });
});
