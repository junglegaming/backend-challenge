import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { IdempotencyConflictError } from "../../src/shared/application/errors";
import { assertAllWalletsConsistent, assertWalletConsistent } from "../helpers/invariants";
import { type CoreHarness, newPlayerId, startCore, wagerCommand } from "../helpers/test-core";

/**
 * Real parallelism: every call below runs its own SQL transaction on its own pooled connection,
 * so the database (not the event loop) decides the interleaving. Promise.all fires them together.
 */
let h: CoreHarness;
beforeAll(async () => {
  h = await startCore({ DB_POOL_MAX: 60, DB_TX_MAX_ATTEMPTS: 10 });
});
afterAll(async () => {
  const n = await assertAllWalletsConsistent(h.db);
  expect(n).toBeGreaterThan(0);
  await h.close();
});

const openWallet = (amount: string) =>
  h.core.createWallet.execute({
    playerId: newPlayerId(),
    initialBalance: { amount, currency: "BRL" },
    correlationId: "c",
  });

async function ledgerCount(walletId: string, direction: "DEBIT" | "CREDIT") {
  const [row] = await h.db.query<{ n: string }>(
    "SELECT COUNT(*)::text AS n FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = $2",
    [walletId, direction],
  );
  return Number(row?.n);
}

describe("concurrency", () => {
  test("1. the same BET sent 50 times in parallel debits exactly once", async () => {
    const w = await openWallet("100.00");
    const cmd = wagerCommand(w, "BET", "30.00");
    const results = await Promise.all(
      Array.from({ length: 50 }, () => h.core.processWager.execute({ ...cmd })),
    );

    const ids = new Set(results.map((r) => r.transactionId));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(results.every((r) => r.status === "PROCESSED" && r.balance.amount === "70.00")).toBe(true);
    expect(await ledgerCount(w.id, "DEBIT")).toBe(1);
    expect((await h.core.getWallet.execute(w.id)).balance.amount).toBe("70.00");
    await assertWalletConsistent(h.db, w.id);
  });

  test("2. mandatory scenario: 100.00 and two simultaneous 80.00 bets", async () => {
    // Repeated to give the race many chances to go wrong.
    for (let round = 0; round < 10; round++) {
      const w = await openWallet("100.00");
      const results = await Promise.all([
        h.core.processWager.execute(wagerCommand(w, "BET", "80.00")),
        h.core.processWager.execute(wagerCommand(w, "BET", "80.00")),
      ]);
      const statuses: string[] = results.map((r) => r.status).sort();
      expect(statuses).toEqual(["PROCESSED", "REJECTED"]);
      expect(results.find((r) => r.status === "REJECTED")?.failureCode as string | undefined).toBe(
        "INSUFFICIENT_FUNDS",
      );
      expect((await h.core.getWallet.execute(w.id)).balance.amount).toBe("20.00");
      expect(await ledgerCount(w.id, "DEBIT")).toBe(1);

      // Retrying both (provider redelivery) never duplicates the debit.
      const retries = await Promise.all(
        results
          .map((r) => h.core.getWager.byId(r.transactionId))
          .map(async (v) => {
            const view = await v;
            return h.core.processWager.execute(
              wagerCommand(w, "BET", "80.00", { externalTransactionId: view.externalTransactionId }),
            );
          }),
      );
      expect(retries.every((r) => r.idempotentReplay)).toBe(true);
      expect(await ledgerCount(w.id, "DEBIT")).toBe(1);
      await assertWalletConsistent(h.db, w.id);
    }
  });

  test("hot wallet: 100 concurrent 1.00 bets on a 50.00 balance → exactly 50 processed, balance 0.00", async () => {
    const w = await openWallet("50.00");
    const results = await Promise.all(
      Array.from({ length: 100 }, () => h.core.processWager.execute(wagerCommand(w, "BET", "1.00"))),
    );
    expect(results.filter((r) => r.status === "PROCESSED")).toHaveLength(50);
    expect(results.filter((r) => r.status === "REJECTED")).toHaveLength(50);
    const wallet = await h.core.getWallet.execute(w.id);
    expect(wallet).toMatchObject({ balance: { amount: "0.00" }, version: 51 });
    await assertWalletConsistent(h.db, w.id);
  });

  test("3. distinct wallets are processed in parallel without interfering", async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => openWallet("100.00")));
    const started = performance.now();
    const results = await Promise.all(
      wallets.flatMap((w) =>
        Array.from({ length: 5 }, () => h.core.processWager.execute(wagerCommand(w, "BET", "10.00"))),
      ),
    );
    const elapsed = performance.now() - started;
    expect(results.every((r) => r.status === "PROCESSED")).toBe(true);
    for (const w of wallets) {
      expect((await h.core.getWallet.execute(w.id)).balance.amount).toBe("50.00");
      await assertWalletConsistent(h.db, w.id);
    }
    expect(elapsed).toBeLessThan(15_000);
  });

  test("concurrent conflicting payloads under one key: one wins, the rest are conflicts (never a second debit)", async () => {
    const w = await openWallet("100.00");
    const base = wagerCommand(w, "BET", "10.00");
    const attempts = await Promise.allSettled(
      ["10.00", "11.00", "12.00", "13.00", "14.00"].map((amount) =>
        h.core.processWager.execute({ ...base, money: { amount, currency: "BRL" } }),
      ),
    );
    const fulfilled = attempts.filter((a) => a.status === "fulfilled");
    const rejected = attempts.filter((a) => a.status === "rejected") as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    expect(rejected.every((r) => r.reason instanceof IdempotencyConflictError)).toBe(true);
    expect(await ledgerCount(w.id, "DEBIT")).toBe(1);
  });

  test("mixed concurrent BET/WIN/REFUND traffic keeps the ledger consistent", async () => {
    const w = await openWallet("1000.00");
    const bets = await Promise.all(
      Array.from({ length: 20 }, () => h.core.processWager.execute(wagerCommand(w, "BET", "5.00"))),
    );
    const betViews = await Promise.all(bets.map((b) => h.core.getWager.byId(b.transactionId)));
    await Promise.all([
      ...betViews
        .slice(0, 10)
        .map((b) =>
          h.core.processWager.execute(
            wagerCommand(w, "REFUND", "5.00", { referenceExternalTransactionId: b.externalTransactionId }),
          ),
        ),
      ...betViews
        .slice(0, 10)
        .map((b) =>
          h.core.processWager.execute(
            wagerCommand(w, "ROLLBACK", "5.00", { referenceExternalTransactionId: b.externalTransactionId }),
          ),
        ),
      ...Array.from({ length: 10 }, () => h.core.processWager.execute(wagerCommand(w, "WIN", "2.50"))),
    ]);
    // Each of the first 10 bets was reversed exactly once (REFUND or ROLLBACK, whichever came first).
    const [row] = await h.db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM wager_transactions
        WHERE wallet_id = $1 AND kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'`,
      [w.id],
    );
    expect(row?.n).toBe("10");
    expect((await h.core.getWallet.execute(w.id)).balance.amount).toBe(
      String((1000 - 100 + 50 + 25).toFixed(2)),
    );
    const report = await h.core.reconcileWallet.execute(w.id);
    expect(report.consistent).toBe(true);
  });
});
