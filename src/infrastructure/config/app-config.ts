import { hostname } from 'node:os';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');
const int = (def: number) => z.coerce.number().int().nonnegative().default(def);

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: int(3000),
  INSTANCE_ID: z.string().default(`${hostname()}-${process.pid}`),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().default('postgres://wagering:wagering@localhost:5432/wagering'),
  DATABASE_POOL_MAX: int(20),
  DB_LOCK_TIMEOUT_MS: int(5_000),
  DB_STATEMENT_TIMEOUT_MS: int(15_000),

  AWS_REGION: z.string().default('us-east-1'),
  AWS_ENDPOINT_URL: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().default('test'),
  AWS_SECRET_ACCESS_KEY: z.string().default('test'),
  SQS_TRANSACTIONS_QUEUE: z.string().default('wager-transactions.fifo'),
  SQS_TRANSACTIONS_DLQ: z.string().default('wager-transactions-dlq.fifo'),
  SQS_EVENTS_QUEUE: z.string().default('wagering-events.fifo'),

  CONSUMER_ENABLED: bool.default('true'),
  CONSUMER_NAME: z.string().default('wager-transactions-consumer'),
  CONSUMER_CONCURRENCY: int(10),
  CONSUMER_WAIT_TIME_SECONDS: int(10),
  CONSUMER_VISIBILITY_TIMEOUT_SECONDS: int(30),
  /** receives before a message that keeps failing transiently goes to the DLQ */
  CONSUMER_MAX_ATTEMPTS: int(5),
  CONSUMER_RETRY_BASE_SECONDS: int(2),
  CONSUMER_SHUTDOWN_TIMEOUT_MS: int(20_000),

  OUTBOX_ENABLED: bool.default('true'),
  OUTBOX_POLL_INTERVAL_MS: int(250),
  OUTBOX_BATCH_SIZE: int(50),
  OUTBOX_LEASE_MS: int(30_000),

  PENDING_REFERENCE_ENABLED: bool.default('true'),
  PENDING_REFERENCE_POLL_INTERVAL_MS: int(1_000),
  PENDING_REFERENCE_BATCH_SIZE: int(50),
  PENDING_REFERENCE_MAX_ATTEMPTS: int(10),
  PENDING_REFERENCE_BASE_DELAY_MS: int(2_000),
  PENDING_REFERENCE_MAX_DELAY_MS: int(300_000),

  METRICS_SAMPLE_INTERVAL_MS: int(5_000),

  /**
   * Test-only fault injection. 'crash-after-commit' kills the process after
   * the SQL commit and before the SQS ack (proves redelivery safety).
   */
  FAULT_INJECTION: z.enum(['none', 'crash-after-commit']).default('none'),
});

export type AppConfig = z.infer<typeof schema>;

export const APP_CONFIG = Symbol('AppConfig');

export const loadConfig = (env: Record<string, string | undefined> = process.env, overrides: Partial<AppConfig> = {}): AppConfig => {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return { ...parsed.data, ...overrides };
};
