import { hostname } from "node:os";
import { z } from "zod";
import { isIso4217 } from "../shared/domain/currency";

const bool = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");
const int = (def: number, min = 0) => z.coerce.number().int().min(min).default(def);

export const APP_ROLES = ["api", "consumer", "outbox", "pending-ref"] as const;
export type AppRole = (typeof APP_ROLES)[number];

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: int(3000, 0),
  APP_ROLES: z
    .string()
    .default(APP_ROLES.join(","))
    .transform((s) =>
      s
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.enum(APP_ROLES)).min(1)),
  INSTANCE_ID: z.string().min(1).default(`${hostname()}-${process.pid}`),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  DATABASE_URL: z.string().url(),
  DATABASE_MIGRATOR_URL: z.string().url().optional(),
  DB_POOL_MIN: int(2),
  DB_POOL_MAX: int(10, 1),
  /** Fail fast on hot-wallet contention instead of queueing forever; surfaced as a transient error. */
  DB_LOCK_TIMEOUT_MS: int(2000, 1),
  DB_STATEMENT_TIMEOUT_MS: int(5000, 1),
  DB_TX_MAX_ATTEMPTS: int(3, 1),

  AWS_REGION: z.string().default("us-east-1"),
  SQS_ENDPOINT: z.string().url().optional(),
  /** MiniStack echoes the original MD5 for de-duplicated FIFO sends; verification is disabled only for emulators. */
  SQS_VERIFY_MD5: bool.default(true),
  SQS_WAGER_QUEUE_NAME: z.string().default("wager-transactions.fifo"),
  SQS_WAGER_DLQ_NAME: z.string().default("wager-transactions-dlq.fifo"),
  SQS_EVENTS_QUEUE_NAME: z.string().default("wallet-events.fifo"),
  SQS_MAX_RECEIVE_COUNT: int(5, 1),
  SQS_VISIBILITY_TIMEOUT_S: int(30, 1),
  SQS_WAIT_TIME_S: int(20, 0),
  SQS_CONSUMER_CONCURRENCY: int(10, 1),
  SQS_TRANSIENT_BACKOFF_BASE_S: int(2, 0),
  SQS_TRANSIENT_BACKOFF_MAX_S: int(60, 1),
  SQS_CONSUMER_NAME: z.string().default("wagering-processor"),
  /** Apply the messages of one wallet from each receive in a single SQL transaction. */
  SQS_BATCH_PER_WALLET: bool.default(true),

  OUTBOX_POLL_INTERVAL_MS: int(250, 10),
  OUTBOX_BATCH_SIZE: int(100, 1),
  OUTBOX_PUBLISH_LANES: int(4, 1),
  OUTBOX_LEASE_MS: int(30_000, 100),

  PENDING_REF_POLL_INTERVAL_MS: int(1000, 10),
  PENDING_REF_BATCH_SIZE: int(50, 1),
  PENDING_REF_BASE_MS: int(2000, 1),
  PENDING_REF_MAX_MS: int(300_000, 1),
  PENDING_REF_MAX_ATTEMPTS: int(10, 1),
  PENDING_REF_LEASE_MS: int(30_000, 100),

  /** Currencies in which wallets may be opened (ISO-4217, comma separated). A typo fails the boot. */
  SUPPORTED_CURRENCIES: z
    .string()
    .default("BRL,USD,EUR")
    .transform((s) =>
      s
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean),
    )
    .pipe(
      z
        .array(z.string().refine(isIso4217, "not an ISO-4217 currency code (upper case, e.g. BRL)"))
        .min(1)
        .transform((codes) => [...new Set(codes)]),
    ),

  INBOX_RETENTION_DAYS: int(30, 1),
  SUBMISSION_FAILURE_RETENTION_DAYS: int(90, 1),
  SHUTDOWN_GRACE_MS: int(20_000, 0),

  OTEL_ENABLED: bool.default(false),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_SERVICE_NAME: z.string().default("wagering-processor"),

  /** Test-only crash points, e.g. "after-commit-before-ack". Honoured only when NODE_ENV=test (opt-in, fail safe). */
  FAULT_INJECTION: z.string().default(""),
});

export type AppConfig = Readonly<
  Omit<z.infer<typeof EnvSchema>, "FAULT_INJECTION"> & { FAULT_INJECTION: readonly string[] }
>;

export const APP_CONFIG = Symbol("APP_CONFIG");

/** Validates the environment once at boot: misconfiguration fails fast with every problem listed. */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const cfg = parsed.data;
  // Opt-in by environment, not opt-out: a deployment that forgets NODE_ENV must never be able to kill itself.
  const faults =
    cfg.NODE_ENV !== "test"
      ? []
      : cfg.FAULT_INJECTION.split(",")
          .map((f) => f.trim())
          .filter(Boolean);
  return Object.freeze({ ...cfg, FAULT_INJECTION: faults });
}
