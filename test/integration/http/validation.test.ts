import { afterAll, afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { assertLedgerInvariant, testDatabase } from "../../support/database";
import { apiRequest, errorBody, httpWager, openHttpWallet, submitHttp } from "../../support/http";
import { apiUrl } from "../../support/stack";
import { accessToken } from "../../support/tokens";

const { database } = testDatabase();
afterEach(() => assertLedgerInvariant(database));
afterAll(() => database.onModuleDestroy());

test("HTTP validation rejects malformed money, identifiers, unknown fields and invalid references before SQL", async () => {
  const wallet = await openHttpWallet();
  const base = httpWager(wallet);
  const invalid = [
    { ...base, money: { amount: 10, currency: "BRL" } },
    ...["025.00", "25", "25.5", "1e3", "-1.00", "", "0.001", "10000000000000000.00"].map(
      (amount) => ({ ...base, money: { amount, currency: "BRL" } }),
    ),
    { ...base, money: [{ amount: "10.00", currency: "BRL" }] },
    { ...base, money: { amount: "10.00", currency: "BRL", extra: true } },
    { ...base, kind: "OPENING" },
    { ...base, kind: "unknown" },
    { ...base, extra: true },
    { ...base, walletId: [wallet.id] },
    { ...base, walletId: "invalid" },
    { ...base, referenceExternalTransactionId: base.externalTransactionId, kind: "REFUND" },
    { ...base, referenceExternalTransactionId: "reference" },
    { ...base, kind: "REFUND" },
    { ...base, referenceExternalTransactionId: null, kind: "WIN" },
  ];
  for (const body of invalid) {
    const response = await submitHttp(body);
    expect(response.status).toBe(400);
    expect((await errorBody(response)).error.code).toBe("VALIDATION_FAILED");
  }
  const orm = await database.orm;
  expect(
    await orm.em
      .getConnection()
      .execute("SELECT id FROM wager_transactions WHERE external_transaction_id = ?", [
        base.externalTransactionId,
      ]),
  ).toEqual([]);
});

test("HTTP validates required and printable 255-character idempotency headers", async () => {
  const wallet = await openHttpWallet();
  const body = httpWager(wallet);
  const missing = await apiRequest("/wagering/transactions", {
    method: "POST",
    client: "provider-a",
    body,
  });
  expect(missing.status).toBe(400);
  expect((await errorBody(missing)).error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  for (const key of ["", "x".repeat(256)]) {
    const response = await submitHttp(body, key);
    expect(response.status).toBe(400);
    expect((await errorBody(response)).error.code).toBe("VALIDATION_FAILED");
  }
  const key = `${"x".repeat(120)} printable key ${"y".repeat(120)}`;
  const accepted = await submitHttp(body, key);
  expect(accepted.status).toBe(200);
});

test("HTTP rejects invalid ledger queries, cross-wallet cursors and malformed resource ids", async () => {
  const wallet = await openHttpWallet();
  for (const query of [
    "cursor=bad",
    "cursor=e30",
    "cursor=***",
    "limit=0",
    "limit=-1",
    "limit=1.5",
    "limit=2&limit=3",
    "extra=1",
  ]) {
    const response = await apiRequest(`/wallets/${wallet.id}/ledger?${query}`);
    expect(response.status).toBe(400);
    expect((await errorBody(response)).error.code).toBe(
      query.startsWith("cursor") ? "INVALID_CURSOR" : "VALIDATION_FAILED",
    );
  }
  const cursor = Buffer.from(JSON.stringify({ walletId: randomUUID(), walletVersion: 1 })).toString(
    "base64url",
  );
  expect((await apiRequest(`/wallets/${wallet.id}/ledger?cursor=${cursor}`)).status).toBe(400);
  expect((await apiRequest("/wallets/invalid")).status).toBe(400);
  expect((await apiRequest(`/wallets/${wallet.id}/ledger?limit=1000`)).status).toBe(200);
});

test("HTTP rejects invalid opening objects and malformed JSON with the error envelope", async () => {
  for (const body of [
    {},
    { playerId: [randomUUID()], initialBalance: { amount: "0.00", currency: "BRL" } },
    { playerId: randomUUID(), initialBalance: { amount: 10, currency: "BRL" } },
    { playerId: randomUUID(), initialBalance: { amount: "0.00", currency: "BRL" }, extra: true },
  ]) {
    const response = await apiRequest("/wallets", { method: "POST", body });
    expect(response.status).toBe(400);
    expect((await errorBody(response)).error.code).toBe("VALIDATION_FAILED");
  }
  const response = await fetch(`${apiUrl}/wallets`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await accessToken("platform-operator")}`,
      "Content-Type": "application/json",
    },
    body: "{",
  });
  expect(response.status).toBe(400);
  expect((await errorBody(response)).error).toMatchObject({
    code: "VALIDATION_FAILED",
    correlationId: expect.any(String),
    details: [],
  });
});
