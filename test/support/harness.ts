import 'reflect-metadata';
import { DeleteMessageBatchCommand, PurgeQueueCommand, ReceiveMessageCommand, SendMessageCommand, type Message } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { createApp } from '../../src/app';
import { type AppConfig, loadConfig } from '../../src/infrastructure/config/app-config';
import { SqsGateway } from '../../src/infrastructure/messaging/sqs-gateway';
import { buildOrmConfig } from '../../src/infrastructure/persistence/orm-config';

/*
 * Test harness. Every test file gets its own PostgreSQL database (migrated
 * with the real migrations) and its own set of SQS FIFO queues on LocalStack,
 * so files are isolated without mocks and without shared state.
 */

const BASE_DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://wagering:wagering@localhost:55432/wagering';
const AWS_ENDPOINT_URL = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const waitFor = async <T>(
  probe: () => Promise<T | undefined | false>,
  { timeoutMs = 20_000, intervalMs = 100, description = 'condition' } = {},
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value as T;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await sleep(intervalMs);
  }
};

export interface TestEnvironment {
  name: string;
  config: AppConfig;
  /** env vars for child processes (multi-instance tests) */
  env: Record<string, string>;
  db: Pool;
  sqs: SqsGateway;
  teardown(): Promise<void>;
}

const withDatabase = (url: string, database: string): string => {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
};

/** Creates an isolated database + queues and returns a config pointing at them. */
export const createTestEnvironment = async (overrides: Partial<Record<keyof AppConfig, string>> = {}): Promise<TestEnvironment> => {
  const name = `t_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`;
  const admin = new Pool({ connectionString: BASE_DATABASE_URL, max: 1 });
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } catch (error) {
    await admin.end();
    throw new Error(
      `PostgreSQL is not reachable at ${BASE_DATABASE_URL}. Start it with "docker compose up -d postgres localstack". (${String(error)})`,
    );
  }
  await admin.end();

  const databaseUrl = withDatabase(BASE_DATABASE_URL, name);
  const orm = await MikroORM.init(buildOrmConfig(databaseUrl, 2));
  await orm.getMigrator().up();
  await orm.close(true);

  const env: Record<string, string> = {
    DATABASE_URL: databaseUrl,
    AWS_ENDPOINT_URL,
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    SQS_TRANSACTIONS_QUEUE: `${name}-tx.fifo`,
    SQS_TRANSACTIONS_DLQ: `${name}-dlq.fifo`,
    SQS_EVENTS_QUEUE: `${name}-events.fifo`,
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
    CONSUMER_WAIT_TIME_SECONDS: '1',
    CONSUMER_SHUTDOWN_TIMEOUT_MS: '5000',
    OUTBOX_POLL_INTERVAL_MS: '50',
    PENDING_REFERENCE_POLL_INTERVAL_MS: '100',
    METRICS_SAMPLE_INTERVAL_MS: '1000',
    ...overrides,
  };
  const config = loadConfig(env);
  const sqs = new SqsGateway(config);
  await sqs.ensureQueues();
  const db = new Pool({ connectionString: databaseUrl, max: 5 });

  return {
    name,
    config,
    env,
    db,
    sqs,
    async teardown() {
      await db.end();
      sqs.destroy();
      const cleanup = new Pool({ connectionString: BASE_DATABASE_URL, max: 1 });
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
      await cleanup.end();
    },
  };
};

// ---------------------------------------------------------------- app & http

export interface RunningApp {
  app: INestApplication;
  url: string;
  close(): Promise<void>;
}

export const startApp = async (env: TestEnvironment, overrides: Partial<AppConfig> = {}): Promise<RunningApp> => {
  const app = await createApp({ ...env.config, ...overrides });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as { port: number };
  return { app, url: `http://127.0.0.1:${address.port}`, close: () => app.close() };
};

export interface HttpResult<T = any> {
  status: number;
  body: T;
}

export const http = async <T = any>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<HttpResult<T>> => {
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : undefined) as T };
};

export const openWallet = async (baseUrl: string, amount = '100.00', currency = 'BRL', playerId = uuidv7()) => {
  const res = await http('POST', `${baseUrl}/wallets`, { playerId, initialBalance: { amount, currency } });
  if (res.status !== 201) throw new Error(`openWallet failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; playerId: string; balance: { amount: string; currency: string }; version: number };
};

export interface WagerInput {
  walletId: string;
  playerId: string;
  kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
  amount: string;
  externalTransactionId?: string;
  referenceExternalTransactionId?: string;
  providerId?: string;
  roundId?: string;
  currency?: string;
}

export const wagerBody = (input: WagerInput) => ({
  providerId: input.providerId ?? 'provider-a',
  externalTransactionId: input.externalTransactionId ?? `ext-${uuidv7()}`,
  playerId: input.playerId,
  walletId: input.walletId,
  roundId: input.roundId ?? 'round-1',
  gameId: 'fortune-chimp',
  kind: input.kind,
  money: { amount: input.amount, currency: input.currency ?? 'BRL' },
  ...(input.referenceExternalTransactionId ? { referenceExternalTransactionId: input.referenceExternalTransactionId } : {}),
});

export const submitWager = (baseUrl: string, body: ReturnType<typeof wagerBody>, idempotencyKey = `${body.providerId}:${body.externalTransactionId}`) =>
  http('POST', `${baseUrl}/wagering/transactions`, body, { 'Idempotency-Key': idempotencyKey });

// ---------------------------------------------------------------------- sqs

export const queueMessage = (body: ReturnType<typeof wagerBody>, messageId = `msg-${uuidv7()}`) => ({
  messageId,
  type: 'WagerTransactionRequested',
  occurredAt: new Date().toISOString(),
  data: { ...body, idempotencyKey: `${body.providerId}:${body.externalTransactionId}` },
});

export const sendToQueue = async (env: TestEnvironment, message: unknown, groupId: string, deduplicationId = randomUUID()) => {
  const { transactions } = await env.sqs.queueUrls();
  await env.sqs.client.send(
    new SendMessageCommand({
      QueueUrl: transactions,
      MessageBody: typeof message === 'string' ? message : JSON.stringify(message),
      MessageGroupId: groupId,
      MessageDeduplicationId: deduplicationId,
    }),
  );
};

/**
 * Reads every message currently in a queue. Messages are de-duplicated by
 * MessageId (with visibility 0 they are re-received); the loop ends after
 * `rounds` consecutive rounds that brought nothing new. With `consume` the
 * messages are deleted — required to read a whole FIFO group, since SQS holds
 * back the rest of a group while one of its messages is in flight.
 */
export const receiveAll = async (
  env: TestEnvironment,
  queue: 'dlq' | 'events',
  { visibility = 30, rounds = 2, consume = false } = {},
): Promise<Message[]> => {
  const urls = await env.sqs.queueUrls();
  const seen = new Map<string, Message>();
  for (let idle = 0; idle < rounds; ) {
    const res = await env.sqs.client.send(
      new ReceiveMessageCommand({
        QueueUrl: urls[queue],
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        VisibilityTimeout: visibility,
        MessageAttributeNames: ['All'],
      }),
    );
    const fresh = (res.Messages ?? []).filter((m) => !seen.has(m.MessageId!));
    for (const m of fresh) seen.set(m.MessageId!, m);
    if (consume && fresh.length > 0) {
      await env.sqs.client.send(
        new DeleteMessageBatchCommand({
          QueueUrl: urls[queue],
          Entries: fresh.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle! })),
        }),
      );
    }
    idle = fresh.length === 0 ? idle + 1 : 0;
  }
  return [...seen.values()];
};

export const purge = async (env: TestEnvironment, queue: 'transactions' | 'dlq' | 'events') => {
  const urls = await env.sqs.queueUrls();
  await env.sqs.client.send(new PurgeQueueCommand({ QueueUrl: urls[queue] }));
};

// ------------------------------------------------------------- assertions

export interface WalletRow {
  balance: string;
  version: number;
}

export const walletRow = async (env: TestEnvironment, walletId: string): Promise<WalletRow> => {
  const { rows } = await env.db.query('SELECT balance::text AS balance, version FROM wallets WHERE id = $1', [walletId]);
  return rows[0] as WalletRow;
};

export const countRows = async (env: TestEnvironment, sql: string, params: unknown[] = []): Promise<number> => {
  const { rows } = await env.db.query(`SELECT COUNT(*)::int AS n FROM (${sql}) q`, params);
  return rows[0].n as number;
};

/**
 * Global invariant of every test: for every wallet,
 *   wallet.balance == balance rebuilt from the ledger
 * and the ledger chain is gap-free (versions contiguous, balances chained).
 */
export const assertLedgerInvariant = async (env: TestEnvironment): Promise<void> => {
  const { rows: mismatched } = await env.db.query(`
    SELECT w.id, w.balance::text AS stored,
           COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::text AS rebuilt
      FROM wallets w
      LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
     GROUP BY w.id, w.balance
    HAVING w.balance <> COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)`);
  if (mismatched.length > 0) {
    throw new Error(`ledger invariant violated: ${JSON.stringify(mismatched)}`);
  }
  const { rows: broken } = await env.db.query(`
    SELECT l.wallet_id, l.wallet_version
      FROM wallet_ledger_entries l
      LEFT JOIN wallet_ledger_entries p ON p.wallet_id = l.wallet_id AND p.wallet_version = l.wallet_version - 1
     WHERE (p.id IS NULL AND l.balance_before <> 0)
        OR (p.id IS NOT NULL AND p.balance_after <> l.balance_before)`);
  if (broken.length > 0) {
    throw new Error(`ledger chain broken: ${JSON.stringify(broken)}`);
  }
  const { rows: negative } = await env.db.query('SELECT id FROM wallets WHERE balance < 0');
  if (negative.length > 0) throw new Error('negative balance found');
};

// ------------------------------------------------------ child processes

export interface ChildInstance {
  url: string;
  proc: ReturnType<typeof Bun.spawn>;
  port: number;
  /** collected stdout (JSON logs) */
  output(): string;
  kill(signal?: NodeJS.Signals | number): void;
  exited: Promise<number>;
}

/** Asks the OS for a currently free port (bind to 0, read it, release it). */
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

/** Spawns `bun src/main.ts` as an independent OS process sharing DB and queues. */
export const spawnInstance = async (
  env: TestEnvironment,
  extraEnv: Record<string, string> = {},
  waitReady = true,
  attempt = 1,
): Promise<ChildInstance> => {
  const port = await freePort();
  let buffer = '';
  const proc = Bun.spawn(['bun', 'src/main.ts'], {
    env: { ...process.env, ...env.env, LOG_LEVEL: 'info', PORT: String(port), INSTANCE_ID: `child-${port}`, ...extraEnv },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) buffer += decoder.decode(chunk);
  };
  void pump(proc.stdout as ReadableStream<Uint8Array>);
  void pump(proc.stderr as ReadableStream<Uint8Array>);

  const url = `http://127.0.0.1:${port}`;
  if (waitReady) {
    try {
      await waitFor(
        async () => {
          if (proc.exitCode !== null) throw new Error(`instance exited early (${proc.exitCode}):\n${buffer.slice(-2000)}`);
          try {
            return (await fetch(`${url}/health/ready`)).ok;
          } catch {
            return false;
          }
        },
        { timeoutMs: 30_000, description: `instance on port ${port}` },
      );
    } catch (error) {
      // the free port can be taken between probing and binding: retry on a new one
      if (attempt < 3 && /port \d+ in use/i.test(buffer)) return spawnInstance(env, extraEnv, waitReady, attempt + 1);
      throw error;
    }
  }
  return {
    url,
    proc,
    port,
    output: () => buffer,
    kill: (signal = 'SIGTERM') => proc.kill(signal as number),
    exited: proc.exited,
  };
};
