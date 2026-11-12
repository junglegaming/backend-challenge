import { z } from "zod";

/** Roles an instance can play. Every role is safe to run on N replicas at once. */
export const APP_ROLES = ["api", "consumer", "outbox", "pending-ref"] as const;
export type AppRole = (typeof APP_ROLES)[number];

const intFromEnv = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: intFromEnv(3000),
  APP_ROLES: z
    .string()
    .default(APP_ROLES.join(","))
    .transform((value) => value.split(",").map((role) => role.trim()).filter(Boolean))
    .pipe(z.array(z.enum(APP_ROLES)).min(1)),
  INSTANCE_ID: z.string().default(() => `instance-${process.pid}`),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  DATABASE_HOST: z.string().default("localhost"),
  DATABASE_PORT: intFromEnv(5432),
  DATABASE_NAME: z.string().default("wagering"),
  DATABASE_USER: z.string().default("wagering"),
  DATABASE_PASSWORD: z.string().default("wagering"),
  DATABASE_POOL_MAX: intFromEnv(10),
  /** How long a transaction waits for a wallet row lock before failing as transient. */
  LOCK_TIMEOUT_MS: intFromEnv(2000),

  AWS_REGION: z.string().default("us-east-1"),
  AWS_ACCESS_KEY_ID: z.string().default("test"),
  AWS_SECRET_ACCESS_KEY: z.string().default("test"),
  SQS_ENDPOINT: z.string().url().optional(),
  SQS_WAGER_QUEUE_NAME: z.string().default("wager-transactions.fifo"),
  SQS_WAGER_DLQ_NAME: z.string().default("wager-transactions-dlq.fifo"),
  SQS_EVENTS_QUEUE_NAME: z.string().default("wallet-events.fifo"),
  /** Deliveries before a message that keeps failing is dead-lettered. */
  SQS_MAX_RECEIVE_COUNT: intFromEnv(5),
  SQS_WAIT_TIME_SECONDS: z.coerce.number().int().min(0).max(20).default(10),
  SQS_VISIBILITY_TIMEOUT_SECONDS: intFromEnv(30),

  PENDING_REF_MAX_ATTEMPTS: intFromEnv(8),
  PENDING_REF_BASE_DELAY_MS: intFromEnv(2000),
  PENDING_REF_POLL_INTERVAL_MS: intFromEnv(1000),

  OUTBOX_POLL_INTERVAL_MS: intFromEnv(250),
  OUTBOX_BATCH_SIZE: intFromEnv(20),
  OUTBOX_LEASE_MS: intFromEnv(30000),
});

export interface AppConfig {
  env: "development" | "test" | "production";
  port: number;
  roles: ReadonlySet<AppRole>;
  instanceId: string;
  logLevel: string;
  database: {
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
    poolMax: number;
    lockTimeoutMs: number;
  };
  sqs: {
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    endpoint?: string;
    wagerQueueName: string;
    wagerDlqName: string;
    eventsQueueName: string;
    maxReceiveCount: number;
    waitTimeSeconds: number;
    visibilityTimeoutSeconds: number;
  };
  pendingReference: { maxAttempts: number; baseDelayMs: number; pollIntervalMs: number };
  outbox: { pollIntervalMs: number; batchSize: number; leaseMs: number };
}

export const APP_CONFIG = Symbol("APP_CONFIG");

/**
 * Reads and validates the environment once at startup. An invalid value
 * stops the process immediately instead of failing later at runtime.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  return {
    env: e.NODE_ENV,
    port: e.PORT,
    roles: new Set(e.APP_ROLES),
    instanceId: e.INSTANCE_ID,
    logLevel: e.LOG_LEVEL,
    database: {
      host: e.DATABASE_HOST,
      port: e.DATABASE_PORT,
      name: e.DATABASE_NAME,
      user: e.DATABASE_USER,
      password: e.DATABASE_PASSWORD,
      poolMax: e.DATABASE_POOL_MAX,
      lockTimeoutMs: e.LOCK_TIMEOUT_MS,
    },
    sqs: {
      region: e.AWS_REGION,
      accessKeyId: e.AWS_ACCESS_KEY_ID,
      secretAccessKey: e.AWS_SECRET_ACCESS_KEY,
      endpoint: e.SQS_ENDPOINT,
      wagerQueueName: e.SQS_WAGER_QUEUE_NAME,
      wagerDlqName: e.SQS_WAGER_DLQ_NAME,
      eventsQueueName: e.SQS_EVENTS_QUEUE_NAME,
      maxReceiveCount: e.SQS_MAX_RECEIVE_COUNT,
      waitTimeSeconds: e.SQS_WAIT_TIME_SECONDS,
      visibilityTimeoutSeconds: e.SQS_VISIBILITY_TIMEOUT_SECONDS,
    },
    pendingReference: {
      maxAttempts: e.PENDING_REF_MAX_ATTEMPTS,
      baseDelayMs: e.PENDING_REF_BASE_DELAY_MS,
      pollIntervalMs: e.PENDING_REF_POLL_INTERVAL_MS,
    },
    outbox: {
      pollIntervalMs: e.OUTBOX_POLL_INTERVAL_MS,
      batchSize: e.OUTBOX_BATCH_SIZE,
      leaseMs: e.OUTBOX_LEASE_MS,
    },
  };
}

