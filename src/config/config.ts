import { Injectable } from "@nestjs/common";

export type AppRole = "api" | "consumer" | "worker";

export function parseConfiguration(env: Record<string, string | undefined>) {
  function required(name: string): string {
    const value = env[name];
    if (!value?.trim()) throw new Error(`Missing configuration: ${name}`);
    return value;
  }
  function port(name: string, fallback: string): number {
    const value = env[name] ?? fallback;
    if (!/^\d+$/.test(value) || +value < 1 || +value > 65535) {
      throw new Error(`Invalid configuration: ${name}`);
    }
    return +value;
  }
  function integer(name: string, fallback: number, max: number): number {
    const value = env[name] ?? String(fallback);
    if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(+value) || +value > max)
      throw new Error(`Invalid configuration: ${name}`);
    return +value;
  }
  function flag(name: string, fallback: boolean): boolean {
    const value = env[name];
    if (value === undefined) return fallback;
    if (value !== "true" && value !== "false") throw new Error(`Invalid configuration: ${name}`);
    return value === "true";
  }
  function awsCredentials() {
    const accessKeyId = env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
    if (!accessKeyId?.trim() && !secretAccessKey?.trim()) return undefined;
    if (!accessKeyId?.trim() || !secretAccessKey?.trim())
      throw new Error("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be supplied together");
    return Object.freeze({ accessKeyId, secretAccessKey });
  }
  if (env.TEST_SYNC_POINTS && env.NODE_ENV !== "test")
    throw new Error("TEST_SYNC_POINTS requires NODE_ENV=test");
  const role = env.APP_ROLE ?? "api";
  if (role !== "api" && role !== "consumer" && role !== "worker") {
    throw new Error("Invalid configuration: APP_ROLE");
  }
  function url(name: string): string {
    const value = required(name);
    try {
      if (!["http:", "https:"].includes(new URL(value).protocol)) throw new Error();
    } catch {
      throw new Error(`Invalid configuration: ${name}`);
    }
    return value;
  }
  const outboxLeaseMs = integer("OUTBOX_LEASE_MS", 15_000, 300_000);
  const outboxRetryMaxMs = integer("OUTBOX_RETRY_MAX_MS", 300_000, 86_400_000);
  if (outboxLeaseMs <= 2000 || outboxRetryMaxMs < outboxLeaseMs)
    throw new Error("Invalid configuration: outbox lease must exceed SQS timeout");
  const credentials = awsCredentials();
  const sslCaFile = env.DB_SSL_CA_FILE;
  if (sslCaFile !== undefined && !sslCaFile.trim())
    throw new Error("Invalid configuration: DB_SSL_CA_FILE");
  return Object.freeze({
    role: role as AppRole,
    port: port("PORT", "3000"),
    bootstrapCreateQueues: flag("BOOTSTRAP_CREATE_QUEUES", true),
    database: Object.freeze({
      host: required("DB_HOST"),
      port: port("DB_PORT", "5432"),
      dbName: required("DB_NAME"),
      user: required("DB_USER"),
      password: required("DB_PASSWORD"),
      ...(sslCaFile === undefined ? {} : { sslCaFile }),
    }),
    sqs: Object.freeze({
      endpoint: url("SQS_ENDPOINT"),
      region: required("AWS_REGION"),
      ...(credentials ? { credentials } : {}),
    }),
    auth: Object.freeze({ issuer: url("AUTH_ISSUER"), jwksUrl: url("AUTH_JWKS_URL") }),
    outbox: Object.freeze({ leaseMs: outboxLeaseMs, retryMaxMs: outboxRetryMaxMs }),
    pending: Object.freeze({ ttlMs: integer("REFERENCE_TTL_MS", 86_400_000, 31_536_000_000) }),
    consumer: Object.freeze({
      concurrency: integer("CONSUMER_CONCURRENCY", 10, 100),
      batchSize: integer("SQS_BATCH_SIZE", 10, 10),
      waitSeconds: integer("SQS_WAIT_SECONDS", 20, 20),
      visibilitySeconds: integer("SQS_VISIBILITY_SECONDS", 30, 43_200),
      maxReceives: integer("SQS_MAX_RECEIVES", 5, 1000),
      retryBaseSeconds: integer("SQS_RETRY_BASE_SECONDS", 2, 30),
      retryMaxSeconds: integer("SQS_RETRY_MAX_SECONDS", 30, 43_200),
      shutdownDrainMs: integer("SHUTDOWN_DRAIN_MS", 25_000, 120_000),
    }),
    sync: Object.freeze({
      points: env.TEST_SYNC_POINTS?.split(",").filter(Boolean) ?? [],
      match: env.TEST_SYNC_MATCH ?? "",
    }),
  });
}

@Injectable()
export class Configuration {
  readonly values = parseConfiguration(process.env);
}
