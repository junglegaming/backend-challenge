import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
  BatchItemOutcome,
  SubmitWagerCommand,
} from "../../src/modules/wagering/application/process-wager-transaction";
import type { ExternalWagerKind } from "../../src/modules/wagering/domain/wager-transaction-kind";
import { assertAllWalletsConsistent, assertWalletConsistent } from "../helpers/invariants";
import { type CoreHarness, newPlayerId, startCore, wagerCommand } from "../helpers/test-core";

/**
 * Per-wallet batching must be indistinguishable from processing the same submissions one by one.
 */
let h: CoreHarness;
beforeAll(async () => {
  h = await startCore({ DB_POOL_MAX: 30, DB_TX_MAX_ATTEMPTS: 10 });
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

type Step = {
  kind: ExternalWagerKind;
  amount: string;
  ext: string;
  ref?: string;
  key?: string;
  round?: string;
};

/** Builds commands for a wallet; ids are namespaced per wallet so two wallets can replay the same script. */
function script(w: { id: string; playerId: string }, ns: string, steps: Step[]): SubmitWagerCommand[] {
  return steps.map((s, i) =>
    wagerCommand(w, s.kind, s.amount, {
      externalTransactionId: `${ns}-${s.ext}`,
      idempotencyKey: `provider-a:${ns}-${s.key ?? s.ext}`,
      referenceExternalTransactionId: s.ref ? `${ns}-${s.ref}` : undefined,
      roundId: s.round ?? "round-1",
      inbox: { consumerName: "test", messageId: `${ns}-m${i}`, payloadHash: `h-${s.ext}-${s.amount}` },
    }),
  );
}

const shape = (o: BatchItemOutcome) =>
  o.ok
    ? {
        status: o.result.status as string,
        failureCode: (o.result.failureCode as string | undefined) ?? null,
        balance: o.result.balance.amount,
        replay: o.result.idempotentReplay,
      }
    : { error: o.error.code, reason: (o.error.details as { reason?: string } | undefined)?.reason ?? null };

async function sequential(cmds: SubmitWagerCommand[]): Promise<BatchItemOutcome[]> {
  const out: BatchItemOutcome[] = [];
  for (const cmd of cmds) {
    try {
      out.push({ ok: true, result: await h.core.processWager.execute(cmd) });
    } catch (error) {
      out.push({ ok: false, error: error as never });
    }
  }
  return out;
}

describe("per-wallet batch", () => {
  const tricky: Step[] = [
    { kind: "ROLLBACK", amount: "10.00", ext: "rb-before-bet", ref: "bet-late" }, // reference arrives later
    { kind: "BET", amount: "30.00", ext: "bet-1" },
    { kind: "WIN", amount: "45.00", ext: "win-1", ref: "bet-1" },
    { kind: "BET", amount: "30.00", ext: "bet-1" }, // same key, same payload → replay
    { kind: "BET", amount: "31.00", ext: "bet-1" }, // same key, different payload → conflict
    { kind: "BET", amount: "5.00", ext: "bet-1", key: "other-key" }, // external id reused → conflict
    { kind: "REFUND", amount: "30.00", ext: "refund-1", ref: "bet-1" },
    { kind: "ROLLBACK", amount: "30.00", ext: "rb-1", ref: "bet-1" }, // already reversed in this batch
    { kind: "BET", amount: "10.00", ext: "bet-late" },
    { kind: "BET", amount: "9999.00", ext: "bet-huge" }, // insufficient funds
    { kind: "LOSS", amount: "0.00", ext: "loss-1", ref: "bet-late" },
    { kind: "ROLLBACK", amount: "45.00", ext: "rb-win", ref: "win-1" }, // debit back the win
    { kind: "BET", amount: "1.50", ext: "bet-x", round: "round-2" },
  ];

  test("is equivalent to sequential processing (outcomes, balance, ledger)", async () => {
    const a = await openWallet("100.00");
    const b = await openWallet("100.00");
    const batched = await h.core.processWager.executeBatch(script(a, "A", tricky));
    const oneByOne = await sequential(script(b, "B", tricky));

    expect(batched.map(shape)).toEqual(oneByOne.map(shape));
    const [wa, wb] = await Promise.all([h.core.getWallet.execute(a.id), h.core.getWallet.execute(b.id)]);
    expect(wa.balance).toEqual(wb.balance);
    expect(wa.version).toBe(wb.version);

    const ledgerOf = async (walletId: string) =>
      (await h.core.listLedger.execute(walletId, undefined, 100)).items.map((e) => [
        e.walletVersion,
        e.direction,
        e.money.amount,
        e.balanceAfter.amount,
      ]);
    expect(await ledgerOf(a.id)).toEqual(await ledgerOf(b.id));
    expect((await h.core.reconcileWallet.execute(a.id)).consistent).toBe(true);
    await assertWalletConsistent(h.db, a.id);
  });

  test("an out-of-order reference inside the batch is parked and nudged (due now) for the worker", async () => {
    const w = await openWallet();
    const [rb] = await h.core.processWager.executeBatch(
      script(w, "N", [
        { kind: "ROLLBACK", amount: "10.00", ext: "rb", ref: "bet" },
        { kind: "BET", amount: "10.00", ext: "bet" },
      ]),
    );
    expect(rb?.ok && (rb.result.status as string)).toBe("PENDING_REFERENCE");
    const [row] = await h.db.query<{ due: boolean }>(
      // Compared with created_at (same application clock): host and database clocks may differ.
      "SELECT next_reference_retry_at < created_at + interval '1 second' AS due FROM wager_transactions WHERE external_transaction_id = 'N-rb'",
    );
    expect(row?.due).toBe(true);
    await h.core.resolvePendingReferences.runOnce();
    expect((await h.core.getWallet.execute(w.id)).balance.amount).toBe("100.00");
  });

  test("a net-zero batch advances the version by N with the balance unchanged", async () => {
    const w = await openWallet("100.00");
    await h.core.processWager.executeBatch(
      script(w, "Z", [
        { kind: "BET", amount: "10.00", ext: "b" },
        { kind: "WIN", amount: "10.00", ext: "w" },
      ]),
    );
    expect(await h.core.getWallet.execute(w.id)).toMatchObject({ balance: { amount: "100.00" }, version: 3 });
    await assertWalletConsistent(h.db, w.id);
  });

  test("the same messageId twice in one batch mirrors the first; a refused item leaves no inbox record", async () => {
    const w = await openWallet();
    const [first, second] = script(w, "M", [
      { kind: "BET", amount: "10.00", ext: "b1" },
      { kind: "BET", amount: "10.00", ext: "b1" },
    ]) as [SubmitWagerCommand, SubmitWagerCommand];
    const copy = { ...second, inbox: first.inbox }; // same messageId, same content
    const [conflictBase] = script(w, "M", [{ kind: "BET", amount: "10.00", ext: "b1" }]);
    const conflicting = {
      ...(conflictBase as SubmitWagerCommand),
      money: { amount: "11.00", currency: "BRL" },
      inbox: { consumerName: "test", messageId: "M-conflict", payloadHash: "x" },
    };

    const outcomes = await h.core.processWager.executeBatch([first, copy, conflicting]);
    expect(outcomes.map(shape)).toEqual([
      { status: "PROCESSED", failureCode: null, balance: "90.00", replay: false },
      { status: "PROCESSED", failureCode: null, balance: "90.00", replay: true },
      { error: "IDEMPOTENCY_CONFLICT", reason: "PAYLOAD_MISMATCH" },
    ]);
    const inbox = await h.db.query<{ message_id: string }>(
      "SELECT message_id FROM inbox_messages WHERE message_id LIKE 'M-%' ORDER BY message_id",
    );
    expect(inbox.map((r) => r.message_id)).toEqual(["M-m0"]);
    expect((await h.core.getWallet.execute(w.id)).balance.amount).toBe("90.00");
  });

  test("redelivery of a whole committed batch replays every item without new effects", async () => {
    const w = await openWallet();
    const cmds = script(w, "R", [
      { kind: "BET", amount: "10.00", ext: "b1" },
      { kind: "BET", amount: "20.00", ext: "b2" },
    ]);
    await h.core.processWager.executeBatch(cmds);
    const again = await h.core.processWager.executeBatch(cmds);
    expect(again.every((o) => o.ok && o.result.duplicateMessage && o.result.idempotentReplay)).toBe(true);
    expect((await h.core.getWallet.execute(w.id)).balance.amount).toBe("70.00");
  });

  test("mandatory scenario inside one batch: 100.00 and two 80.00 bets", async () => {
    const w = await openWallet("100.00");
    const outcomes = await h.core.processWager.executeBatch(
      script(w, "S", [
        { kind: "BET", amount: "80.00", ext: "b1" },
        { kind: "BET", amount: "80.00", ext: "b2" },
      ]),
    );
    expect(outcomes.map(shape)).toEqual([
      { status: "PROCESSED", failureCode: null, balance: "20.00", replay: false },
      { status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS", balance: "20.00", replay: false },
    ]);
  });

  test("concurrent batches and single submissions on the same wallet stay serialised and consistent", async () => {
    const w = await openWallet("1000.00");
    const batches = Array.from({ length: 6 }, (_, k) =>
      script(
        w,
        `C${k}`,
        Array.from({ length: 8 }, (_, j) => ({ kind: "BET" as const, amount: "5.00", ext: `b${j}` })),
      ),
    );
    await Promise.all([
      ...batches.map((b) => h.core.processWager.executeBatch(b)),
      ...Array.from({ length: 10 }, () => h.core.processWager.execute(wagerCommand(w, "BET", "5.00"))),
    ]);
    expect((await h.core.getWallet.execute(w.id)).balance.amount).toBe("710.00"); // 1000 - 58 × 5
    await assertWalletConsistent(h.db, w.id);
  });

  test("a batch must target a single wallet", async () => {
    const a = await openWallet();
    const b = await openWallet();
    await expect(
      h.core.processWager.executeBatch([wagerCommand(a, "BET", "1.00"), wagerCommand(b, "BET", "1.00")]),
    ).rejects.toThrow(/single wallet/);
  });
});

describe("UUID case (regression)", () => {
  test("upper-case ids in a batch are normalised: processed, never a defect or a false mismatch", async () => {
    const w = await openWallet("100.00");
    const upper = { id: w.id.toUpperCase(), playerId: w.playerId.toUpperCase() };
    const outcomes = await h.core.processWager.executeBatch([
      wagerCommand(upper, "BET", "10.00"),
      wagerCommand(w, "BET", "10.00"),
    ]);
    expect(outcomes.map(shape)).toEqual([
      { status: "PROCESSED", failureCode: null, balance: "90.00", replay: false },
      { status: "PROCESSED", failureCode: null, balance: "80.00", replay: false },
    ]);
  });
});

describe("dependents of a rejected reference (regression)", () => {
  test("are made due immediately and rejected as REFERENCE_NOT_PROCESSED, not after their backoff", async () => {
    // Long backoff: without the nudge the dependent would only be looked at again in a minute.
    const slow = await startCore({ PENDING_REF_BASE_MS: 60_000, PENDING_REF_MAX_MS: 600_000 });
    try {
      const w = await slow.core.createWallet.execute({
        playerId: newPlayerId(),
        initialBalance: { amount: "5.00", currency: "BRL" },
        correlationId: "c",
      });
      const rollback = await slow.core.processWager.execute(
        wagerCommand(w, "ROLLBACK", "50.00", { referenceExternalTransactionId: "big-bet" }),
      );
      expect(rollback.status as string).toBe("PENDING_REFERENCE");
      const bigBet = await slow.core.processWager.execute(
        wagerCommand(w, "BET", "50.00", { externalTransactionId: "big-bet" }),
      );
      expect(bigBet).toMatchObject({ status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS" });

      const [row] = await slow.db.query<{ due: boolean }>(
        "SELECT next_reference_retry_at <= created_at + interval '1 second' AS due FROM wager_transactions WHERE id = $1",
        [rollback.transactionId],
      );
      expect(row?.due).toBe(true);
      await slow.core.resolvePendingReferences.runOnce();
      const resolved = await slow.core.getWager.byId(rollback.transactionId);
      expect(resolved).toMatchObject({ status: "REJECTED", failureCode: "REFERENCE_NOT_PROCESSED" });
      await assertWalletConsistent(slow.db, w.id);
    } finally {
      await slow.close();
    }
  });
});

describe("cross-wallet reference (regression)", () => {
  test("a reference that belongs to another wallet is rejected (422), never a foreign-key error", async () => {
    const a = await openWallet();
    const b = await openWallet();
    const bet = await h.core.processWager.execute(
      wagerCommand(a, "BET", "10.00", { externalTransactionId: "xw-bet" }),
    );
    expect(bet.status as string).toBe("PROCESSED");
    const refund = await h.core.processWager.execute(
      wagerCommand(b, "REFUND", "10.00", { referenceExternalTransactionId: "xw-bet" }),
    );
    expect(refund).toMatchObject({ status: "REJECTED", failureCode: "REFERENCE_MISMATCH" });
  });
});
