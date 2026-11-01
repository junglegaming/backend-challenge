import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { managerFor } from "../../../src/shared/infrastructure/unit-of-work";
import {
  TransientProcessingError,
  WalletAlreadyExistsError,
} from "../../../src/wagering/application/errors";
import { SubmissionResult } from "../../../src/wagering/application/submit-wager-transaction";
import { WagerTransactionKind as Kind } from "../../../src/wagering/domain/wager-transaction";
import { assertLedgerInvariant, scratchDatabase } from "../../support/database";
import { wagerCommand, wageringHarness } from "../../support/wagering";

const fixture = await scratchDatabase();
const h = wageringHarness(fixture);
afterEach(async () => {
  await assertLedgerInvariant(h.database);
});
afterAll(async () => {
  await fixture.cleanup();
});
const open = (amount = "100.00") =>
  h.open.handle({
    playerId: randomUUID(),
    initialBalance: { amount, currency: "BRL" },
    correlationId: randomUUID(),
  });
function completed(result: SubmissionResult) {
  expect(result.type).toBe("completed");
  if (result.type !== "completed") throw new Error("Expected completed result");
  return result;
}
async function effects(walletId: string) {
  return h.uow.run(async (tx) => {
    const [row] = await managerFor(tx).execute<
      { transactions: number; entries: number; debits: number; events: number }[]
    >(
      `SELECT (SELECT count(*)::int FROM wager_transactions WHERE wallet_id = ?) AS transactions,
       (SELECT count(*)::int FROM wallet_ledger_entries WHERE wallet_id = ?) AS entries,
       (SELECT count(*)::int FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT') AS debits,
       (SELECT count(*)::int FROM outbox_messages WHERE aggregate_id = ? OR payload->'data'->>'walletId' = ?) AS events`,
      [walletId, walletId, walletId, walletId, walletId],
    );
    return row;
  });
}

test("100.00 and two simultaneous 80.00 bets produce one debit and one insufficient-funds rejection", async () => {
  const wallet = await open();
  const commands = [
    wagerCommand(wallet, { money: { amount: "80.00", currency: "BRL" } }),
    wagerCommand(wallet, { money: { amount: "80.00", currency: "BRL" } }),
  ];
  const results = (await Promise.all(commands.map((command) => h.submit.handle(command)))).map(
    completed,
  );
  expect(results.map((r) => r.transaction.status).sort()).toEqual(["PROCESSED", "REJECTED"]);
  expect(results.find((r) => r.transaction.status === "REJECTED")?.transaction.failureCode).toBe(
    "INSUFFICIENT_FUNDS",
  );
  expect((await h.queries.wallet(wallet.id))?.balance.amount).toBe("20.00");
  expect((await effects(wallet.id))?.debits).toBe(1);
  const retries = (await Promise.all(commands.map((command) => h.submit.handle(command)))).map(
    completed,
  );
  expect(retries.every((r) => r.idempotentReplay)).toBe(true);
  expect((await effects(wallet.id))?.debits).toBe(1);
});

test("50 simultaneous identical bets persist one debit and 49 exact replays", async () => {
  const wallet = await open();
  const command = wagerCommand(wallet);
  const results = (
    await Promise.all(Array.from({ length: 50 }, () => h.submit.handle(command)))
  ).map(completed);
  expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
  expect(results.filter((r) => r.idempotentReplay)).toHaveLength(49);
  const original = results[0];
  if (!original) throw new Error("Missing submission result");
  for (const result of results) expect(result.transaction).toEqual(original.transaction);
  expect(await effects(wallet.id)).toEqual({ transactions: 2, entries: 2, debits: 1, events: 4 });
  expect((await h.queries.wallet(wallet.id))?.balance.amount).toBe("90.00");
});

test("key payload divergence and external id reuse are distinct persistent conflicts", async () => {
  const wallet = await open();
  const command = wagerCommand(wallet);
  completed(await h.submit.handle(command));
  expect(
    await h.submit.handle({ ...command, money: { amount: "11.00", currency: "BRL" } }),
  ).toEqual({ type: "idempotency_conflict" });
  expect(await h.submit.handle({ ...command, idempotencyKey: randomUUID() })).toEqual({
    type: "external_transaction_conflict",
  });
  expect((await effects(wallet.id))?.debits).toBe(1);
});

for (const field of ["idempotencyKey", "externalTransactionId"] as const)
  test(`same ${field} raced on different wallet locks resolves as conflict`, async () => {
    const a = await open();
    const b = await open();
    const shared = randomUUID();
    const commands = [wagerCommand(a, { [field]: shared }), wagerCommand(b, { [field]: shared })];
    const results = await Promise.all(commands.map((command) => h.submit.handle(command)));
    expect(results.filter((r) => r.type === "completed")).toHaveLength(1);
    expect(
      results.filter(
        (r) =>
          r.type ===
          (field === "idempotencyKey" ? "idempotency_conflict" : "external_transaction_conflict"),
      ),
    ).toHaveLength(1);
    expect(((await effects(a.id))?.debits ?? 0) + ((await effects(b.id))?.debits ?? 0)).toBe(1);
  });

test("a forced cross-wallet unique race reruns the whole transaction once and becomes a conflict", async () => {
  const a = await open();
  const b = await open();
  const key = randomUUID();
  let arrived = 0;
  let release: () => void = () => {};
  const bothRead = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = h.transactions.findByExternalId.bind(h.transactions);
  const read = spyOn(h.transactions, "findByExternalId").mockImplementation(async (...args) => {
    const result = await original(...args);
    if (arrived < 2) {
      arrived++;
      if (arrived === 2) release();
      await bothRead;
    }
    return result;
  });
  const observe = spyOn(h.telemetry, "databaseError");
  try {
    const results = await Promise.all([
      h.submit.handle(wagerCommand(a, { idempotencyKey: key })),
      h.submit.handle(wagerCommand(b, { idempotencyKey: key })),
    ]);
    expect(results.map((r) => r.type).sort()).toEqual(["completed", "idempotency_conflict"]);
    expect(
      observe.mock.calls.some(
        ([error]) =>
          typeof error === "object" && error !== null && "code" in error && error.code === "23505",
      ),
    ).toBe(true);
  } finally {
    read.mockRestore();
    observe.mockRestore();
  }
});

test("replays retain rejection and the originally observed balance after later credits", async () => {
  const wallet = await open("10.00");
  const rejected = wagerCommand(wallet, { money: { amount: "80.00", currency: "BRL" } });
  const original = completed(await h.submit.handle(rejected));
  expect(original.transaction.failureCode).toBe("INSUFFICIENT_FUNDS");
  const processed = wagerCommand(wallet, {
    kind: Kind.Win,
    money: { amount: "100.00", currency: "BRL" },
  });
  const win = completed(await h.submit.handle(processed));
  completed(await h.submit.handle(wagerCommand(wallet)));
  expect(completed(await h.submit.handle(rejected))).toEqual({
    ...original,
    idempotentReplay: true,
  });
  expect(completed(await h.submit.handle(processed))).toEqual({ ...win, idempotentReplay: true });
  expect(win.transaction.balance?.amount).toBe("110.00");
  expect((await h.queries.wallet(wallet.id))?.balance.amount).toBe("100.00");
});

test("REFUND and ROLLBACK share one effective reversal; rollback of refund never reopens BET", async () => {
  const wallet = await open();
  const bet = wagerCommand(wallet);
  completed(await h.submit.handle(bet));
  const refund = wagerCommand(wallet, {
    kind: Kind.Refund,
    referenceExternalTransactionId: bet.externalTransactionId,
  });
  const refundResult = completed(await h.submit.handle(refund));
  const rollbackBet = wagerCommand(wallet, {
    kind: Kind.Rollback,
    referenceExternalTransactionId: bet.externalTransactionId,
  });
  const rejected = completed(await h.submit.handle(rollbackBet));
  expect(rejected.transaction.failureCode).toBe("REFERENCE_ALREADY_REVERSED");
  expect(completed(await h.submit.handle(refund))).toEqual({
    ...refundResult,
    idempotentReplay: true,
  });
  expect(completed(await h.submit.handle(rollbackBet))).toEqual({
    ...rejected,
    idempotentReplay: true,
  });
  expect(
    completed(
      await h.submit.handle(
        wagerCommand(wallet, {
          kind: Kind.Rollback,
          referenceExternalTransactionId: refund.externalTransactionId,
        }),
      ),
    ).transaction.status,
  ).toBe("PROCESSED");
  expect(
    completed(
      await h.submit.handle(
        wagerCommand(wallet, {
          kind: Kind.Refund,
          referenceExternalTransactionId: bet.externalTransactionId,
        }),
      ),
    ).transaction.failureCode,
  ).toBe("REFERENCE_ALREADY_REVERSED");
  expect((await h.queries.wallet(wallet.id))?.balance.amount).toBe("90.00");
});

test("a rejected reversal does not block a later valid one", async () => {
  const wallet = await open();
  const bet = wagerCommand(wallet);
  completed(await h.submit.handle(bet));
  expect(
    completed(
      await h.submit.handle(
        wagerCommand(wallet, {
          kind: Kind.Refund,
          referenceExternalTransactionId: bet.externalTransactionId,
          money: { amount: "9.00", currency: "BRL" },
        }),
      ),
    ).transaction.failureCode,
  ).toBe("REFERENCE_AMOUNT_MISMATCH");
  expect(
    completed(
      await h.submit.handle(
        wagerCommand(wallet, {
          kind: Kind.Refund,
          referenceExternalTransactionId: bet.externalTransactionId,
        }),
      ),
    ).transaction.status,
  ).toBe("PROCESSED");
  expect((await h.queries.wallet(wallet.id))?.balance.amount).toBe("100.00");
});

test("REFUND against ROLLBACK races serialize to one processed reversal", async () => {
  const wallet = await open();
  const bet = wagerCommand(wallet);
  completed(await h.submit.handle(bet));
  const results = (
    await Promise.all(
      [Kind.Refund, Kind.Rollback].map((kind) =>
        h.submit.handle(
          wagerCommand(wallet, { kind, referenceExternalTransactionId: bet.externalTransactionId }),
        ),
      ),
    )
  ).map(completed);
  expect(results.map((r) => r.transaction.status).sort()).toEqual(["PROCESSED", "REJECTED"]);
  expect(results.find((r) => r.transaction.status === "REJECTED")?.transaction.failureCode).toBe(
    "REFERENCE_ALREADY_REVERSED",
  );
});

for (const order of ["win-first", "refund-first"])
  test(`independent payout and refund both apply: ${order}`, async () => {
    const wallet = await open();
    const bet = wagerCommand(wallet);
    completed(await h.submit.handle(bet));
    const kinds = order === "win-first" ? [Kind.Win, Kind.Refund] : [Kind.Refund, Kind.Win];
    for (const kind of kinds)
      expect(
        completed(
          await h.submit.handle(
            wagerCommand(wallet, {
              kind,
              referenceExternalTransactionId: bet.externalTransactionId,
            }),
          ),
        ).transaction.status,
      ).toBe("PROCESSED");
    expect((await h.queries.wallet(wallet.id))?.balance.amount).toBe("110.00");
  });

test("several WINs per round and rollback of WIN are allowed", async () => {
  const wallet = await open();
  const bet = wagerCommand(wallet);
  completed(await h.submit.handle(bet));
  const wins = Array.from({ length: 3 }, () =>
    wagerCommand(wallet, {
      kind: Kind.Win,
      referenceExternalTransactionId: bet.externalTransactionId,
    }),
  );
  for (const win of wins)
    expect(completed(await h.submit.handle(win)).transaction.status).toBe("PROCESSED");
  expect(
    completed(
      await h.submit.handle(
        wagerCommand(wallet, {
          kind: Kind.Rollback,
          referenceExternalTransactionId: wins[0]?.externalTransactionId,
        }),
      ),
    ).transaction.status,
  ).toBe("PROCESSED");
  expect((await h.queries.wallet(wallet.id))?.balance.amount).toBe("110.00");
});

test("unknown wallet, zero BET and zero LOSS have distinct persisted outcomes", async () => {
  const unknown = wagerCommand({ id: randomUUID(), playerId: randomUUID() });
  const missing = completed(await h.submit.handle(unknown));
  expect(missing.transaction.failureCode).toBe("WALLET_NOT_FOUND");
  expect(missing.transaction.balance).toBeNull();
  expect(completed(await h.submit.handle(unknown))).toEqual({ ...missing, idempotentReplay: true });
  const wallet = await open();
  const before = await effects(wallet.id);
  expect(
    completed(
      await h.submit.handle(wagerCommand(wallet, { money: { amount: "0.00", currency: "BRL" } })),
    ).transaction.failureCode,
  ).toBe("AMOUNT_NOT_POSITIVE");
  expect(
    completed(
      await h.submit.handle(
        wagerCommand(wallet, { kind: Kind.Loss, money: { amount: "0.00", currency: "BRL" } }),
      ),
    ).transaction.status,
  ).toBe("PROCESSED");
  const after = await effects(wallet.id);
  expect(after?.entries).toBe(before?.entries);
  expect(after?.events).toBe((before?.events ?? 0) + 2);
  expect((await h.queries.wallet(wallet.id))?.version).toBe(1);
});

test("rollback of a spent WIN is explicitly rejected without any financial effect", async () => {
  const wallet = await open("0.00");
  const win = wagerCommand(wallet, { kind: Kind.Win });
  completed(await h.submit.handle(win));
  completed(await h.submit.handle(wagerCommand(wallet)));
  const before = await effects(wallet.id);
  const result = completed(
    await h.submit.handle(
      wagerCommand(wallet, {
        kind: Kind.Rollback,
        referenceExternalTransactionId: win.externalTransactionId,
      }),
    ),
  );
  expect(result.transaction.failureCode).toBe("REVERSAL_INSUFFICIENT_FUNDS");
  expect((await effects(wallet.id))?.entries).toBe(before?.entries);
  expect((await h.queries.wallet(wallet.id))?.balance.amount).toBe("0.00");
});

test("positive opening creates its transaction, ledger and both events; zero creates only a wallet", async () => {
  const positive = await open();
  const zero = await open("0.00");
  expect(await effects(positive.id)).toEqual({ transactions: 1, entries: 1, debits: 0, events: 2 });
  expect(await effects(zero.id)).toEqual({ transactions: 0, entries: 0, debits: 0, events: 0 });
  expect(zero.version).toBe(1);
  const entries = await h.queries.ledgerPage(positive.id, 0, 10);
  const transaction = await h.queries.transaction(entries?.[0]?.transactionId ?? "");
  expect(transaction).toMatchObject({
    providerId: "internal",
    externalTransactionId: `opening:${positive.id}`,
    roundId: "internal",
    gameId: "internal",
    kind: "OPENING",
  });
});

test("parallel duplicate wallet opening returns one wallet and one conflict", async () => {
  const command = {
    playerId: randomUUID(),
    initialBalance: { amount: "100.00", currency: "BRL" },
    correlationId: randomUUID(),
  };
  const results = await Promise.allSettled([h.open.handle(command), h.open.handle(command)]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const rejected = results.find((r) => r.status === "rejected");
  expect(
    rejected?.status === "rejected" && rejected.reason instanceof WalletAlreadyExistsError,
  ).toBe(true);
});

test("numeric overflow rolls back all effects, persists FAILED and event in a new transaction, and replays", async () => {
  const wallet = await open("9999999999999999.99");
  const command = wagerCommand(wallet, {
    kind: Kind.Win,
    money: { amount: "0.01", currency: "BRL" },
  });
  const result = completed(await h.submit.handle(command));
  expect(result.transaction.status).toBe("FAILED");
  expect(result.transaction.failureCode).toBe("PERMANENT_PROCESSING_ERROR");
  expect(result.transaction.balance?.amount).toBe("9999999999999999.99");
  expect(await effects(wallet.id)).toEqual({ transactions: 2, entries: 1, debits: 0, events: 3 });
  expect(completed(await h.submit.handle(command))).toEqual({ ...result, idempotentReplay: true });
});

test("failure to persist the FAILED event remains transient and rolls back the failure row", async () => {
  const wallet = await open("9999999999999999.99");
  const command = wagerCommand(wallet, {
    kind: Kind.Win,
    money: { amount: "0.01", currency: "BRL" },
  });
  const original = h.outbox.append.bind(h.outbox);
  const fault = spyOn(h.outbox, "append").mockImplementation(async (...args) => {
    await original(...args);
    throw new Error("forced failure event write");
  });
  try {
    await expect(h.submit.handle(command)).rejects.toBeInstanceOf(TransientProcessingError);
  } finally {
    fault.mockRestore();
  }
  expect(await effects(wallet.id)).toEqual({ transactions: 1, entries: 1, debits: 0, events: 2 });
  expect(completed(await h.submit.handle(command)).transaction.status).toBe("FAILED");
});

test("pending reference resolves once under concurrent resolver calls and preserves its first deadline", async () => {
  const wallet = await open();
  const bet = wagerCommand(wallet);
  const pending = completed(
    await h.submit.handle(
      wagerCommand(wallet, {
        kind: Kind.Refund,
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    ),
  );
  expect(pending.transaction.status).toBe("PENDING_REFERENCE");
  const deadline = await h.uow.run(async (tx) =>
    (
      await h.transactions.find(tx, pending.transaction.transactionId)
    )?.referenceDeadlineAt?.toISOString(),
  );
  await h.resolve.handle(pending.transaction.transactionId);
  expect(
    await h.uow.run(async (tx) =>
      (
        await h.transactions.find(tx, pending.transaction.transactionId)
      )?.referenceDeadlineAt?.toISOString(),
    ),
  ).toBe(deadline);
  completed(await h.submit.handle(bet));
  await Promise.all(
    Array.from({ length: 3 }, () => h.resolve.handle(pending.transaction.transactionId)),
  );
  expect((await h.queries.transaction(pending.transaction.transactionId))?.status).toBe(
    "PROCESSED",
  );
  expect((await h.queries.wallet(wallet.id))?.balance.amount).toBe("100.00");
  expect((await effects(wallet.id))?.entries).toBe(3);
});

test("pending credit overflow becomes FAILED in a fresh transaction without moving money", async () => {
  const wallet = await open("9999999999999999.99");
  const bet = wagerCommand(wallet, { money: { amount: "0.01", currency: "BRL" } });
  const win = wagerCommand(wallet, {
    kind: Kind.Win,
    money: { amount: "0.02", currency: "BRL" },
    referenceExternalTransactionId: bet.externalTransactionId,
  });
  const pending = completed(await h.submit.handle(win));
  expect(pending.transaction.status).toBe("PENDING_REFERENCE");
  completed(await h.submit.handle(bet));
  expect(await h.resolve.handle(pending.transaction.transactionId)).toMatchObject({
    status: "FAILED",
    failureCode: "PERMANENT_PROCESSING_ERROR",
    balance: { amount: "9999999999999999.98", currency: "BRL" },
  });
  expect((await h.queries.wallet(wallet.id))?.balance.amount).toBe("9999999999999999.98");
  expect(await effects(wallet.id)).toEqual({ transactions: 3, entries: 2, debits: 1, events: 6 });
  expect(completed(await h.submit.handle(win)).transaction.status).toBe("FAILED");
});

test("reconciliation reports divergence, logs and counts it, without correcting money", async () => {
  const wallet = await open();
  expect(await h.reconcile.handle(wallet.id)).toMatchObject({
    consistent: true,
    checkedEntries: 1,
    difference: { amount: "0.00", currency: "BRL" },
  });
  await h.uow.run((tx) =>
    managerFor(tx).execute("UPDATE wallets SET balance = '90.00' WHERE id = ?", [wallet.id]),
  );
  const observe = spyOn(h.telemetry, "reconciliationDiverged");
  try {
    expect(await h.reconcile.handle(wallet.id)).toMatchObject({
      consistent: false,
      storedBalance: { amount: "90.00", currency: "BRL" },
      calculatedBalance: { amount: "100.00", currency: "BRL" },
      difference: { amount: "-10.00", currency: "BRL" },
    });
    expect(observe).toHaveBeenCalledWith(wallet.id);
    expect(
      await h.telemetry.registry.getSingleMetricAsString(
        "wagering_reconciliation_divergences_total",
      ),
    ).toContain("wagering_reconciliation_divergences_total 1");
    expect((await h.queries.wallet(wallet.id))?.balance.amount).toBe("90.00");
  } finally {
    observe.mockRestore();
    await h.uow.run((tx) =>
      managerFor(tx).execute("UPDATE wallets SET balance = '100.00' WHERE id = ?", [wallet.id]),
    );
  }
});

test("parallel writes and reconciliations share statement snapshots without false divergences", async () => {
  const wallet = await open();
  const work = Array.from({ length: 30 }, async () =>
    Promise.all([
      h.submit.handle(wagerCommand(wallet, { kind: Kind.Win })),
      h.reconcile.handle(wallet.id).then((result) => expect(result?.consistent).toBe(true)),
    ]),
  );
  await Promise.all(work);
  expect((await h.reconcile.handle(wallet.id))?.consistent).toBe(true);
});

for (const step of ["transaction", "ledger", "wallet", "first-event", "second-event"] as const)
  test(`failure after ${step} write rolls the submission back completely`, async () => {
    const wallet = await open();
    const command = wagerCommand(wallet);
    const before = await effects(wallet.id);
    const fail = () => {
      throw new Error("forced write failure");
    };
    let restore: () => void;
    if (step === "transaction") {
      const original = h.transactions.insert.bind(h.transactions);
      const mock = spyOn(h.transactions, "insert").mockImplementation(async (...args) => {
        await original(...args);
        fail();
      });
      restore = () => mock.mockRestore();
    } else if (step === "ledger") {
      const original = h.ledger.insert.bind(h.ledger);
      const mock = spyOn(h.ledger, "insert").mockImplementation(async (...args) => {
        await original(...args);
        fail();
      });
      restore = () => mock.mockRestore();
    } else if (step === "wallet") {
      const original = h.wallets.save.bind(h.wallets);
      const mock = spyOn(h.wallets, "save").mockImplementation(async (...args) => {
        await original(...args);
        fail();
      });
      restore = () => mock.mockRestore();
    } else {
      const original = h.outbox.append.bind(h.outbox);
      let calls = 0;
      const mock = spyOn(h.outbox, "append").mockImplementation(async (...args) => {
        await original(...args);
        calls++;
        if (calls === (step === "first-event" ? 1 : 2)) fail();
      });
      restore = () => mock.mockRestore();
    }
    try {
      await expect(h.submit.handle(command)).rejects.toBeInstanceOf(TransientProcessingError);
    } finally {
      restore();
    }
    expect(await effects(wallet.id)).toEqual(before);
    expect((await h.queries.wallet(wallet.id))?.balance.amount).toBe("100.00");
    expect(completed(await h.submit.handle(command)).idempotentReplay).toBe(false);
  });

for (const step of ["wallet", "transaction", "ledger", "first-event", "second-event"] as const)
  test(`failure after opening ${step} write rolls back every opening effect`, async () => {
    let walletId = "";
    const restores: Array<() => void> = [];
    const fail = () => {
      throw new Error("forced opening failure");
    };
    const insert = h.wallets.insert.bind(h.wallets);
    const walletMock = spyOn(h.wallets, "insert").mockImplementation(async (tx, wallet) => {
      walletId = wallet.id;
      await insert(tx, wallet);
      if (step === "wallet") fail();
    });
    restores.push(() => walletMock.mockRestore());
    if (step === "transaction") {
      const original = h.transactions.insert.bind(h.transactions);
      const mock = spyOn(h.transactions, "insert").mockImplementation(async (...args) => {
        await original(...args);
        fail();
      });
      restores.push(() => mock.mockRestore());
    } else if (step === "ledger") {
      const original = h.ledger.insert.bind(h.ledger);
      const mock = spyOn(h.ledger, "insert").mockImplementation(async (...args) => {
        await original(...args);
        fail();
      });
      restores.push(() => mock.mockRestore());
    } else if (step === "first-event" || step === "second-event") {
      const original = h.outbox.append.bind(h.outbox);
      let calls = 0;
      const mock = spyOn(h.outbox, "append").mockImplementation(async (...args) => {
        await original(...args);
        calls++;
        if (calls === (step === "first-event" ? 1 : 2)) fail();
      });
      restores.push(() => mock.mockRestore());
    }
    try {
      await expect(open()).rejects.toBeInstanceOf(TransientProcessingError);
    } finally {
      for (const restore of restores) restore();
    }
    expect(walletId).not.toBe("");
    expect(await h.queries.wallet(walletId)).toBeNull();
    expect(await effects(walletId)).toEqual({ transactions: 0, entries: 0, debits: 0, events: 0 });
  });
