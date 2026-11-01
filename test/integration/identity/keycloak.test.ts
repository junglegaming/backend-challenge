import { afterAll, afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { decodeJwt } from "jose";
import { assertLedgerInvariant, testDatabase } from "../../support/database";
import {
  apiRequest,
  errorBody,
  httpWager,
  openHttpWallet,
  submissionBody,
  submitHttp,
} from "../../support/http";
import { accessToken } from "../../support/tokens";

const { database } = testDatabase();
afterEach(() => assertLedgerInvariant(database));
afterAll(() => database.onModuleDestroy());

test("real Keycloak service tokens have stable issuer, audience, scope and provider claims", async () => {
  for (const client of ["provider-a", "provider-b", "platform-operator"] as const) {
    const claims = decodeJwt(await accessToken(client));
    expect(claims.iss).toBe("http://keycloak:8080/realms/wagering");
    expect([claims.aud].flat()).toContain("wagering-api");
    expect(claims.azp).toBe(client);
    expect(claims.scope).toContain(client === "platform-operator" ? "wallets.admin" : "wagering");
    expect(claims.provider_id).toBe(client === "platform-operator" ? undefined : client);
    if (claims.exp === undefined || claims.iat === undefined)
      throw new Error("Missing token lifetime");
    expect(claims.exp - claims.iat).toBe(3600);
  }
});

test("missing or malformed bearer tokens return 401 with a Bearer challenge", async () => {
  const cases: Record<string, string>[] = [
    {},
    { Authorization: "Bearer invalid" },
    { Authorization: "Basic invalid" },
  ];
  for (const headers of cases) {
    const response = await apiRequest(`/wallets/${randomUUID()}`, { client: null, headers });
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect((await errorBody(response)).error.code).toBe("UNAUTHENTICATED");
  }
});

test("provider identity binds submission bodies, provider paths and transaction ownership", async () => {
  const wallet = await openHttpWallet();
  const body = httpWager(wallet);
  const submitted = await submitHttp(body);
  expect(submitted.status).toBe(200);
  const { transactionId } = await submissionBody(submitted);
  const forgedProvider = await submitHttp({ ...httpWager(wallet), providerId: "provider-b" });
  expect(forgedProvider.status).toBe(403);
  expect((await errorBody(forgedProvider)).error.code).toBe("PROVIDER_MISMATCH");
  for (const path of [
    `/providers/provider-a/wagering/transactions/${body.externalTransactionId}`,
    `/wagering/transactions/${transactionId}`,
  ]) {
    const denied = await apiRequest(path, { client: "provider-b" });
    expect(denied.status).toBe(403);
    expect((await errorBody(denied)).error.code).toBe("PROVIDER_MISMATCH");
    expect((await apiRequest(path, { client: "provider-a" })).status).toBe(200);
    expect((await apiRequest(path, { client: "platform-operator" })).status).toBe(200);
  }
  expect(
    (
      await apiRequest(`/providers/provider-b/wagering/transactions/${randomUUID()}`, {
        client: "provider-a",
      })
    ).status,
  ).toBe(403);
});

test("only operators can use wallet endpoints and provider scope is required for submission", async () => {
  const wallet = await openHttpWallet();
  const routes = [
    [
      "/wallets",
      "POST",
      { playerId: randomUUID(), initialBalance: { amount: "0.00", currency: "BRL" } },
    ],
    [`/wallets/${wallet.id}`, "GET", undefined],
    [`/wallets/${wallet.id}/ledger`, "GET", undefined],
    [`/wallets/${wallet.id}/reconciliation`, "POST", undefined],
  ] as const;
  for (const [path, method, body] of routes) {
    const denied = await apiRequest(path, { method, body, client: "provider-a" });
    expect(denied.status).toBe(403);
    expect((await errorBody(denied)).error.code).toBe("INSUFFICIENT_SCOPE");
    expect((await apiRequest(path, { method, body, client: "platform-operator" })).status).toBe(
      method === "POST" && path === "/wallets" ? 201 : 200,
    );
  }
  const denied = await submitHttp(httpWager(wallet), randomUUID(), "platform-operator");
  expect(denied.status).toBe(403);
  expect((await errorBody(denied)).error.code).toBe("INSUFFICIENT_SCOPE");
});
