import { expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { apiUrl } from "./stack";
import { accessToken, LocalClient } from "./tokens";

// Expected response contracts; tests still assert each status and serialized shape at runtime.
export interface SubmissionBody {
  transactionId: string;
  status: string;
  failureCode?: string;
  balance: { amount: string; currency: string } | null;
  idempotentReplay: boolean;
}
export interface ErrorBody {
  error: { code: string; message: string; correlationId: string; details: string[] };
}
export interface LedgerPageBody {
  items: { id: string; walletVersion: number; direction: string }[];
  nextCursor: string | null;
}
export async function jsonBody<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}
export const errorBody = (response: Response) => jsonBody<ErrorBody>(response);
export const submissionBody = (response: Response) => jsonBody<SubmissionBody>(response);

export async function apiRequest(
  path: string,
  options: {
    method?: string;
    client?: LocalClient | null;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
) {
  const headers: Record<string, string> = { ...options.headers };
  if (options.client !== null)
    headers.Authorization = `Bearer ${await accessToken(options.client ?? "platform-operator")}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(`${apiUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}
export async function openHttpWallet(amount = "100.00") {
  const response = await apiRequest("/wallets", {
    method: "POST",
    body: {
      playerId: randomUUID(),
      initialBalance: { amount, currency: "BRL" },
    },
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<{
    id: string;
    playerId: string;
    balance: { amount: string; currency: string };
    version: number;
  }>;
}

export function httpWager(
  wallet: { id: string; playerId: string },
  overrides: Record<string, unknown> = {},
) {
  return {
    providerId: "provider-a",
    externalTransactionId: randomUUID(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "round",
    gameId: "game",
    kind: "BET",
    money: { amount: "10.00", currency: "BRL" },
    ...overrides,
  };
}
export function submitHttp(
  body: unknown,
  key: string = randomUUID(),
  client: LocalClient = "provider-a",
) {
  return apiRequest("/wagering/transactions", {
    method: "POST",
    client,
    body,
    headers: { "Idempotency-Key": key },
  });
}
