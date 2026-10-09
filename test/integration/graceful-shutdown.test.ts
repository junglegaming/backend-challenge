import { afterAll, beforeAll, expect, test } from "bun:test";
import type { SqsGateway } from "../../src/infrastructure/messaging/sqs-gateway";
import { assertAllWalletsConsistent } from "../helpers/invariants";
import { sendWager, wagerMessage } from "../helpers/sqs-helpers";
import { ensureQueues, http, startTestApp, testEnv, testQueues, waitFor } from "../helpers/test-app";
import { createTestDatabase, type TestDatabase } from "../helpers/test-db";

let db: TestDatabase;
let sqs: SqsGateway;
let env: Record<string, string>;

beforeAll(async () => {
  db = await createTestDatabase();
  env = testEnv(db, testQueues("shutdown"), { SQS_CONSUMER_CONCURRENCY: "4" });
  sqs = await ensureQueues(env);
});
afterAll(async () => {
  sqs.destroy();
  await assertAllWalletsConsistent(db);
  await db.drop();
});

test("SIGTERM path: readiness flips to 503, in-flight work completes, held messages are handed back, leases released", async () => {
  const first = await startTestApp(env);
  const wallets = await Promise.all(
    Array.from({ length: 8 }, () =>
      first.core.createWallet.execute({
        playerId: Bun.randomUUIDv7(),
        initialBalance: { amount: "100.00", currency: "BRL" },
        correlationId: "t",
      }),
    ),
  );
  const messages = wallets.flatMap((w) => Array.from({ length: 5 }, () => wagerMessage(w, "BET", "1.00")));
  await Promise.all(messages.map((m) => sendWager(sqs, m)));
  await Bun.sleep(200); // some messages are now in flight on this instance

  const draining = first.shutdown("SIGTERM");
  // While draining, readiness must already report not ready (load balancers stop routing first).
  const ready = await http(first.url, "GET", "/health/ready").catch(() => undefined);
  if (ready) expect(ready.status).toBe(503);
  await draining;

  const leased = await db.query<{ n: string }>(
    "SELECT COUNT(*)::text AS n FROM outbox_messages WHERE locked_by IS NOT NULL AND published_at IS NULL",
  );
  expect(leased[0]?.n).toBe("0");

  // A fresh instance finishes the remaining work; nothing is lost or applied twice.
  const second = await startTestApp(env);
  try {
    await waitFor(
      async () => {
        const [row] = await db.query<{ n: string }>(
          "SELECT COUNT(*)::text AS n FROM inbox_messages WHERE message_id = ANY($1) AND processed_at IS NOT NULL",
          [messages.map((m) => m.messageId)],
        );
        return row?.n === String(messages.length) || undefined;
      },
      { what: "all messages processed exactly once", timeoutMs: 30_000 },
    );
    for (const w of wallets) {
      expect((await second.core.getWallet.execute(w.id)).balance.amount).toBe("95.00");
    }
  } finally {
    await second.shutdown("test");
  }
}, 60_000);
