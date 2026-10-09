import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { RunningApplication } from "../../src/bootstrap";
import { assertAllWalletsConsistent } from "../helpers/invariants";
import { ensureQueues, http, startTestApp, testEnv, testQueues } from "../helpers/test-app";
import { createTestDatabase, type TestDatabase } from "../helpers/test-db";

let db: TestDatabase;
let app: RunningApplication;
let base: string;

beforeAll(async () => {
  db = await createTestDatabase();
  const env = testEnv(db, testQueues("http"), { APP_ROLES: "api" });
  (await ensureQueues(env)).destroy();
  app = await startTestApp(env);
  base = app.url;
});
afterAll(async () => {
  await app.shutdown("test");
  await assertAllWalletsConsistent(db);
  await db.drop();
});

const uuid = () => Bun.randomUUIDv7();

async function createWallet(amount = "1000.00") {
  const playerId = uuid();
  const res = await http<{ id: string; playerId: string; balance: { amount: string }; version: number }>(
    base,
    "POST",
    "/wallets",
    { playerId, initialBalance: { amount, currency: "BRL" } },
  );
  expect(res.status).toBe(201);
  return res.body;
}

function wager(
  w: { id: string; playerId: string },
  kind: string,
  amount: string,
  extra: Record<string, unknown> = {},
) {
  const externalTransactionId = (extra.externalTransactionId as string) ?? `tx-${uuid()}`;
  return {
    providerId: "provider-a",
    externalTransactionId,
    playerId: w.playerId,
    walletId: w.id,
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind,
    money: { amount, currency: "BRL" },
    ...extra,
  };
}

const submit = (payload: Record<string, unknown>, key?: string, headers: Record<string, string> = {}) =>
  http<Record<string, unknown>>(base, "POST", "/wagering/transactions", payload, {
    ...(key === undefined
      ? { "Idempotency-Key": `${payload.providerId}:${payload.externalTransactionId}` }
      : key
        ? { "Idempotency-Key": key }
        : {}),
    ...headers,
  });

describe("health", () => {
  test("liveness and readiness are open (no auth) and report dependencies", async () => {
    expect((await http(base, "GET", "/health/live")).status).toBe(200);
    const ready = await http<{ status: string; checks: Record<string, { ok: boolean }> }>(
      base,
      "GET",
      "/health/ready",
    );
    expect(ready.status).toBe(200);
    expect(ready.body.checks.postgres?.ok).toBe(true);
    expect(ready.body.checks.sqs?.ok).toBe(true);
  });

  test("metrics endpoint exposes business metrics", async () => {
    const res = await http<string>(base, "GET", "/metrics");
    expect(res.status).toBe(200);
    expect(res.body).toContain("wager_transactions_total");
    expect(res.body).toContain("outbox_lag_seconds");
  });
});

describe("wallets", () => {
  test("create returns the contract shape and duplicate is 409", async () => {
    const playerId = uuid();
    const body = { playerId, initialBalance: { amount: "1000.00", currency: "BRL" } };
    const created = await http(base, "POST", "/wallets", body);
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      id: expect.any(String),
      playerId,
      balance: { amount: "1000.00", currency: "BRL" },
      version: 1,
    });
    const dup = await http(base, "POST", "/wallets", body);
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("WALLET_ALREADY_EXISTS");
    expect(dup.headers.get("x-correlation-id")).toBeTruthy();
  });

  test("invalid money is 400 with field issues", async () => {
    for (const amount of ["10", "10.001", "-1.00", "1e3", 10]) {
      const res = await http(base, "POST", "/wallets", {
        playerId: uuid(),
        initialBalance: { amount, currency: "BRL" },
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
    }
  });

  test("GET unknown wallet is 404; malformed id is 400", async () => {
    expect((await http(base, "GET", `/wallets/${uuid()}`)).status).toBe(404);
    expect((await http(base, "GET", "/wallets/not-a-uuid")).status).toBe(400);
  });

  test("reconciliation reports consistency", async () => {
    const w = await createWallet("975.00");
    const res = await http(base, "POST", `/wallets/${w.id}/reconciliation`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      walletId: w.id,
      storedBalance: { amount: "975.00", currency: "BRL" },
      calculatedBalance: { amount: "975.00", currency: "BRL" },
      difference: { amount: "0.00", currency: "BRL" },
      consistent: true,
      checkedEntries: 1,
    });
  });
});

describe("POST /wagering/transactions — status mapping", () => {
  test("201 processed, replay keeps 201 with idempotentReplay + header", async () => {
    const w = await createWallet();
    const payload = wager(w, "BET", "25.00");
    const first = await submit(payload);
    expect(first.status).toBe(201);
    expect(first.body).toEqual({
      transactionId: expect.any(String),
      status: "PROCESSED",
      balance: { amount: "975.00", currency: "BRL" },
      idempotentReplay: false,
    });
    const replay = await submit(payload);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
  });

  test("409 when the same key carries a different payload", async () => {
    const w = await createWallet();
    const payload = wager(w, "BET", "25.00");
    await submit(payload);
    const res = await submit({ ...payload, money: { amount: "25.01", currency: "BRL" } });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "IDEMPOTENCY_CONFLICT", details: { reason: "PAYLOAD_MISMATCH" } });
  });

  test("422 business rejection carries a stable failureCode and is persisted", async () => {
    const w = await createWallet("10.00");
    const res = await submit(wager(w, "BET", "10.01"));
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      status: "REJECTED",
      failureCode: "INSUFFICIENT_FUNDS",
      balance: { amount: "10.00" },
    });
    const view = await http(base, "GET", `/wagering/transactions/${res.body.transactionId}`);
    expect(view.body).toMatchObject({ status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS" });
  });

  test("202 when the reference has not arrived yet", async () => {
    const w = await createWallet();
    const res = await submit(wager(w, "ROLLBACK", "25.00", { referenceExternalTransactionId: "not-yet" }));
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("PENDING_REFERENCE");
  });

  test("400 for malformed payloads, missing header, OPENING kind and reserved provider", async () => {
    const w = await createWallet();
    expect((await submit(wager(w, "BET", "1.00"), "")).status).toBe(400); // missing Idempotency-Key
    expect((await submit(wager(w, "OPENING", "1.00"))).status).toBe(400);
    expect((await submit(wager(w, "BET", "1.00", { providerId: "system" }))).status).toBe(400);
    expect((await submit(wager(w, "BET", "1.00", { unexpected: true }))).status).toBe(400);
    expect((await submit(wager(w, "REFUND", "1.00"))).status).toBe(400); // reference required
    expect((await submit(wager(w, "BET", "1.5"))).status).toBe(400);
    const raw = await http(base, "POST", "/wagering/transactions", "{not json", { "Idempotency-Key": "k" });
    expect(raw.status).toBe(400);
  });

  test("422 WALLET_NOT_FOUND for an unknown wallet", async () => {
    const res = await submit(wager({ id: uuid(), playerId: uuid() }, "BET", "1.00"));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("WALLET_NOT_FOUND");
  });

  test("lookups by id and by provider external id", async () => {
    const w = await createWallet();
    const payload = wager(w, "BET", "5.00");
    const created = await submit(payload);
    const byId = await http(base, "GET", `/wagering/transactions/${created.body.transactionId}`);
    const byExt = await http(
      base,
      "GET",
      `/providers/provider-a/wagering/transactions/${payload.externalTransactionId}`,
    );
    expect(byId.status).toBe(200);
    expect(byExt.body).toEqual(byId.body);
    expect((await http(base, "GET", `/providers/provider-a/wagering/transactions/nope`)).status).toBe(404);
  });

  test("ledger pagination is stable and opaque; bad cursor is 400", async () => {
    const w = await createWallet("100.00");
    for (let i = 0; i < 3; i++) await submit(wager(w, "BET", "1.00"));
    const p1 = await http<{ items: { walletVersion: number }[]; nextCursor: string }>(
      base,
      "GET",
      `/wallets/${w.id}/ledger?limit=2`,
    );
    expect(p1.body.items.map((i) => i.walletVersion)).toEqual([4, 3]);
    const p2 = await http<{ items: { walletVersion: number }[]; nextCursor: string | null }>(
      base,
      "GET",
      `/wallets/${w.id}/ledger?limit=2&cursor=${p1.body.nextCursor}`,
    );
    expect(p2.body.items.map((i) => i.walletVersion)).toEqual([2, 1]);
    expect(p2.body.nextCursor).toBeNull();
    expect((await http(base, "GET", `/wallets/${w.id}/ledger?cursor=garbage`)).status).toBe(400);
  });
});
