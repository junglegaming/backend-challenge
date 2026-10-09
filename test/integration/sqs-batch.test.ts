import { afterAll, beforeAll, expect, test } from "bun:test";
import type { RunningApplication } from "../../src/bootstrap";
import type { SqsGateway } from "../../src/infrastructure/messaging/sqs-gateway";
import { assertAllWalletsConsistent, assertWalletConsistent } from "../helpers/invariants";
import { drainQueue, sendWager, wagerMessage } from "../helpers/sqs-helpers";
import { ensureQueues, startTestApp, testEnv, testQueues, waitFor } from "../helpers/test-app";
import { createTestDatabase, type TestDatabase } from "../helpers/test-db";

let db: TestDatabase;
let sqs: SqsGateway;
let queues: ReturnType<typeof testQueues>;
let env: Record<string, string>;
let api: RunningApplication;

beforeAll(async () => {
  db = await createTestDatabase();
  queues = testQueues("batch");
  env = testEnv(db, queues);
  sqs = await ensureQueues(env);
  api = await startTestApp({ ...env, APP_ROLES: "api" });
});
afterAll(async () => {
  await api.shutdown("test");
  sqs.destroy();
  await assertAllWalletsConsistent(db);
  await db.drop();
});

test("messages of one wallet received together are applied in one SQL transaction and acked together", async () => {
  const w = await api.core.createWallet.execute({
    playerId: Bun.randomUUIDv7(),
    initialBalance: { amount: "100.00", currency: "BRL" },
    correlationId: "t",
  });
  const ghost = { id: Bun.randomUUIDv7(), playerId: Bun.randomUUIDv7() };
  const bets = Array.from({ length: 9 }, () => wagerMessage(w, "BET", "1.00"));
  const ghosts = Array.from({ length: 2 }, () => wagerMessage(ghost, "BET", "1.00"));

  // Enqueue everything BEFORE any consumer runs, so the first receive returns the wallet's messages together.
  for (const m of bets.slice(0, 4)) await sendWager(sqs, m);
  await sqs.sendWager("{ malformed", w.id, Bun.randomUUIDv7()); // poison inside the same wallet group
  for (const m of bets.slice(4)) await sendWager(sqs, m);
  for (const m of ghosts) await sendWager(sqs, m);

  const consumer = await startTestApp({ ...env, APP_ROLES: "consumer" });
  try {
    await waitFor(
      async () =>
        (await sqs.queueDepth(queues.SQS_WAGER_QUEUE_NAME)) === 0 &&
        (
          await db.query("SELECT 1 FROM inbox_messages WHERE message_id = ANY($1)", [
            bets.map((b) => b.messageId),
          ])
        ).length === bets.length
          ? true
          : undefined,
      { what: "all messages handled", timeoutMs: 30_000, intervalMs: 200 },
    );
  } finally {
    await consumer.shutdown("test");
  }

  // Effects: 9 debits, exactly once.
  expect((await api.core.getWallet.execute(w.id)).balance.amount).toBe("91.00");
  await assertWalletConsistent(db, w.id);

  // Batching actually happened: lines written by one transaction share its timestamp.
  const [stats] = await db.query<{ entries: string; commits: string }>(
    `SELECT COUNT(*)::text AS entries, COUNT(DISTINCT created_at)::text AS commits
       FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`,
    [w.id],
  );
  expect(stats?.entries).toBe("9");
  expect(Number(stats?.commits)).toBeLessThan(9);

  // The poison message and the unknown-wallet group were dead-lettered and audited individually.
  const dlq = await drainQueue(sqs, queues.SQS_WAGER_DLQ_NAME);
  const reasons = dlq.map((m) => m.MessageAttributes?.failureReason?.StringValue).sort();
  expect(reasons).toEqual(["INVALID_JSON", "WALLET_NOT_FOUND", "WALLET_NOT_FOUND"]);
  const audit = await db.query<{ reason_code: string; n: string }>(
    `SELECT reason_code, COUNT(*)::text AS n FROM wager_submission_failures
      WHERE channel = 'sqs' GROUP BY reason_code ORDER BY reason_code`,
  );
  expect(audit).toEqual([
    { reason_code: "INVALID_JSON", n: "1" },
    { reason_code: "WALLET_NOT_FOUND", n: "2" },
  ]);
}, 60_000);
