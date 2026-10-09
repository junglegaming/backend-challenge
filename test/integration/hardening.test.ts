import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Request } from "express";
import type { RunningApplication } from "../../src/bootstrap";
import type { ProviderIdentityPort, ProviderPrincipal } from "../../src/modules/auth/provider-auth";
import { assertAllWalletsConsistent } from "../helpers/invariants";
import { ensureQueues, http, startTestApp, testEnv, testQueues } from "../helpers/test-app";
import { createTestDatabase, type TestDatabase } from "../helpers/test-db";

/**
 * Regressions found in the end-to-end review: UUID case, provider-scoped idempotency keys, authorisation
 * (scopes + resource ownership), audit write-amplification and CORS posture.
 */

/** Test adapter: the principal comes from headers, so one app can be called as different providers. */
class HeaderIdentity implements ProviderIdentityPort {
  async resolve(req: Request): Promise<ProviderPrincipal | undefined> {
    const providerId = req.header("x-test-provider");
    if (!providerId) return undefined;
    return { providerId, subject: providerId, scopes: (req.header("x-test-scopes") ?? "").split(",") };
  }
}

let db: TestDatabase;
let open: RunningApplication; // no-op identity (trusted internal caller)
let secured: RunningApplication; // header identity

beforeAll(async () => {
  db = await createTestDatabase();
  const env = testEnv(db, testQueues("hardening"), { APP_ROLES: "api" });
  (await ensureQueues(env)).destroy();
  open = await startTestApp(env);
  secured = await startTestApp(env, { identity: new HeaderIdentity() });
});
afterAll(async () => {
  await Promise.all([open.shutdown("test"), secured.shutdown("test")]);
  await assertAllWalletsConsistent(db);
  await db.drop();
});

const uuid = () => Bun.randomUUIDv7();

async function createWallet() {
  const res = await http<{ id: string; playerId: string }>(open.url, "POST", "/wallets", {
    playerId: uuid(),
    initialBalance: { amount: "100.00", currency: "BRL" },
  });
  expect(res.status).toBe(201);
  return res.body;
}

const bet = (w: { id: string; playerId: string }, providerId = "provider-a", ext = `tx-${uuid()}`) => ({
  providerId,
  externalTransactionId: ext,
  playerId: w.playerId,
  walletId: w.id,
  roundId: "round-1",
  gameId: "fortune-chimp",
  kind: "BET",
  money: { amount: "1.00", currency: "BRL" },
});

const asProvider = (providerId: string, scopes = "wagers:submit,wagers:read") => ({
  "x-test-provider": providerId,
  "x-test-scopes": scopes,
});

describe("UUID case", () => {
  test("upper-case walletId and playerId are the same wallet and player (no 500, no false mismatch)", async () => {
    const w = await createWallet();
    const payload = bet(w);
    const upper = { ...payload, walletId: w.id.toUpperCase(), playerId: w.playerId.toUpperCase() };
    const key = `provider-a:${payload.externalTransactionId}`;

    const first = await http(open.url, "POST", "/wagering/transactions", upper, { "Idempotency-Key": key });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ status: "PROCESSED", balance: { amount: "99.00" } });

    // Same request spelled in lower case: a replay, not a conflict.
    const again = await http(open.url, "POST", "/wagering/transactions", payload, { "Idempotency-Key": key });
    expect(again.status).toBe(201);
    expect(again.body).toMatchObject({ idempotentReplay: true, transactionId: first.body.transactionId });

    const stored = await http(open.url, "GET", `/wagering/transactions/${String(first.body.transactionId)}`);
    expect(stored.body).toMatchObject({ walletId: w.id, playerId: w.playerId });
  });
});

describe("idempotency keys are scoped per provider", () => {
  test("two providers may use the same key; neither sees the other's transaction", async () => {
    const a = await createWallet();
    const b = await createWallet();
    const key = `shared-${uuid()}`;
    const ra = await http(open.url, "POST", "/wagering/transactions", bet(a, "provider-a"), {
      "Idempotency-Key": key,
    });
    const rb = await http(open.url, "POST", "/wagering/transactions", bet(b, "provider-b"), {
      "Idempotency-Key": key,
    });
    expect([ra.status, rb.status]).toEqual([201, 201]);
    expect(rb.body.idempotentReplay).toBe(false);
    expect(rb.body.transactionId).not.toBe(ra.body.transactionId);
  });
});

describe("authorisation", () => {
  test("no credentials → 401; health stays public", async () => {
    expect((await http(secured.url, "GET", `/wagering/transactions/${uuid()}`)).status).toBe(401);
    expect((await http(secured.url, "GET", "/health/live")).status).toBe(200);
  });

  test("a provider cannot act as another provider", async () => {
    const w = await createWallet();
    const res = await http(secured.url, "POST", "/wagering/transactions", bet(w, "provider-a"), {
      "Idempotency-Key": uuid(),
      ...asProvider("provider-b"),
    });
    expect(res.status).toBe(403);
  });

  test("another provider's transaction is indistinguishable from a missing one (404)", async () => {
    const w = await createWallet();
    const created = await http(secured.url, "POST", "/wagering/transactions", bet(w, "provider-a"), {
      "Idempotency-Key": uuid(),
      ...asProvider("provider-a"),
    });
    expect(created.status).toBe(201);
    const path = `/wagering/transactions/${String(created.body.transactionId)}`;
    expect((await http(secured.url, "GET", path, undefined, asProvider("provider-a"))).status).toBe(200);
    const foreign = await http(secured.url, "GET", path, undefined, asProvider("provider-b"));
    expect(foreign.status).toBe(404);
    expect(foreign.body).toMatchObject({ code: "TRANSACTION_NOT_FOUND" });
  });

  test("wallet management (creates money) and wallet reads require back-office scopes", async () => {
    const body = { playerId: uuid(), initialBalance: { amount: "1000000.00", currency: "BRL" } };
    expect((await http(secured.url, "POST", "/wallets", body, asProvider("provider-a"))).status).toBe(403);
    const w = await createWallet();
    expect(
      (await http(secured.url, "GET", `/wallets/${w.id}`, undefined, asProvider("provider-a"))).status,
    ).toBe(403);
    const backOffice = asProvider("back-office", "wallets:read,wallets:manage");
    expect((await http(secured.url, "POST", "/wallets", body, backOffice)).status).toBe(201);
    expect((await http(secured.url, "GET", `/wallets/${w.id}`, undefined, backOffice)).status).toBe(200);
  });
});

describe("audit write amplification", () => {
  test("an unattributable invalid request is counted but never stored or published", async () => {
    const before = await db.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM wager_submission_failures");
    const res = await http(
      open.url,
      "POST",
      "/wagering/transactions",
      { junk: true },
      { "Idempotency-Key": uuid() },
    );
    expect(res.status).toBe(400);
    const after = await db.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM wager_submission_failures");
    expect(after[0]?.n).toBe(before[0]?.n);
    const metrics = await http<string>(open.url, "GET", "/metrics");
    expect(metrics.body).toMatch(/wager_submission_failures_total\{[^}]*channel="http"[^}]*\} [1-9]/);
  });
});

describe("CORS", () => {
  test("not enabled: cross-origin browsers get no Access-Control-* grant", async () => {
    const res = await fetch(`${open.url}/wagering/transactions`, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  });
});
