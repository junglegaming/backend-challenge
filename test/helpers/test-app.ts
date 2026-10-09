import {
  type RunningApplication,
  type StartOptions,
  sqsGatewayFrom,
  startApplication,
} from "../../src/bootstrap";
import { type AppConfig, loadConfig } from "../../src/config/config";
import type { SqsGateway } from "../../src/infrastructure/messaging/sqs-gateway";
import type { TestDatabase } from "./test-db";

export const SQS_ENDPOINT = process.env.TEST_SQS_ENDPOINT ?? "http://localhost:54566";

/** Unique queue names per suite so parallel/previous runs never interfere. */
export function testQueues(prefix = "t") {
  const id = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  return {
    SQS_WAGER_QUEUE_NAME: `wager-${id}.fifo`,
    SQS_WAGER_DLQ_NAME: `wager-dlq-${id}.fifo`,
    SQS_EVENTS_QUEUE_NAME: `events-${id}.fifo`,
  };
}

export type Env = Record<string, string>;

export function testEnv(db: TestDatabase, queues: ReturnType<typeof testQueues>, overrides: Env = {}): Env {
  return {
    NODE_ENV: "test",
    PORT: "0",
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? "silent",
    DATABASE_URL: db.appUrl,
    DB_POOL_MAX: "20",
    DB_LOCK_TIMEOUT_MS: "3000",
    DB_TX_MAX_ATTEMPTS: "5",
    AWS_REGION: "us-east-1",
    SQS_ENDPOINT,
    SQS_VERIFY_MD5: "false",
    SQS_WAIT_TIME_S: "1",
    SQS_VISIBILITY_TIMEOUT_S: "5",
    SQS_MAX_RECEIVE_COUNT: "3",
    SQS_TRANSIENT_BACKOFF_BASE_S: "1",
    SQS_TRANSIENT_BACKOFF_MAX_S: "2",
    OUTBOX_POLL_INTERVAL_MS: "50",
    OUTBOX_LEASE_MS: "3000",
    PENDING_REF_POLL_INTERVAL_MS: "100",
    PENDING_REF_BASE_MS: "100",
    PENDING_REF_MAX_MS: "500",
    PENDING_REF_MAX_ATTEMPTS: "4",
    SHUTDOWN_GRACE_MS: "5000",
    ...queues,
    ...overrides,
  };
}

export async function ensureQueues(env: Env): Promise<SqsGateway> {
  const sqs = sqsGatewayFrom(loadConfig(env));
  await sqs.ensureQueues();
  return sqs;
}

export async function startTestApp(
  env: Env,
  options: StartOptions = {},
): Promise<RunningApplication & { config: AppConfig }> {
  const config = loadConfig(env);
  const app = await startApplication(config, options);
  return Object.assign(app, { config });
}

export async function http<T = Record<string, unknown>>(
  base: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: T; headers: Headers }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // non-JSON (e.g. /metrics)
  }
  return { status: res.status, body: parsed as T, headers: res.headers };
}

export async function waitFor<T>(
  probe: () => Promise<T | undefined | false>,
  { timeoutMs = 15_000, intervalMs = 100, what = "condition" } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(intervalMs);
  }
}
