import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { SqsGateway } from "../../src/infrastructure/messaging/sqs-gateway";
import { assertAllWalletsConsistent, assertWalletConsistent } from "../helpers/invariants";
import { type Instance, killAll, spawnInstance } from "../helpers/spawn";
import { drainQueue, sendWager, wagerMessage } from "../helpers/sqs-helpers";
import { type Env, ensureQueues, http, testEnv, testQueues, waitFor } from "../helpers/test-app";
import { createTestDatabase, type TestDatabase } from "../helpers/test-db";

/**
 * Separate OS processes (`bun src/main.ts`), each with its own pool and SQS client, sharing one PostgreSQL
 * database and one set of queues — the production topology, minus the load balancer.
 */
let db: TestDatabase;
let sqs: SqsGateway;
let queues: ReturnType<typeof testQueues>;
let baseEnv: Env;
let running: Instance[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
  queues = testQueues("multi");
  baseEnv = testEnv(db, queues, { DB_POOL_MAX: "15", SQS_VISIBILITY_TIMEOUT_S: "4" });
  sqs = await ensureQueues(baseEnv);
});
afterEach(async () => {
  await killAll(running);
  running = [];
});
afterAll(async () => {
  sqs.destroy();
  const n = await assertAllWalletsConsistent(db);
  expect(n).toBeGreaterThan(0);
  await db.drop();
});

async function start(name: string, env: Env = {}): Promise<Instance> {
  const instance = await spawnInstance(name, { ...baseEnv, ...env });
  running.push(instance);
  return instance;
}

async function createWallet(base: string, amount: string) {
  const res = await http<{ id: string; playerId: string }>(base, "POST", "/wallets", {
    playerId: Bun.randomUUIDv7(),
    initialBalance: { amount, currency: "BRL" },
  });
  expect(res.status).toBe(201);
  return res.body;
}

function betPayload(
  w: { id: string; playerId: string },
  amount: string,
  externalTransactionId = `tx-${Bun.randomUUIDv7()}`,
) {
  return {
    providerId: "provider-a",
    externalTransactionId,
    playerId: w.playerId,
    walletId: w.id,
    roundId: "r",
    gameId: "g",
    kind: "BET",
    money: { amount, currency: "BRL" },
  };
}

const post = (base: string, payload: { providerId: string; externalTransactionId: string }) =>
  http<{ status: string; transactionId: string; idempotentReplay: boolean }>(
    base,
    "POST",
    "/wagering/transactions",
    payload,
    {
      "Idempotency-Key": `${payload.providerId}:${payload.externalTransactionId}`,
    },
  );

async function count(sql: string, params: unknown[]): Promise<number> {
  return Number((await db.query<{ n: string }>(sql, params))[0]?.n);
}

const debitsOf = (walletId: string) =>
  count(
    "SELECT COUNT(*)::text AS n FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'",
    [walletId],
  );

describe("multiple instances", () => {
  test("4. three processes: same bet hammered through all of them, hot-wallet race, SQS consumers in parallel", async () => {
    const instances = await Promise.all([start("i1"), start("i2"), start("i3")]);
    const urls = instances.map((i) => i.url);

    // (a) the same BET 51 times, round-robin over 3 processes → one debit
    const w1 = await createWallet(urls[0] as string, "100.00");
    const same = betPayload(w1, "30.00");
    const results = await Promise.all(
      Array.from({ length: 51 }, (_, i) => post(urls[i % 3] as string, same)),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(results.filter((r) => !r.body.idempotentReplay)).toHaveLength(1);
    expect(await debitsOf(w1.id)).toBe(1);

    // (b) mandatory scenario across processes: 100.00, two 80.00 bets on different instances
    for (let round = 0; round < 5; round++) {
      const w = await createWallet(urls[0] as string, "100.00");
      const [a, b] = await Promise.all([
        post(urls[1] as string, betPayload(w, "80.00")),
        post(urls[2] as string, betPayload(w, "80.00")),
      ]);
      expect([a.body.status, b.body.status].sort()).toEqual(["PROCESSED", "REJECTED"]);
      expect(await debitsOf(w.id)).toBe(1);
      const view = await http<{ balance: { amount: string } }>(urls[0] as string, "GET", `/wallets/${w.id}`);
      expect(view.body.balance.amount).toBe("20.00");
    }

    // (c) hot wallet through SQS: 3 consumers, 30 distinct 1.00 bets + every message delivered twice
    const hot = await createWallet(urls[0] as string, "20.00");
    const messages = Array.from({ length: 30 }, () => wagerMessage(hot, "BET", "1.00"));
    await Promise.all(messages.flatMap((m) => [sendWager(sqs, m), sendWager(sqs, m)]));
    await waitFor(
      async () =>
        (await count(
          "SELECT COUNT(*)::text AS n FROM inbox_messages WHERE message_id = ANY($1) AND processed_at IS NOT NULL",
          [messages.map((m) => m.messageId)],
        )) === 30 && (await sqs.queueDepth(queues.SQS_WAGER_QUEUE_NAME)) === 0
          ? true
          : undefined,
      { what: "all hot-wallet messages consumed", timeoutMs: 60_000, intervalMs: 250 },
    );
    expect(await debitsOf(hot.id)).toBe(20);
    const hotView = await http<{ balance: { amount: string } }>(
      urls[0] as string,
      "GET",
      `/wallets/${hot.id}`,
    );
    expect(hotView.body.balance.amount).toBe("0.00");
    await assertWalletConsistent(db, hot.id);
  }, 120_000);

  test("5. consumer killed after the commit and before the ack: redelivery is absorbed, no double debit", async () => {
    // Dedicated queues: no leftover redelivery from other scenarios can reach the victim first.
    const own = testQueues("crash");
    const ownSqs = await ensureQueues({ ...baseEnv, ...own });
    const victim = await start("victim", {
      ...own,
      APP_ROLES: "consumer",
      FAULT_INJECTION: "after-commit-before-ack",
    });
    const api = await start("api-only", { ...own, APP_ROLES: "api" });
    const w = await createWallet(api.url, "100.00");
    const msg = wagerMessage(w, "BET", "40.00");
    await sendWager(ownSqs, msg);

    expect(await victim.exited).not.toBe(0); // died right after COMMIT
    expect(victim.logs.some((l) => l.includes("after-commit-before-ack"))).toBe(true);
    // The financial effect is durable even though the message was never acknowledged.
    expect(await debitsOf(w.id)).toBe(1);

    // A healthy instance picks the message up once its visibility expires.
    await start("rescuer", { ...own, APP_ROLES: "consumer" });
    await waitFor(
      async () => ((await ownSqs.queueDepth(own.SQS_WAGER_QUEUE_NAME)) === 0 ? true : undefined),
      {
        what: "redelivered message acked",
        timeoutMs: 30_000,
        intervalMs: 250,
      },
    );
    expect(await debitsOf(w.id)).toBe(1);
    const view = await http<{ balance: { amount: string } }>(api.url, "GET", `/wallets/${w.id}`);
    expect(view.body.balance.amount).toBe("60.00");
    await assertWalletConsistent(db, w.id);
    ownSqs.destroy();
  }, 60_000);

  test("6. two publishers on the same outbox, one crashing mid-flight: everything is published, duplicates are safe", async () => {
    await drainQueue(sqs, queues.SQS_EVENTS_QUEUE_NAME, 1); // start from an empty events queue
    const api = await start("api", { APP_ROLES: "api" });
    const wallets = await Promise.all(Array.from({ length: 4 }, () => createWallet(api.url, "50.00")));
    await Promise.all(
      wallets.flatMap((w) => Array.from({ length: 5 }, () => post(api.url, betPayload(w, "1.00")))),
    );
    const expected = (
      await db.query<{ id: string }>("SELECT id FROM outbox_messages WHERE published_at IS NULL")
    ).map((r) => r.id);
    expect(expected.length).toBeGreaterThan(30);

    // Publisher A publishes a batch and dies before marking it: those events will be published again.
    const crasher = await start("pub-crasher", {
      APP_ROLES: "outbox",
      FAULT_INJECTION: "after-publish-before-mark",
      OUTBOX_LEASE_MS: "1500",
    });
    expect(await crasher.exited).not.toBe(0);
    // Publisher B and C race for the rest (and for A's expired leases).
    await Promise.all([start("pub-b", { APP_ROLES: "outbox" }), start("pub-c", { APP_ROLES: "outbox" })]);
    await waitFor(
      async () =>
        (await count("SELECT COUNT(*)::text AS n FROM outbox_messages WHERE published_at IS NULL", [])) ===
          0 || undefined,
      { what: "outbox drained", timeoutMs: 30_000 },
    );

    const received = await drainQueue(sqs, queues.SQS_EVENTS_QUEUE_NAME);
    const ids = received.map((m) => m.MessageAttributes?.eventId?.StringValue as string);
    const unique = new Set(ids);
    for (const id of expected) expect(unique.has(id)).toBe(true); // nothing lost
    // Consumer-side de-dup by eventId collapses any re-publication to one effect.
    expect(unique.size).toBe(new Set(expected.concat(ids)).size);
  }, 90_000);

  test("8. kill every instance mid-traffic, restart, and prove final consistency", async () => {
    const first = await Promise.all([start("a1"), start("a2"), start("a3")]);
    const wallets = await Promise.all(
      Array.from({ length: 6 }, () => createWallet(first[0]?.url as string, "200.00")),
    );

    // Mixed traffic: HTTP on every instance + SQS messages (some delivered twice) + out-of-order rollbacks.
    const traffic: Promise<unknown>[] = [];
    const sent: { messageId: string }[] = [];
    for (const [i, w] of wallets.entries()) {
      for (let k = 0; k < 8; k++)
        traffic.push(post(first[k % 3]?.url as string, betPayload(w, "3.00")).catch(() => {}));
      const betExt = `bet-${Bun.randomUUIDv7()}`;
      const rollback = wagerMessage(w, "ROLLBACK", "7.00", { referenceExternalTransactionId: betExt });
      const bet = wagerMessage(w, "BET", "7.00", { externalTransactionId: betExt });
      sent.push(rollback, bet);
      traffic.push(sendWager(sqs, rollback), sendWager(sqs, bet), sendWager(sqs, bet));
      if (i % 2 === 0) traffic.push(sendWager(sqs, wagerMessage(w, "WIN", "11.00")));
    }
    await Bun.sleep(300); // let some of it be in flight…
    await killAll(first); // …then pull the plug on every process at once
    running = [];
    await Promise.allSettled(traffic);

    const second = await Promise.all([start("b1"), start("b2"), start("b3")]);
    await waitFor(
      async () => {
        const queueEmpty = (await sqs.queueDepth(queues.SQS_WAGER_QUEUE_NAME)) === 0;
        const outboxEmpty =
          (await count("SELECT COUNT(*)::text AS n FROM outbox_messages WHERE published_at IS NULL", [])) ===
          0;
        const nothingPending =
          (await count(
            "SELECT COUNT(*)::text AS n FROM wager_transactions WHERE status = 'PENDING_REFERENCE'",
            [],
          )) === 0;
        return queueEmpty && outboxEmpty && nothingPending ? true : undefined;
      },
      { what: "system quiescent after restart", timeoutMs: 60_000, intervalMs: 500 },
    );

    // Every SQS message that was sent was eventually applied exactly once.
    expect(
      await count(
        "SELECT COUNT(*)::text AS n FROM inbox_messages WHERE message_id = ANY($1) AND processed_at IS NOT NULL",
        [sent.map((m) => m.messageId)],
      ),
    ).toBe(sent.length);

    for (const w of wallets) {
      const report = await http<{ consistent: boolean; difference: { amount: string } }>(
        second[0]?.url as string,
        "POST",
        `/wallets/${w.id}/reconciliation`,
      );
      expect(report.body.consistent).toBe(true);
      expect(report.body.difference.amount).toBe("0.00");
      await assertWalletConsistent(db, w.id);
    }
  }, 150_000);
});
