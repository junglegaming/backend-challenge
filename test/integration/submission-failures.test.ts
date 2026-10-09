import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { RunningApplication } from "../../src/bootstrap";
import type { SqsGateway } from "../../src/infrastructure/messaging/sqs-gateway";
import { assertAllWalletsConsistent } from "../helpers/invariants";
import { drainQueue, sendWager, wagerMessage } from "../helpers/sqs-helpers";
import { ensureQueues, http, startTestApp, testEnv, testQueues, waitFor } from "../helpers/test-app";
import { createTestDatabase, type TestDatabase } from "../helpers/test-db";

/**
 * Audit of submissions that did not become a business outcome, and FAILED for unexpected errors that exhaust
 * their retries. Two instances: a normal API, and a consumer whose processing always throws (simulated defect).
 */
let db: TestDatabase;
let api: RunningApplication;
let broken: RunningApplication;
let sqs: SqsGateway;
let queues: ReturnType<typeof testQueues>;

beforeAll(async () => {
  db = await createTestDatabase();
  queues = testQueues("audit");
  const env = testEnv(db, queues, { SQS_MAX_RECEIVE_COUNT: "2", SQS_VISIBILITY_TIMEOUT_S: "2" });
  sqs = await ensureQueues(env);
  api = await startTestApp({ ...env, APP_ROLES: "api" });
  broken = await startTestApp({
    ...env,
    APP_ROLES: "consumer",
    FAULT_INJECTION: "consumer-unexpected-error",
  });
});
afterAll(async () => {
  await broken.shutdown("test");
  await api.shutdown("test");
  sqs.destroy();
  await assertAllWalletsConsistent(db);
  await db.drop();
});

const uuid = () => Bun.randomUUIDv7();

async function createWallet(amount = "100.00") {
  const playerId = uuid();
  const res = await http<{ id: string }>(api.url, "POST", "/wallets", {
    playerId,
    initialBalance: { amount, currency: "BRL" },
  });
  return { id: res.body.id, playerId };
}

const payload = (w: { id: string; playerId: string }, ext: string, amount: string) => ({
  providerId: "provider-a",
  externalTransactionId: ext,
  playerId: w.playerId,
  walletId: w.id,
  roundId: "r",
  gameId: "g",
  kind: "BET",
  money: { amount, currency: "BRL" },
});

const submit = (body: Record<string, unknown>, key: string) =>
  http<Record<string, unknown>>(api.url, "POST", "/wagering/transactions", body, { "Idempotency-Key": key });

const failuresOf = (ext: string) =>
  http<Record<string, unknown>[]>(
    api.url,
    "GET",
    `/providers/provider-a/wagering/transactions/${ext}/failures`,
  );

describe("HTTP submissions", () => {
  test("a malformed payload is audited, exposed to the provider and published as WagerSubmissionFailed", async () => {
    const w = await createWallet();
    const ext = `tx-${uuid()}`;
    const res = await submit(payload(w, ext, "10.5"), `provider-a:${ext}`);
    expect(res.status).toBe(400);

    const failures = await failuresOf(ext);
    expect(failures.status).toBe(200);
    expect(failures.body).toHaveLength(1);
    expect(failures.body[0]).toMatchObject({
      channel: "http",
      reasonCode: "VALIDATION_ERROR",
      category: "VALIDATION",
      retryable: false,
      idempotencyKey: `provider-a:${ext}`,
      transactionId: null,
    });
    const events = await db.query<{ event_type: string }>(
      "SELECT event_type FROM outbox_messages WHERE payload->'data'->>'externalTransactionId' = $1",
      [ext],
    );
    expect(events.map((e) => e.event_type)).toEqual(["WagerSubmissionFailed"]);
  });

  test("the audit never occupies the idempotency key: the corrected request with the same key succeeds", async () => {
    const w = await createWallet();
    const ext = `tx-${uuid()}`;
    expect((await submit(payload(w, ext, "10.5"), `provider-a:${ext}`)).status).toBe(400);
    const fixed = await submit(payload(w, ext, "10.50"), `provider-a:${ext}`);
    expect(fixed.status).toBe(201);
    expect(fixed.body.status).toBe("PROCESSED");
  });

  test("idempotency conflicts are audited and counted, the original stays untouched", async () => {
    const w = await createWallet();
    const ext = `tx-${uuid()}`;
    expect((await submit(payload(w, ext, "10.00"), `provider-a:${ext}`)).status).toBe(201);
    expect((await submit(payload(w, ext, "11.00"), `provider-a:${ext}`)).status).toBe(409);
    const failures = await failuresOf(ext);
    expect(failures.body[0]).toMatchObject({
      reasonCode: "IDEMPOTENCY_CONFLICT",
      category: "CONFLICT",
      retryable: false,
    });
    const metrics = await http<string>(api.url, "GET", "/metrics");
    expect(metrics.body).toMatch(
      /wager_idempotency_conflicts_total\{[^}]*reason="PAYLOAD_MISMATCH"[^}]*\} [1-9]/,
    );
    expect(metrics.body).toMatch(/wager_submission_failures_total\{[^}]*reason="IDEMPOTENCY_CONFLICT"/);
    const original = await http(api.url, "GET", `/providers/provider-a/wagering/transactions/${ext}`);
    expect(original.body).toMatchObject({ status: "PROCESSED", money: { amount: "10.00" } });
  });

  test("an unknown wallet is audited as retryable (resend works once the wallet exists)", async () => {
    const ext = `tx-${uuid()}`;
    const res = await submit(payload({ id: uuid(), playerId: uuid() }, ext, "1.00"), `provider-a:${ext}`);
    expect(res.status).toBe(422);
    const failures = await failuresOf(ext);
    expect(failures.body[0]).toMatchObject({
      reasonCode: "WALLET_NOT_FOUND",
      category: "UNPROCESSABLE",
      retryable: true,
    });
  });
});

describe("SQS submissions", () => {
  test("an unexpected error that exhausts its retries becomes FAILED (auditable, terminal, no balance effect)", async () => {
    const w = await createWallet("100.00");
    const msg = wagerMessage(w, "BET", "30.00");
    await sendWager(sqs, msg);

    const tx = await waitFor(
      async () => {
        const res = await http<Record<string, unknown>>(
          api.url,
          "GET",
          `/providers/provider-a/wagering/transactions/${msg.data.externalTransactionId}`,
        );
        return res.status === 200 ? res.body : undefined;
      },
      { what: "FAILED transaction recorded", timeoutMs: 30_000, intervalMs: 250 },
    );
    expect(tx).toMatchObject({
      status: "FAILED",
      failureCode: "INFRA_PERMANENT_FAILURE",
      balance: { amount: "100.00", currency: "BRL" },
    });
    const wallet = await http<{ balance: { amount: string }; version: number }>(
      api.url,
      "GET",
      `/wallets/${w.id}`,
    );
    expect(wallet.body).toMatchObject({ balance: { amount: "100.00" }, version: 1 });

    const failures = await failuresOf(msg.data.externalTransactionId);
    expect(failures.body[0]).toMatchObject({
      channel: "sqs",
      reasonCode: "UNEXPECTED_ERROR",
      category: "INFRASTRUCTURE",
      retryable: false,
      messageId: msg.messageId,
      transactionId: tx.transactionId,
      receiveCount: 2,
    });

    const events = await db.query<{ event_type: string }>(
      `SELECT event_type FROM outbox_messages
        WHERE payload->'data'->>'externalTransactionId' = $1 ORDER BY seq`,
      [msg.data.externalTransactionId],
    );
    expect(events.map((e) => e.event_type).sort()).toEqual([
      "WagerSubmissionFailed",
      "WagerTransactionFailed",
    ]);

    const dead = await waitFor(
      async () => {
        const msgs = await drainQueue(sqs, queues.SQS_WAGER_DLQ_NAME, 1);
        return msgs.find((m) => m.Body?.includes(msg.messageId));
      },
      { what: "message in DLQ" },
    );
    expect(dead.MessageAttributes?.failureReason?.StringValue).toBe("UNEXPECTED_ERROR");

    // FAILED is terminal and idempotent: resending the same key replays it (422, never a debit).
    const { idempotencyKey: _key, ...sameBody } = msg.data;
    const replay = await submit(sameBody, msg.data.idempotencyKey);
    expect(replay.status).toBe(422);
    expect(replay.body).toMatchObject({
      status: "FAILED",
      failureCode: "INFRA_PERMANENT_FAILURE",
      idempotentReplay: true,
    });
  }, 60_000);

  test("a poison message is audited with its messageId", async () => {
    await sqs.sendWager(
      JSON.stringify({
        messageId: "poison-1",
        type: "WagerTransactionRequested",
        data: { providerId: "provider-a" },
      }),
      "poison",
      uuid(),
    );
    const rows = await waitFor(
      async () => {
        const r = await db.query<{ reason_code: string; category: string; retryable: boolean }>(
          "SELECT reason_code, category, retryable FROM wager_submission_failures WHERE message_id = 'poison-1'",
        );
        return r.length ? r : undefined;
      },
      { what: "poison audited", timeoutMs: 15_000 },
    );
    expect(rows[0]).toEqual({ reason_code: "INVALID_MESSAGE", category: "VALIDATION", retryable: false });
  });
});

describe("schema", () => {
  test("audit rows are immutable; the runtime role may only insert, read and purge", async () => {
    const [row] = await db.query<{ id: string }>("SELECT id FROM wager_submission_failures LIMIT 1");
    expect(row).toBeDefined();
    await expect(
      db.query("UPDATE wager_submission_failures SET reason_code = 'X_X' WHERE id = $1", [row?.id]),
    ).rejects.toThrow(/forbidden/);
    await expect(
      db.queryAsApp("DELETE FROM wager_submission_failures WHERE id = $1", [row?.id]),
    ).resolves.toBeDefined();
  });
});
