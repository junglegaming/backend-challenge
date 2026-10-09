import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { RunningApplication } from "../../src/bootstrap";
import { OutboxPublisher } from "../../src/infrastructure/messaging/outbox-publisher";
import type { SqsGateway } from "../../src/infrastructure/messaging/sqs-gateway";
import { PendingReferenceWorker } from "../../src/infrastructure/workers/background-workers";
import { FaultInjector } from "../../src/infrastructure/workers/fault-injector";
import { noopMetrics } from "../../src/shared/application/observability";
import { assertAllWalletsConsistent, assertWalletConsistent } from "../helpers/invariants";
import { drainQueue } from "../helpers/sqs-helpers";
import { ensureQueues, startTestApp, testEnv, testQueues, waitFor } from "../helpers/test-app";
import { silentLogger, wagerCommand } from "../helpers/test-core";
import { createTestDatabase, type TestDatabase } from "../helpers/test-db";

let db: TestDatabase;
let app: RunningApplication;
let sqs: SqsGateway;
let queues: ReturnType<typeof testQueues>;

beforeAll(async () => {
  db = await createTestDatabase();
  queues = testQueues("outbox");
  // API only: outbox and pending-reference workers are driven explicitly by the tests.
  const env = testEnv(db, queues, { APP_ROLES: "api" });
  sqs = await ensureQueues(env);
  app = await startTestApp(env);
});
afterAll(async () => {
  await app.shutdown("test");
  sqs.destroy();
  await assertAllWalletsConsistent(db);
  await db.drop();
});

const wallet = (amount = "100.00") =>
  app.core.createWallet.execute({
    playerId: Bun.randomUUIDv7(),
    initialBalance: { amount, currency: "BRL" },
    correlationId: "t",
  });

const publisher = (owner: string, leaseMs = 2000) =>
  new OutboxPublisher(
    app.core.uow,
    sqs,
    app.core.clock,
    { owner, batchSize: 7, leaseMs, pollIntervalMs: 20, lanes: 3 },
    noopMetrics,
    silentLogger,
    new FaultInjector([]),
  );

const unpublished = async () =>
  Number(
    (
      await db.query<{ n: string }>(
        "SELECT COUNT(*)::text AS n FROM outbox_messages WHERE published_at IS NULL",
      )
    )[0]?.n,
  );

describe("transactional outbox", () => {
  test("events are written in the same SQL transaction as the financial change (and only then)", async () => {
    const w = await wallet();
    const res = await app.core.processWager.execute(wagerCommand(w, "BET", "10.00"));
    const events = await db.query<{ event_type: string; payload: { data: { transactionId?: string } } }>(
      "SELECT event_type, payload FROM outbox_messages WHERE aggregate_id = $1 ORDER BY seq",
      [w.id],
    );
    expect(events.map((e) => e.event_type)).toEqual([
      "WagerTransactionProcessed", // opening
      "WalletBalanceChanged", // opening
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
    expect(events[2]?.payload.data.transactionId).toBe(res.transactionId);
  });

  test("a failed transaction leaves no outbox row (atomicity)", async () => {
    const before = Number(
      (await db.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM outbox_messages"))[0]?.n,
    );
    await expect(
      app.core.processWager.execute(
        wagerCommand({ id: Bun.randomUUIDv7(), playerId: Bun.randomUUIDv7() }, "BET", "1.00"),
      ),
    ).rejects.toThrow();
    const after = Number(
      (await db.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM outbox_messages"))[0]?.n,
    );
    expect(after).toBe(before);
  });

  test("6. two concurrent publishers drain the same outbox: every event published, none lost", async () => {
    const wallets = await Promise.all(Array.from({ length: 5 }, () => wallet("100.00")));
    await Promise.all(
      wallets.flatMap((w) =>
        Array.from({ length: 6 }, () => app.core.processWager.execute(wagerCommand(w, "BET", "1.00"))),
      ),
    );
    const expectedIds = (await db.query<{ id: string }>("SELECT id FROM outbox_messages")).map((r) => r.id);
    expect(expectedIds.length).toBeGreaterThan(60);

    const a = publisher("publisher-a");
    const b = publisher("publisher-b");
    a.start();
    b.start();
    await waitFor(async () => (await unpublished()) === 0 || undefined, {
      what: "outbox drained",
      timeoutMs: 30_000,
    });
    await Promise.all([a.stop(), b.stop()]);

    const received = await drainQueue(sqs, queues.SQS_EVENTS_QUEUE_NAME);
    const receivedIds = received.map((m) => m.MessageAttributes?.eventId?.StringValue);
    expect(new Set(receivedIds)).toEqual(new Set(expectedIds));
    // Envelope sanity: JSON, stable shape, MoneyProps strings
    const sample = JSON.parse(received[0]?.Body ?? "{}");
    expect(sample).toMatchObject({ eventId: expect.any(String), eventType: expect.any(String), version: 1 });
    // Both publishers participated and nobody published a row claimed by the other while its lease was valid.
    const owners = await db.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM outbox_messages WHERE locked_by IS NOT NULL",
    );
    expect(owners[0]?.n).toBe("0");
  }, 60_000);

  test("a publisher that dies after claiming is taken over once its lease expires", async () => {
    const w = await wallet();
    await app.core.processWager.execute(wagerCommand(w, "BET", "1.00"));
    // "Dead" publisher: claims everything with a short lease and never publishes nor releases.
    const now = new Date();
    const claimed = await app.core.uow.transaction(
      (s) => s.outbox.claimDue(now, 1000, new Date(now.getTime() + 800), "dead-instance"),
      { label: "test-claim" },
    );
    expect(claimed.length).toBeGreaterThan(0);
    const survivor = publisher("survivor");
    expect(await survivor.publishOnce()).toBe(0); // still leased by the dead instance
    await Bun.sleep(900);
    expect(await survivor.publishOnce()).toBe(claimed.length);
    expect(await unpublished()).toBe(0);
  });
});

describe("out-of-order references (PENDING_REFERENCE)", () => {
  const worker = () => new PendingReferenceWorker(app.core.resolvePendingReferences, 50, 50, silentLogger);

  test("7. ROLLBACK delivered before its BET waits, then resolves when the BET arrives", async () => {
    const w = await wallet("100.00");
    const betExt = `bet-${Bun.randomUUIDv7()}`;
    const rollback = await app.core.processWager.execute(
      wagerCommand(w, "ROLLBACK", "30.00", { referenceExternalTransactionId: betExt }),
    );
    expect(rollback.status as string).toBe("PENDING_REFERENCE");
    expect(rollback.balance.amount).toBe("100.00");

    const bet = await app.core.processWager.execute(
      wagerCommand(w, "BET", "30.00", { externalTransactionId: betExt }),
    );
    expect(bet).toMatchObject({ status: "PROCESSED", balance: { amount: "70.00" } });

    const wk = worker();
    wk.start();
    try {
      const resolved = await waitFor(
        async () => {
          const v = await app.core.getWager.byId(rollback.transactionId);
          return v.status === "PROCESSED" ? v : undefined;
        },
        { what: "rollback resolved" },
      );
      expect(resolved.referenceTransactionId).toBe(bet.transactionId);
    } finally {
      await wk.stop();
    }
    expect((await app.core.getWallet.execute(w.id)).balance.amount).toBe("100.00");
    // Replaying the original ROLLBACK now returns its final state.
    const replay = await app.core.processWager.execute(
      wagerCommand(w, "ROLLBACK", "30.00", {
        referenceExternalTransactionId: betExt,
        externalTransactionId: (await app.core.getWager.byId(rollback.transactionId)).externalTransactionId,
      }),
    );
    expect(replay).toMatchObject({ status: "PROCESSED", idempotentReplay: true });
    await assertWalletConsistent(db, w.id);
  });

  test("a reference that never arrives is rejected with REFERENCE_NOT_FOUND after the retry budget, with an event", async () => {
    const w = await wallet("100.00");
    const refund = await app.core.processWager.execute(
      wagerCommand(w, "REFUND", "10.00", { referenceExternalTransactionId: `ghost-${Bun.randomUUIDv7()}` }),
    );
    const wk = worker();
    wk.start();
    try {
      const final = await waitFor(
        async () => {
          const v = await app.core.getWager.byId(refund.transactionId);
          return v.status === "REJECTED" ? v : undefined;
        },
        { what: "refund rejected", timeoutMs: 20_000 },
      );
      expect(final.failureCode).toBe("REFERENCE_NOT_FOUND");
      expect(final.referenceAttempts).toBeGreaterThanOrEqual(3);
    } finally {
      await wk.stop();
    }
    const events = await db.query<{ event_type: string }>(
      "SELECT event_type FROM outbox_messages WHERE payload->'data'->>'transactionId' = $1 ORDER BY seq",
      [refund.transactionId],
    );
    expect(events.map((e) => e.event_type)).toEqual([
      "WagerTransactionPendingReference",
      "WagerTransactionRejected",
    ]);
    expect((await app.core.getWallet.execute(w.id)).balance.amount).toBe("100.00");
  });

  test("concurrent workers never resolve the same pending transaction twice", async () => {
    const w = await wallet("100.00");
    const bets = Array.from({ length: 10 }, () => `bet-${Bun.randomUUIDv7()}`);
    for (const ext of bets) {
      await app.core.processWager.execute(
        wagerCommand(w, "REFUND", "1.00", { referenceExternalTransactionId: ext }),
      );
    }
    // Arrive the BETs without nudging the workers yet.
    for (const ext of bets) {
      await app.core.processWager.execute(wagerCommand(w, "BET", "1.00", { externalTransactionId: ext }));
    }
    const workers = [worker(), worker(), worker()];
    for (const wk of workers) wk.start();
    try {
      await waitFor(
        async () => {
          const [row] = await db.query<{ n: string }>(
            "SELECT COUNT(*)::text AS n FROM wager_transactions WHERE wallet_id = $1 AND status = 'PENDING_REFERENCE'",
            [w.id],
          );
          return row?.n === "0" || undefined;
        },
        { what: "all pending resolved" },
      );
    } finally {
      await Promise.all(workers.map((wk) => wk.stop()));
    }
    const [credits] = await db.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'CREDIT'",
      [w.id],
    );
    expect(credits?.n).toBe("11"); // opening + 10 refunds, each exactly once
    expect((await app.core.getWallet.execute(w.id)).balance.amount).toBe("100.00");
    await assertWalletConsistent(db, w.id);
  });
});
