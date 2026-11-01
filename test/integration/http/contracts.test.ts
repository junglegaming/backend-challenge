import { afterAll, afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { managerFor } from "../../../src/shared/infrastructure/unit-of-work";
import { assertLedgerInvariant, testDatabase } from "../../support/database";
import {
  apiRequest,
  errorBody,
  httpWager,
  jsonBody,
  LedgerPageBody,
  openHttpWallet,
  submissionBody,
  submitHttp,
} from "../../support/http";
import { apiUrl, command, containersOf } from "../../support/stack";

const { database, uow } = testDatabase();
afterEach(() => assertLedgerInvariant(database));
afterAll(() => database.onModuleDestroy());

test("HTTP opening, queries, ledger and reconciliation preserve the exact contracts", async () => {
  const wallet = await openHttpWallet();
  expect(wallet).toEqual({
    id: expect.any(String),
    playerId: expect.any(String),
    balance: { amount: "100.00", currency: "BRL" },
    version: 1,
  });
  const get = await apiRequest(`/wallets/${wallet.id}`);
  expect(get.status).toBe(200);
  expect(await get.json()).toEqual(wallet);
  const command = httpWager(wallet);
  const submitted = await submitHttp(command);
  expect(submitted.status).toBe(200);
  const transaction = await submissionBody(submitted);
  expect(transaction).toEqual({
    transactionId: expect.any(String),
    status: "PROCESSED",
    balance: { amount: "90.00", currency: "BRL" },
    idempotentReplay: false,
  });
  for (const path of [
    `/wagering/transactions/${transaction.transactionId}`,
    `/providers/provider-a/wagering/transactions/${command.externalTransactionId}`,
  ]) {
    const result = await apiRequest(path, { client: "provider-a" });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      ...command,
      transactionId: transaction.transactionId,
      status: transaction.status,
      balance: transaction.balance,
    });
  }
  const ledger = await apiRequest(`/wallets/${wallet.id}/ledger`);
  expect(ledger.status).toBe(200);
  const page = await jsonBody<LedgerPageBody>(ledger);
  expect(page.nextCursor).toBeNull();
  expect(
    page.items.map((entry: { direction: string; walletVersion: number }) => [
      entry.direction,
      entry.walletVersion,
    ]),
  ).toEqual([
    ["CREDIT", 1],
    ["DEBIT", 2],
  ]);
  const reconciliation = await apiRequest(`/wallets/${wallet.id}/reconciliation`, {
    method: "POST",
  });
  expect(reconciliation.status).toBe(200);
  expect(await reconciliation.json()).toEqual({
    walletId: wallet.id,
    storedBalance: { amount: "90.00", currency: "BRL" },
    calculatedBalance: { amount: "90.00", currency: "BRL" },
    difference: { amount: "0.00", currency: "BRL" },
    consistent: true,
    checkedEntries: 2,
  });
});

test.each([
  ["PROCESSED", 200, "100.00", {}],
  [
    "PENDING_REFERENCE",
    202,
    "100.00",
    { kind: "REFUND", referenceExternalTransactionId: "not-arrived" },
  ],
  ["REJECTED", 422, "0.00", {}],
  ["FAILED", 500, "9999999999999999.99", { kind: "WIN" }],
] as const)(
  "HTTP %s new and replay retain status %d and original body",
  async (status, code, amount, overrides) => {
    const wallet = await openHttpWallet(amount);
    const body = httpWager(wallet, overrides);
    const key = randomUUID();
    const first = await submitHttp(body, key);
    expect(first.status).toBe(code);
    const original = await submissionBody(first);
    expect(original.status).toBe(status);
    if (status === "REJECTED") expect(original.failureCode).toBe("INSUFFICIENT_FUNDS");
    if (status === "FAILED") expect(original.failureCode).toBe("PERMANENT_PROCESSING_ERROR");
    const replay = await submitHttp(body, key);
    expect(replay.status).toBe(code);
    expect(await replay.json()).toEqual({ ...original, idempotentReplay: true });
  },
);

test("HTTP conflicts distinguish key, external id and duplicate wallet", async () => {
  const wallet = await openHttpWallet();
  const duplicate = await apiRequest("/wallets", {
    method: "POST",
    body: { playerId: wallet.playerId, initialBalance: wallet.balance },
  });
  expect(duplicate.status).toBe(409);
  expect((await errorBody(duplicate)).error.code).toBe("WALLET_ALREADY_EXISTS");
  const body = httpWager(wallet);
  const key = randomUUID();
  expect((await submitHttp(body, key)).status).toBe(200);
  const keyConflict = await submitHttp(
    { ...body, money: { amount: "20.00", currency: "BRL" } },
    key,
  );
  expect(keyConflict.status).toBe(409);
  expect((await errorBody(keyConflict)).error.code).toBe("IDEMPOTENCY_CONFLICT");
  const externalConflict = await submitHttp(body);
  expect(externalConflict.status).toBe(409);
  expect((await errorBody(externalConflict)).error.code).toBe("EXTERNAL_TRANSACTION_CONFLICT");
});

test("HTTP missing resources are 404 and unknown wallets are persisted rejections with null balance", async () => {
  const id = randomUUID();
  for (const [path, method] of [
    [`/wallets/${id}`, "GET"],
    [`/wallets/${id}/ledger`, "GET"],
    [`/wallets/${id}/reconciliation`, "POST"],
    [`/wagering/transactions/${id}`, "GET"],
    [`/providers/provider-a/wagering/transactions/${id}`, "GET"],
  ] as const) {
    const response = await apiRequest(path, { method });
    expect(response.status).toBe(404);
    expect((await errorBody(response)).error.code).toBe("NOT_FOUND");
  }
  const response = await submitHttp(httpWager({ id, playerId: randomUUID() }));
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({ failureCode: "WALLET_NOT_FOUND", balance: null });
});

test("HTTP transient wallet lock returns 503 Retry-After and safe retry applies once", async () => {
  const wallet = await openHttpWallet();
  const body = httpWager(wallet);
  const key = randomUUID();
  let release!: () => void;
  let locked!: () => void;
  const lockReady = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lock = uow.run(async (tx) => {
    await managerFor(tx).execute("SELECT id FROM wallets WHERE id = ? FOR UPDATE", [wallet.id]);
    locked();
    await barrier;
  });
  try {
    await lockReady;
    const response = await submitHttp(body, key);
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
    expect(await response.json()).toEqual({
      error: {
        code: "TEMPORARILY_UNAVAILABLE",
        message: expect.any(String),
        correlationId: response.headers.get("X-Correlation-Id"),
        details: [],
      },
    });
  } finally {
    release();
    await lock;
  }
  const result = await submitHttp(body, key);
  expect(result.status).toBe(200);
  expect((await submissionBody(result)).idempotentReplay).toBe(false);
  expect(
    (await jsonBody<{ balance: { amount: string } }>(await apiRequest(`/wallets/${wallet.id}`)))
      .balance.amount,
  ).toBe("90.00");
});

test("ledger cursor remains stable when new entries arrive between pages", async () => {
  const wallet = await openHttpWallet();
  for (let i = 0; i < 3; i++) expect((await submitHttp(httpWager(wallet))).status).toBe(200);
  const first = await jsonBody<LedgerPageBody>(
    await apiRequest(`/wallets/${wallet.id}/ledger?limit=2`),
  );
  expect(first.items.map((entry: { walletVersion: number }) => entry.walletVersion)).toEqual([
    1, 2,
  ]);
  expect(typeof first.nextCursor).toBe("string");
  expect((await submitHttp(httpWager(wallet))).status).toBe(200);
  const second = await jsonBody<LedgerPageBody>(
    await apiRequest(`/wallets/${wallet.id}/ledger?limit=2&cursor=${first.nextCursor}`),
  );
  expect(second.items.map((entry: { walletVersion: number }) => entry.walletVersion)).toEqual([
    3, 4,
  ]);
  const last = await jsonBody<LedgerPageBody>(
    await apiRequest(`/wallets/${wallet.id}/ledger?limit=2&cursor=${second.nextCursor}`),
  );
  expect(last.items.map((entry: { walletVersion: number }) => entry.walletVersion)).toEqual([5]);
  expect(last.nextCursor).toBeNull();
});

test("health is public, internal metrics are public, and Nginx keeps metrics private", async () => {
  for (const path of ["/health/live", "/health/ready"])
    expect((await fetch(`${apiUrl}${path}`)).status).toBe(200);
  expect((await fetch(`${apiUrl}/metrics`)).status).toBe(404);
  const api = (await containersOf("api"))[0];
  if (!api) throw new Error("Missing API replica");
  const status = await command([
    "docker",
    "exec",
    api,
    "bun",
    "-e",
    "const r=await fetch('http://127.0.0.1:3000/metrics');console.log(r.status)",
  ]);
  expect(status.trim()).toBe("200");
});

test("correlation id is propagated and unsafe supplied values are replaced", async () => {
  const missing = await apiRequest(`/wallets/${randomUUID()}`, {
    headers: { "X-Correlation-Id": "test-correlation:123" },
  });
  expect(missing.status).toBe(404);
  expect(missing.headers.get("X-Correlation-Id")).toBe("test-correlation:123");
  expect((await errorBody(missing)).error.correlationId).toBe("test-correlation:123");
  const unsafe = await apiRequest("/wallets", {
    method: "POST",
    body: {},
    headers: { "X-Correlation-Id": "bad id" },
  });
  expect(unsafe.status).toBe(400);
  expect(unsafe.headers.get("X-Correlation-Id")).toMatch(/^[0-9a-f-]{36}$/);
});
