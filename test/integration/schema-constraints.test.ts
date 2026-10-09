import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../../src/infrastructure/database/migrate";
import { MIGRATIONS } from "../../src/infrastructure/database/migrations";
import { assertAllWalletsConsistent } from "../helpers/invariants";
import { createTestDatabase, type TestDatabase } from "../helpers/test-db";

/**
 * Proves that uniqueness, immutability and non-negativity are enforced by PostgreSQL itself:
 * every write here bypasses the application and must be rejected by the schema.
 */
let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await assertAllWalletsConsistent(db);
  await db.drop();
});

const uuid = () => Bun.randomUUIDv7();
const HASH = `v1:${"a".repeat(64)}`;

/** Inserts a wallet with an OPENING credit, the way the application does, inside one SQL transaction. */
async function seedWallet(balance = "100.00") {
  const walletId = uuid();
  const playerId = uuid();
  const openingId = uuid();
  await db.query("BEGIN");
  await db.query("INSERT INTO wallets VALUES ($1, $2, 'BRL', $3, 1, now(), now())", [
    walletId,
    playerId,
    balance,
  ]);
  await db.query(
    `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
       player_id, round_id, game_id, kind, amount, currency, status, result_balance_amount, created_at, processed_at)
     VALUES ($1, 'system', $2, $3, $4, $5, $6, 'r', 'g', 'OPENING', $7, 'BRL', 'PROCESSED', $7, now(), now())`,
    [openingId, `opening:${walletId}`, `system:opening:${walletId}`, HASH, walletId, playerId, balance],
  );
  await db.query(
    `INSERT INTO wallet_ledger_entries VALUES ($1, $2, $3, 'CREDIT', $4, 'BRL', 0, $4, 1, now())`,
    [uuid(), walletId, openingId, balance],
  );
  await postLegs(openingId, `wallet:${walletId}`, "system:funding:BRL", "CREDIT", balance);
  await db.query("COMMIT");
  return { walletId, playerId, openingId };
}

/** Journal legs (double-entry) for a wallet movement: wallet leg + opposite counterparty leg. */
async function postLegs(
  txId: string,
  walletAccount: string,
  counterparty: string,
  walletDirection: string,
  amount: string,
) {
  const opposite = walletDirection === "CREDIT" ? "DEBIT" : "CREDIT";
  await db.query(
    `INSERT INTO ledger_postings VALUES ($1, $2, $3, $4, $5, 'BRL', now()), ($6, $2, $7, $8, $5, 'BRL', now())`,
    [uuid(), txId, walletAccount, walletDirection, amount, uuid(), counterparty, opposite],
  );
}

async function insertBet(
  w: { walletId: string; playerId: string },
  opts: { status?: string; amount?: string } = {},
) {
  const id = uuid();
  const ext = uuid();
  const status = opts.status ?? "PROCESSED";
  await db.query(
    `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
       player_id, round_id, game_id, kind, amount, currency, status, failure_code, result_balance_amount, created_at, processed_at)
     VALUES ($1, 'p', $2, $3, $4, $5, $6, 'r', 'g', 'BET', $7, 'BRL', $8, $9, '0.00', now(), now())`,
    [
      id,
      ext,
      `p:${ext}`,
      HASH,
      w.walletId,
      w.playerId,
      opts.amount ?? "10.00",
      status,
      status === "REJECTED" ? "INSUFFICIENT_FUNDS" : null,
    ],
  );
  return id;
}

async function expectRejected(sql: string, params: unknown[], pattern: RegExp, asApp = false) {
  await db.query("BEGIN").catch(() => {});
  let error: unknown;
  try {
    await (asApp ? db.queryAsApp(sql, params) : db.query(sql, params));
    await db.query("COMMIT"); // deferred constraint triggers fire here
  } catch (e) {
    error = e;
  } finally {
    await db.query("ROLLBACK").catch(() => {});
  }
  expect(error).toBeDefined();
  expect(String((error as Error).message)).toMatch(pattern);
}

describe("migrations", () => {
  test("are reversible: down then up again on a scratch database", async () => {
    const scratch = await createTestDatabase();
    try {
      await runMigrations(scratch.migratorUrl, "down", MIGRATIONS.length); // revert everything
      const [{ n }] = (await scratch.query<{ n: string }>(
        "SELECT COUNT(*)::text AS n FROM pg_tables WHERE schemaname = 'public' AND tablename = 'wallets'",
      )) as [{ n: string }];
      expect(n).toBe("0");
      await runMigrations(scratch.migratorUrl, "up");
      const tables = await scratch.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
      );
      expect(tables.map((t) => t.tablename)).toEqual(
        expect.arrayContaining([
          "inbox_messages",
          "outbox_messages",
          "wager_transactions",
          "ledger_postings",
          "wager_submission_failures",
          "wallet_ledger_entries",
          "wallets",
        ]),
      );
    } finally {
      await scratch.drop();
    }
  });
});

describe("wallets", () => {
  test("one wallet per (player, currency)", async () => {
    const w = await seedWallet();
    await expectRejected(
      "INSERT INTO wallets VALUES ($1, $2, 'BRL', 0, 1, now(), now())",
      [uuid(), w.playerId],
      /wallets_player_currency_uk/,
    );
  });

  test("balance can never be negative", async () => {
    await expectRejected(
      "INSERT INTO wallets VALUES ($1, $2, 'BRL', -0.01, 1, now(), now())",
      [uuid(), uuid()],
      /wallets_balance_non_negative_ck/,
    );
  });

  test("balance change without a ledger entry is rejected at commit", async () => {
    const w = await seedWallet();
    await expectRejected(
      "UPDATE wallets SET balance_amount = 50, version = 2 WHERE id = $1",
      [w.walletId],
      /no matching ledger entry/,
    );
  });

  test("a balance change must increase the version; versions never decrease", async () => {
    const w = await seedWallet();
    await expectRejected(
      "UPDATE wallets SET balance_amount = 50 WHERE id = $1",
      [w.walletId],
      /increase the version/,
    );
    await expectRejected(
      "UPDATE wallets SET version = 0 WHERE id = $1",
      [w.walletId],
      /cannot decrease|wallets_version_ck/,
    );
  });

  test("a batch may advance the version by N only if all N ledger lines exist (no gaps)", async () => {
    const w = await seedWallet("100.00");
    const betA = await insertBet(w);
    const betB = await insertBet(w);
    // Accepted: v1 → v3 with v2 and v3 present (one wallet update for a batch of two).
    await db.query("BEGIN");
    await db.query(
      `INSERT INTO wallet_ledger_entries VALUES
         ($1, $3, $4, 'DEBIT', 10, 'BRL', 100, 90, 2, now()),
         ($2, $3, $5, 'DEBIT', 10, 'BRL', 90, 80, 3, now())`,
      [uuid(), uuid(), w.walletId, betA, betB],
    );
    await postLegs(betA, `wallet:${w.walletId}`, "provider:p:BRL", "DEBIT", "10.00");
    await postLegs(betB, `wallet:${w.walletId}`, "provider:p:BRL", "DEBIT", "10.00");
    await db.query("UPDATE wallets SET balance_amount = 80, version = 3 WHERE id = $1", [w.walletId]);
    await db.query("COMMIT");

    // Rejected: v3 → v5 with only the v5 line (v4 missing) — the chain trigger refuses the gap.
    const betC = await insertBet(w);
    await expectRejected(
      "INSERT INTO wallet_ledger_entries VALUES ($1, $2, $3, 'DEBIT', 10, 'BRL', 70, 60, 5, now())",
      [uuid(), w.walletId, betC],
      /chain broken/,
    );
    // Rejected: version jump without any ledger line — the deferred consistency check refuses it at COMMIT.
    await expectRejected(
      "UPDATE wallets SET balance_amount = 70, version = 5 WHERE id = $1",
      [w.walletId],
      /no matching ledger entry/,
    );
  });

  test("wallets cannot be deleted", async () => {
    const w = await seedWallet();
    await expectRejected(
      "DELETE FROM wallets WHERE id = $1",
      [w.walletId],
      /cannot be deleted|violates foreign key/,
    );
  });
});

describe("ledger", () => {
  test("is append-only: UPDATE/DELETE/TRUNCATE are rejected even for the schema owner", async () => {
    const w = await seedWallet();
    await expectRejected(
      "UPDATE wallet_ledger_entries SET amount = 1 WHERE wallet_id = $1",
      [w.walletId],
      /append-only/,
    );
    await expectRejected(
      "DELETE FROM wallet_ledger_entries WHERE wallet_id = $1",
      [w.walletId],
      /append-only/,
    );
    await expectRejected("TRUNCATE wallet_ledger_entries CASCADE", [], /append-only/);
  });

  test("the runtime role has no UPDATE/DELETE privilege on the ledger", async () => {
    const w = await seedWallet();
    await expectRejected(
      "UPDATE wallet_ledger_entries SET amount = 1 WHERE wallet_id = $1",
      [w.walletId],
      /permission denied/,
      true,
    );
    await expectRejected(
      "DELETE FROM wallet_ledger_entries WHERE wallet_id = $1",
      [w.walletId],
      /permission denied/,
      true,
    );
  });

  test("arithmetic must hold (before ± amount = after)", async () => {
    const w = await seedWallet();
    const bet = await insertBet(w);
    await expectRejected(
      "INSERT INTO wallet_ledger_entries VALUES ($1, $2, $3, 'DEBIT', 10, 'BRL', 100, 95, 2, now())",
      [uuid(), w.walletId, bet],
      /ledger_arithmetic_ck/,
    );
  });

  test("one entry per (wallet, version): a lost update becomes a unique violation", async () => {
    // Two writers that both read version 1 / balance 100 and both try to write version 2.
    const w = await seedWallet("100.00");
    const betA = await insertBet(w);
    const betB = await insertBet(w);
    await db.query("BEGIN");
    let error: unknown;
    try {
      await db.query(
        "INSERT INTO wallet_ledger_entries VALUES ($1, $2, $3, 'DEBIT', 10, 'BRL', 100, 90, 2, now())",
        [uuid(), w.walletId, betA],
      );
      await db.query(
        "INSERT INTO wallet_ledger_entries VALUES ($1, $2, $3, 'DEBIT', 10, 'BRL', 100, 90, 2, now())",
        [uuid(), w.walletId, betB],
      );
    } catch (e) {
      error = e;
    } finally {
      await db.query("ROLLBACK");
    }
    expect(String(error)).toMatch(/ledger_one_entry_per_version_uk/);
  });

  test("chain must continue the previous entry", async () => {
    const w = await seedWallet("100.00");
    const bet = await insertBet(w);
    await expectRejected(
      "INSERT INTO wallet_ledger_entries VALUES ($1, $2, $3, 'DEBIT', 10, 'BRL', 90, 80, 2, now())",
      [uuid(), w.walletId, bet],
      /chain broken/,
    );
  });

  test("REJECTED transactions cannot have ledger entries", async () => {
    const w = await seedWallet("100.00");
    const rejected = await insertBet(w, { status: "REJECTED" });
    await db.query("BEGIN");
    let error: unknown;
    try {
      // Journal legs present, so the only rule left to break is "ledger only for PROCESSED transactions".
      await postLegs(rejected, `wallet:${w.walletId}`, "provider:p:BRL", "DEBIT", "10.00");
      await db.query(
        "INSERT INTO wallet_ledger_entries VALUES ($1, $2, $3, 'DEBIT', 10, 'BRL', 100, 90, 2, now())",
        [uuid(), w.walletId, rejected],
      );
      await db.query("UPDATE wallets SET balance_amount = 90, version = 2 WHERE id = $1", [w.walletId]);
      await db.query("COMMIT");
    } catch (e) {
      error = e;
      await db.query("ROLLBACK");
    }
    expect(String(error)).toMatch(/does not match a PROCESSED balance-moving transaction/);
  });

  test("a consistent movement (transaction + wallet + entry) commits", async () => {
    const w = await seedWallet("100.00");
    const bet = await insertBet(w);
    await db.query("BEGIN");
    await db.query(
      "INSERT INTO wallet_ledger_entries VALUES ($1, $2, $3, 'DEBIT', 10, 'BRL', 100, 90, 2, now())",
      [uuid(), w.walletId, bet],
    );
    await postLegs(bet, `wallet:${w.walletId}`, "provider:p:BRL", "DEBIT", "10.00");
    await db.query("UPDATE wallets SET balance_amount = 90, version = 2 WHERE id = $1", [w.walletId]);
    await db.query("COMMIT");
  });
});

describe("double-entry journal", () => {
  test("an unbalanced journal is rejected at commit", async () => {
    const w = await seedWallet("100.00");
    const bet = await insertBet(w);
    await expectRejected(
      `INSERT INTO ledger_postings VALUES ($1, $2, $3, 'DEBIT', 10, 'BRL', now()), ($4, $2, 'provider:p:BRL', 'CREDIT', 9.99, 'BRL', now())`,
      [uuid(), bet, `wallet:${w.walletId}`, uuid()],
      /does not balance/,
    );
  });

  test("a wallet ledger line without its journal leg is rejected at commit", async () => {
    const w = await seedWallet("100.00");
    const bet = await insertBet(w);
    await db.query("BEGIN");
    let error: unknown;
    try {
      await db.query(
        "INSERT INTO wallet_ledger_entries VALUES ($1, $2, $3, 'DEBIT', 10, 'BRL', 100, 90, 2, now())",
        [uuid(), w.walletId, bet],
      );
      await db.query("UPDATE wallets SET balance_amount = 90, version = 2 WHERE id = $1", [w.walletId]);
      await db.query("COMMIT");
    } catch (e) {
      error = e;
      await db.query("ROLLBACK");
    }
    expect(String(error)).toMatch(/no matching journal posting/);
  });

  test("postings are append-only", async () => {
    const w = await seedWallet();
    await expectRejected(
      "DELETE FROM ledger_postings WHERE transaction_id = $1",
      [w.openingId],
      /append-only/,
    );
    await expectRejected(
      "UPDATE ledger_postings SET amount = 1 WHERE transaction_id = $1",
      [w.openingId],
      /permission denied/,
      true,
    );
  });

  test("the books balance globally: Σ debits = Σ credits over the whole journal", async () => {
    const [row] = await db.query<{ debits: string; credits: string }>(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'DEBIT'), 0)::text AS debits,
              COALESCE(SUM(amount) FILTER (WHERE direction = 'CREDIT'), 0)::text AS credits
         FROM ledger_postings`,
    );
    expect(row?.debits).toBe(row?.credits);
  });
});

describe("wager transactions", () => {
  const pendingBet = `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key,
       payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'r', 'g', 'BET', 1, 'BRL', 'PENDING', now())`;

  test("idempotency key and (provider, externalId) are unique per provider", async () => {
    const w = await seedWallet();
    await expectRejected(
      pendingBet,
      [uuid(), "system", "x", `system:opening:${w.walletId}`, HASH, w.walletId, w.playerId],
      /wager_tx_provider_idempotency_uk/,
    );
  });

  test("two providers may use the same idempotency key (each provider owns its key space)", async () => {
    const w = await seedWallet();
    const key = `shared-${uuid()}`;
    await db.query(pendingBet, [uuid(), "provider-a", uuid(), key, HASH, w.walletId, w.playerId]);
    await db.query(pendingBet, [uuid(), "provider-b", uuid(), key, HASH, w.walletId, w.playerId]);
    await expectRejected(
      pendingBet,
      [uuid(), "provider-a", uuid(), key, HASH, w.walletId, w.playerId],
      /wager_tx_provider_idempotency_uk/,
    );
  });

  test("terminal transactions are frozen and nothing can be deleted", async () => {
    const w = await seedWallet();
    await expectRejected(
      "UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'X' WHERE id = $1",
      [w.openingId],
      /terminal/,
    );
    await expectRejected("DELETE FROM wager_transactions WHERE id = $1", [w.openingId], /cannot be deleted/);
  });

  test("REFUND/ROLLBACK require a reference; amounts are positive (LOSS may be zero)", async () => {
    const w = await seedWallet();
    await expectRejected(
      `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
         player_id, round_id, game_id, kind, amount, currency, status, created_at)
       VALUES ($1, 'p', $2, $2, $3, $4, $5, 'r', 'g', 'REFUND', 1, 'BRL', 'PENDING', now())`,
      [uuid(), uuid(), HASH, w.walletId, w.playerId],
      /wager_tx_reversal_requires_ref_ck/,
    );
    await expectRejected(
      `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
         player_id, round_id, game_id, kind, amount, currency, status, created_at)
       VALUES ($1, 'p', $2, $2, $3, $4, $5, 'r', 'g', 'BET', 0, 'BRL', 'PENDING', now())`,
      [uuid(), uuid(), HASH, w.walletId, w.playerId],
      /wager_tx_amount_ck/,
    );
  });

  test("a reference can be reversed only once (partial unique index)", async () => {
    const w = await seedWallet();
    const bet = await insertBet(w);
    const reversal = (kind: string) =>
      db.query(
        `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
           player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id,
           status, result_balance_amount, created_at, processed_at)
         VALUES ($1, 'p', $2, $2, $3, $4, $5, 'r', 'g', $6, 10, 'BRL', 'ref', $7, 'PROCESSED', 0, now(), now())`,
        [uuid(), uuid(), HASH, w.walletId, w.playerId, kind, bet],
      );
    await reversal("REFUND");
    await expect(reversal("ROLLBACK")).rejects.toThrow(/wager_tx_single_reversal_uk/);
  });

  test("a reference must belong to the same wallet (composite FK)", async () => {
    const a = await seedWallet();
    const b = await seedWallet();
    const betOfA = await insertBet(a);
    await expectRejected(
      `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
         player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id,
         status, result_balance_amount, created_at, processed_at)
       VALUES ($1, 'p', $2, $2, $3, $4, $5, 'r', 'g', 'REFUND', 10, 'BRL', 'ref', $6, 'PROCESSED', 0, now(), now())`,
      [uuid(), uuid(), HASH, b.walletId, b.playerId, betOfA],
      /wager_tx_reference_same_wallet_fk/,
    );
  });
});

describe("money columns", () => {
  test("NUMERIC hydrates as exact decimal strings through the driver", async () => {
    const w = await seedWallet("1234567890123456.78");
    const [row] = await db.queryAsApp<{ balance_amount: unknown }>(
      "SELECT balance_amount FROM wallets WHERE id = $1",
      [w.walletId],
    );
    expect(typeof row?.balance_amount).toBe("string");
    expect(row?.balance_amount).toBe("1234567890123456.78");
  });
});
