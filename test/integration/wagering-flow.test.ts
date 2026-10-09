import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  IdempotencyConflictError,
  WalletAlreadyExistsError,
  WalletNotFoundForSubmissionError,
} from "../../src/shared/application/errors";
import { assertAllWalletsConsistent, assertWalletConsistent } from "../helpers/invariants";
import { type CoreHarness, newPlayerId, startCore, uniq, wagerCommand } from "../helpers/test-core";

let h: CoreHarness;
beforeAll(async () => {
  h = await startCore();
});
afterAll(async () => {
  await assertAllWalletsConsistent(h.db);
  await h.close();
});

const openWallet = (amount = "100.00") =>
  h.core.createWallet.execute({
    playerId: newPlayerId(),
    initialBalance: { amount, currency: "BRL" },
    correlationId: "c",
  });

describe("wallet creation", () => {
  test("positive initial balance creates OPENING transaction + CREDIT entry atomically", async () => {
    const w = await openWallet("1000.00");
    expect(w).toMatchObject({ balance: { amount: "1000.00", currency: "BRL" }, version: 1 });
    const txs = await h.db.query(
      "SELECT kind, status, amount::text FROM wager_transactions WHERE wallet_id = $1",
      [w.id],
    );
    expect(txs).toEqual([{ kind: "OPENING", status: "PROCESSED", amount: "1000.00" }]);
    const entries = await h.db.query(
      "SELECT direction, wallet_version FROM wallet_ledger_entries WHERE wallet_id = $1",
      [w.id],
    );
    expect(entries).toEqual([{ direction: "CREDIT", wallet_version: 1 }]);
    const events = await h.db.query<{ event_type: string }>(
      "SELECT event_type FROM outbox_messages WHERE aggregate_id = $1 ORDER BY seq",
      [w.id],
    );
    expect(events.map((e) => e.event_type)).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
    await assertWalletConsistent(h.db, w.id);
  });

  test("zero initial balance: version 1, no ledger, no events", async () => {
    const w = await openWallet("0.00");
    expect(w.version).toBe(1);
    const [{ n }] = (await h.db.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM wallet_ledger_entries WHERE wallet_id = $1",
      [w.id],
    )) as [{ n: string }];
    expect(n).toBe("0");
  });

  test("duplicate (playerId, currency) is a conflict", async () => {
    const playerId = newPlayerId();
    await h.core.createWallet.execute({
      playerId,
      initialBalance: { amount: "1.00", currency: "BRL" },
      correlationId: "c",
    });
    await expect(
      h.core.createWallet.execute({
        playerId,
        initialBalance: { amount: "1.00", currency: "BRL" },
        correlationId: "c",
      }),
    ).rejects.toBeInstanceOf(WalletAlreadyExistsError);
    // same player, another currency is fine (multi-currency model)
    const usd = await h.core.createWallet.execute({
      playerId,
      initialBalance: { amount: "1.00", currency: "USD" },
      correlationId: "c",
    });
    expect(usd.balance.currency).toBe("USD");
  });
});

describe("wager lifecycle", () => {
  test("BET → WIN → LOSS → REFUND → ROLLBACK with ledger and events", async () => {
    const w = await openWallet("100.00");
    const bet = await h.core.processWager.execute(
      wagerCommand(w, "BET", "25.00", { externalTransactionId: uniq("bet") }),
    );
    expect(bet).toMatchObject({ status: "PROCESSED", balance: { amount: "75.00" }, idempotentReplay: false });

    const betExt = (await h.core.getWager.byId(bet.transactionId)).externalTransactionId;
    const win = await h.core.processWager.execute(
      wagerCommand(w, "WIN", "40.00", { referenceExternalTransactionId: betExt }),
    );
    expect(win).toMatchObject({ status: "PROCESSED", balance: { amount: "115.00" } });

    const loss = await h.core.processWager.execute(wagerCommand(w, "LOSS", "0.00"));
    expect(loss).toMatchObject({ status: "PROCESSED", balance: { amount: "115.00" } });

    const refund = await h.core.processWager.execute(
      wagerCommand(w, "REFUND", "25.00", { referenceExternalTransactionId: betExt }),
    );
    expect(refund).toMatchObject({ status: "PROCESSED", balance: { amount: "140.00" } });

    // second reversal of the same BET (by ROLLBACK) is rejected: reverse-once rule
    const rollback = await h.core.processWager.execute(
      wagerCommand(w, "ROLLBACK", "25.00", { referenceExternalTransactionId: betExt }),
    );
    expect(rollback).toMatchObject({ status: "REJECTED", failureCode: "REFERENCE_ALREADY_REVERSED" });

    const wallet = await h.core.getWallet.execute(w.id);
    expect(wallet).toMatchObject({ balance: { amount: "140.00" }, version: 4 });
    const report = await h.core.reconcileWallet.execute(w.id);
    expect(report).toMatchObject({
      consistent: true,
      checkedEntries: 4,
      difference: { amount: "0.00" },
      journal: { walletAccountBalance: { amount: "140.00", currency: "BRL" }, unbalancedTransactions: 0 },
    });
  });

  test("identical resubmission replays the original result, including the balance observed then", async () => {
    const w = await openWallet("100.00");
    const cmd = wagerCommand(w, "BET", "10.00");
    const first = await h.core.processWager.execute(cmd);
    await h.core.processWager.execute(wagerCommand(w, "BET", "50.00"));
    const replay = await h.core.processWager.execute({ ...cmd, correlationId: "other" });
    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(replay.balance.amount).toBe("90.00"); // not today's 40.00
  });

  test("same key with different payload is a conflict, not a replay", async () => {
    const w = await openWallet("100.00");
    const cmd = wagerCommand(w, "BET", "10.00");
    await h.core.processWager.execute(cmd);
    await expect(
      h.core.processWager.execute({ ...cmd, money: { amount: "10.01", currency: "BRL" } }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  test("insufficient funds is a persisted, auditable rejection", async () => {
    const w = await openWallet("10.00");
    const res = await h.core.processWager.execute(wagerCommand(w, "BET", "10.01"));
    expect(res).toMatchObject({
      status: "REJECTED",
      failureCode: "INSUFFICIENT_FUNDS",
      balance: { amount: "10.00" },
    });
    const view = await h.core.getWager.byId(res.transactionId);
    expect(view.status).toBe("REJECTED");
    const events = await h.db.query<{ event_type: string }>(
      "SELECT event_type FROM outbox_messages WHERE payload->'data'->>'transactionId' = $1",
      [res.transactionId],
    );
    expect(events.map((e) => e.event_type)).toEqual(["WagerTransactionRejected"]);
  });

  test("unknown wallet is rejected without persisting anything", async () => {
    await expect(
      h.core.processWager.execute(
        wagerCommand({ id: Bun.randomUUIDv7(), playerId: newPlayerId() }, "BET", "1.00"),
      ),
    ).rejects.toBeInstanceOf(WalletNotFoundForSubmissionError);
  });

  test("ledger pagination with opaque cursor", async () => {
    const w = await openWallet("100.00");
    for (let i = 0; i < 5; i++) await h.core.processWager.execute(wagerCommand(w, "BET", "1.00"));
    const p1 = await h.core.listLedger.execute(w.id, undefined, 4);
    expect(p1.items.map((i) => i.walletVersion)).toEqual([6, 5, 4, 3]);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await h.core.listLedger.execute(w.id, p1.nextCursor ?? undefined, 4);
    expect(p2.items.map((i) => i.walletVersion)).toEqual([2, 1]);
    expect(p2.nextCursor).toBeNull();
  });
});
