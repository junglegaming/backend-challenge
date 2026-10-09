import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { RunningApplication } from "../../src/bootstrap";
import type { SqsGateway } from "../../src/infrastructure/messaging/sqs-gateway";
import { assertAllWalletsConsistent, assertWalletConsistent } from "../helpers/invariants";
import { drainQueue, sendWager, wagerMessage } from "../helpers/sqs-helpers";
import { ensureQueues, startTestApp, testEnv, testQueues, waitFor } from "../helpers/test-app";
import { createTestDatabase, type TestDatabase } from "../helpers/test-db";

/** Real SQS (MiniStack) + real PostgreSQL; the consumer runs inside a real application instance. */
let db: TestDatabase;
let app: RunningApplication;
let sqs: SqsGateway;
let queues: ReturnType<typeof testQueues>;

beforeAll(async () => {
  db = await createTestDatabase();
  queues = testQueues("sqs");
  const env = testEnv(db, queues, {
    APP_ROLES: "api,consumer",
    // Short lock timeout + single attempt so a held row lock turns into a transient failure quickly.
    DB_LOCK_TIMEOUT_MS: "300",
    DB_TX_MAX_ATTEMPTS: "1",
  });
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
    correlationId: "test",
  });

const txByExternal = (externalTransactionId: string) =>
  db.query<{ status: string; failure_code: string | null }>(
    "SELECT status, failure_code FROM wager_transactions WHERE external_transaction_id = $1",
    [externalTransactionId],
  );

const debits = async (walletId: string) =>
  Number(
    (
      await db.query<{ n: string }>(
        "SELECT COUNT(*)::text AS n FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'",
        [walletId],
      )
    )[0]?.n,
  );

describe("SQS consumer", () => {
  test("processes a message through the same use case, records the inbox and acks after commit", async () => {
    const w = await wallet();
    const msg = wagerMessage(w, "BET", "25.00");
    await sendWager(sqs, msg);
    const [tx] = await waitFor(
      async () => {
        const rows = await txByExternal(msg.data.externalTransactionId);
        return rows.length ? rows : undefined;
      },
      { what: "transaction processed" },
    );
    expect(tx?.status).toBe("PROCESSED");
    const inbox = await db.query("SELECT processed_at FROM inbox_messages WHERE message_id = $1", [
      msg.messageId,
    ]);
    expect(inbox[0]?.processed_at).toBeTruthy();
    // acked: the queue drains
    await waitFor(async () => (await sqs.queueDepth(queues.SQS_WAGER_QUEUE_NAME)) === 0 || undefined, {
      what: "queue drained",
    });
    expect((await app.core.getWallet.execute(w.id)).balance.amount).toBe("75.00");
  });

  test("redelivery of the same messageId is absorbed by the persistent inbox (no double debit)", async () => {
    const w = await wallet();
    const msg = wagerMessage(w, "BET", "10.00");
    // Different broker de-dup ids: SQS will deliver all three, only the inbox can stop them.
    await sendWager(sqs, msg);
    await sendWager(sqs, msg);
    await sendWager(sqs, msg);
    await waitFor(
      async () => {
        const [row] = await db.query<{ n: string }>(
          "SELECT COUNT(*)::text AS n FROM inbox_messages WHERE message_id = $1 AND processed_at IS NOT NULL",
          [msg.messageId],
        );
        return row?.n === "1" && (await sqs.queueDepth(queues.SQS_WAGER_QUEUE_NAME)) === 0 ? true : undefined;
      },
      { what: "redeliveries consumed" },
    );
    expect(await debits(w.id)).toBe(1);
    expect((await app.core.getWallet.execute(w.id)).balance.amount).toBe("90.00");
  });

  test("a different messageId carrying an already-processed idempotency key replays (no double debit)", async () => {
    const w = await wallet();
    const first = wagerMessage(w, "BET", "10.00");
    const second = { ...first, messageId: `msg-${Bun.randomUUIDv7()}` };
    await sendWager(sqs, first);
    await sendWager(sqs, second);
    await waitFor(
      async () => {
        const [row] = await db.query<{ n: string }>(
          "SELECT COUNT(*)::text AS n FROM inbox_messages WHERE message_id = ANY($1)",
          [[first.messageId, second.messageId]],
        );
        return row?.n === "2" || undefined;
      },
      { what: "both messages handled" },
    );
    expect(await debits(w.id)).toBe(1);
  });

  test("malformed messages go straight to the DLQ with a reason, without touching the database", async () => {
    await sqs.sendWager("{ not json", "poison", Bun.randomUUIDv7());
    await sqs.sendWager(
      JSON.stringify({ messageId: "m", type: "Unknown", data: {} }),
      "poison",
      Bun.randomUUIDv7(),
    );
    const dlq = await waitFor(
      async () => {
        const msgs = await drainQueue(sqs, queues.SQS_WAGER_DLQ_NAME, 1);
        return msgs.length >= 2 ? msgs : undefined;
      },
      { what: "poison messages in DLQ" },
    );
    const reasons = dlq.map((m) => m.MessageAttributes?.failureReason?.StringValue).sort();
    expect(reasons).toEqual(["INVALID_JSON", "INVALID_MESSAGE"]);
  });

  test("same idempotency key with a different payload is a permanent failure → DLQ", async () => {
    const w = await wallet();
    const original = wagerMessage(w, "BET", "5.00");
    await sendWager(sqs, original);
    await waitFor(
      async () => (await txByExternal(original.data.externalTransactionId)).length > 0 || undefined,
    );
    const conflicting = wagerMessage(w, "BET", "6.00", {
      externalTransactionId: original.data.externalTransactionId,
    });
    await sendWager(sqs, conflicting);
    const dlq = await waitFor(
      async () => {
        const msgs = await drainQueue(sqs, queues.SQS_WAGER_DLQ_NAME, 1);
        return msgs.find((m) => m.Body?.includes(conflicting.messageId));
      },
      { what: "conflict in DLQ" },
    );
    expect(dlq.MessageAttributes?.failureReason?.StringValue).toBe("IDEMPOTENCY_CONFLICT");
    expect(await debits(w.id)).toBe(1);
  });

  test("business rejections are acked (terminal), not retried", async () => {
    const w = await wallet("1.00");
    const msg = wagerMessage(w, "BET", "2.00");
    await sendWager(sqs, msg);
    const [tx] = await waitFor(async () => {
      const rows = await txByExternal(msg.data.externalTransactionId);
      return rows.length ? rows : undefined;
    });
    expect(tx).toEqual({ status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS" });
    const [inbox] = await db.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM inbox_messages WHERE message_id = $1",
      [msg.messageId],
    );
    expect(inbox?.n).toBe("1");
  });

  test("transient failures are retried with backoff and succeed once the cause clears", async () => {
    const w = await wallet();
    // Hold the wallet row lock from another session: the consumer hits lock_timeout (transient).
    const { Client } = await import("pg");
    const blocker = new Client({ connectionString: db.migratorUrl });
    await blocker.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT * FROM wallets WHERE id = $1 FOR UPDATE", [w.id]);

    const msg = wagerMessage(w, "BET", "10.00");
    await sendWager(sqs, msg);
    await Bun.sleep(1500); // at least one failed attempt
    expect(await txByExternal(msg.data.externalTransactionId)).toHaveLength(0);
    await blocker.query("ROLLBACK");
    await blocker.end();

    await waitFor(
      async () =>
        (await txByExternal(msg.data.externalTransactionId))[0]?.status === "PROCESSED" || undefined,
      {
        what: "processed after retry",
        timeoutMs: 20_000,
      },
    );
    expect(await debits(w.id)).toBe(1);
    await assertWalletConsistent(db, w.id);
  });

  test("a message that keeps failing transiently is dead-lettered by the redrive policy after maxReceiveCount", async () => {
    const w = await wallet();
    const { Client } = await import("pg");
    const blocker = new Client({ connectionString: db.migratorUrl });
    await blocker.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT * FROM wallets WHERE id = $1 FOR UPDATE", [w.id]);
    try {
      const msg = wagerMessage(w, "BET", "10.00");
      await sendWager(sqs, msg);
      const dead = await waitFor(
        async () => {
          const msgs = await drainQueue(sqs, queues.SQS_WAGER_DLQ_NAME, 1);
          return msgs.find((m) => m.Body?.includes(msg.messageId));
        },
        { what: "message redriven to DLQ", timeoutMs: 40_000, intervalMs: 500 },
      );
      expect(dead).toBeDefined();
      // Transient exhaustion stays recoverable: audited as retryable, never frozen as FAILED.
      expect(await txByExternal(msg.data.externalTransactionId)).toHaveLength(0);
      expect(dead?.MessageAttributes?.failureReason?.StringValue).toBe("RETRIES_EXHAUSTED");
      const audit = await db.query<{ reason_code: string; retryable: boolean; receive_count: number }>(
        "SELECT reason_code, retryable, receive_count FROM wager_submission_failures WHERE message_id = $1",
        [msg.messageId],
      );
      expect(audit).toEqual([{ reason_code: "RETRIES_EXHAUSTED", retryable: true, receive_count: 3 }]);
    } finally {
      await blocker.query("ROLLBACK");
      await blocker.end();
    }
  }, 60_000);
});
