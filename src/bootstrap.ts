import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import helmet from "helmet";
import { AppModule } from "./app.module";
import { buildCore, type Core } from "./composition/core";
import type { AppConfig } from "./config/config";
import { ReadinessService } from "./infrastructure/health/health";
import { correlationMiddleware } from "./infrastructure/http/correlation.middleware";
import { HttpErrorFilter } from "./infrastructure/http/error-filter";
import { OutboxPublisher } from "./infrastructure/messaging/outbox-publisher";
import { SqsGateway } from "./infrastructure/messaging/sqs-gateway";
import { SqsWagerConsumer } from "./infrastructure/messaging/sqs-wager-consumer";
import { createLogger, type Logger, NestPinoLogger } from "./infrastructure/observability/logger";
import { PromMetrics } from "./infrastructure/observability/metrics";
import { PendingReferenceWorker, RetentionWorker } from "./infrastructure/workers/background-workers";
import { FaultInjector } from "./infrastructure/workers/fault-injector";
import type { ProviderIdentityPort } from "./modules/auth/provider-auth";

export interface RunningApplication {
  url: string;
  core: Core;
  sqs: SqsGateway;
  logger: Logger;
  metrics: PromMetrics;
  /** Ordered graceful shutdown (idempotent). */
  shutdown(reason: string): Promise<void>;
}

export function sqsGatewayFrom(config: AppConfig): SqsGateway {
  return new SqsGateway({
    region: config.AWS_REGION,
    endpoint: config.SQS_ENDPOINT,
    verifyMd5: config.SQS_VERIFY_MD5,
    wagerQueueName: config.SQS_WAGER_QUEUE_NAME,
    wagerDlqName: config.SQS_WAGER_DLQ_NAME,
    eventsQueueName: config.SQS_EVENTS_QUEUE_NAME,
    maxReceiveCount: config.SQS_MAX_RECEIVE_COUNT,
    visibilityTimeoutSeconds: config.SQS_VISIBILITY_TIMEOUT_S,
  });
}

/**
 * Builds and starts one instance. Roles (APP_ROLES) choose which loops run here; every instance serves
 * HTTP (health/metrics at least) so it can be probed. All roles are stateless and safe to run N times.
 */
export interface StartOptions {
  /** Authentication adapter (defaults to the no-op one). Tests inject a real one to exercise authorisation. */
  identity?: ProviderIdentityPort;
}

export async function startApplication(
  config: AppConfig,
  options: StartOptions = {},
): Promise<RunningApplication> {
  const logger = createLogger({
    level: config.LOG_LEVEL,
    service: config.OTEL_SERVICE_NAME,
    instanceId: config.INSTANCE_ID,
    pretty: config.NODE_ENV === "development" && process.stdout.isTTY,
  });
  const metrics = new PromMetrics({ instance: config.INSTANCE_ID });
  const core = await buildCore(config, { logger, metrics });
  const sqs = sqsGatewayFrom(config);
  const faults = new FaultInjector(config.FAULT_INJECTION);
  if (faults.enabled) logger.warn({ faults: config.FAULT_INJECTION }, "FAULT INJECTION ENABLED (test only)");

  const readiness = new ReadinessService(
    [
      {
        name: "postgres",
        check: async (timeoutMs) => {
          await withTimeout(core.orm.em.fork().execute("SELECT 1"), timeoutMs, "postgres");
        },
      },
      { name: "sqs", check: (timeoutMs) => sqs.ping(timeoutMs) },
    ],
    logger,
  );
  metrics.registerGauges({
    outboxStats: () =>
      core.uow.snapshot((s) => s.outbox.stats(), { label: "metrics-outbox", retryTransient: false }),
    pendingReferences: () =>
      core.uow.snapshot((s) => s.wagers.countPendingReferences(), {
        label: "metrics-pending",
        retryTransient: false,
      }),
    dlqDepth: () => sqs.queueDepth(config.SQS_WAGER_DLQ_NAME),
  });

  const roles = new Set(config.APP_ROLES);
  const consumer = roles.has("consumer")
    ? new SqsWagerConsumer(
        sqs,
        core.processWager,
        core.recordSubmissionFailure,
        {
          consumerName: config.SQS_CONSUMER_NAME,
          concurrency: config.SQS_CONSUMER_CONCURRENCY,
          waitTimeSeconds: config.SQS_WAIT_TIME_S,
          visibilityTimeoutSeconds: config.SQS_VISIBILITY_TIMEOUT_S,
          maxReceiveCount: config.SQS_MAX_RECEIVE_COUNT,
          backoffBaseSeconds: config.SQS_TRANSIENT_BACKOFF_BASE_S,
          backoffMaxSeconds: config.SQS_TRANSIENT_BACKOFF_MAX_S,
          batchPerWallet: config.SQS_BATCH_PER_WALLET,
        },
        metrics,
        logger,
        faults,
      )
    : undefined;
  const outbox = roles.has("outbox")
    ? new OutboxPublisher(
        core.uow,
        sqs,
        core.clock,
        {
          owner: config.INSTANCE_ID,
          batchSize: config.OUTBOX_BATCH_SIZE,
          leaseMs: config.OUTBOX_LEASE_MS,
          pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS,
          lanes: config.OUTBOX_PUBLISH_LANES,
        },
        metrics,
        logger,
        faults,
      )
    : undefined;
  const pendingRefs = roles.has("pending-ref")
    ? new PendingReferenceWorker(
        core.resolvePendingReferences,
        config.PENDING_REF_BATCH_SIZE,
        config.PENDING_REF_POLL_INTERVAL_MS,
        logger,
      )
    : undefined;
  const inboxPurge = roles.has("consumer")
    ? new RetentionWorker(
        core.uow,
        core.clock,
        {
          inboxDays: config.INBOX_RETENTION_DAYS,
          submissionFailureDays: config.SUBMISSION_FAILURE_RETENTION_DAYS,
        },
        logger,
      )
    : undefined;

  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.register({ core, metrics, readiness, identity: options.identity }),
    {
      logger: new NestPinoLogger(logger),
      bodyParser: true,
    },
  );
  app.useBodyParser("json", { limit: "32kb" });
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(correlationMiddleware(logger));
  app.useGlobalFilters(new HttpErrorFilter(logger));
  await app.listen(config.PORT, "0.0.0.0");
  const url = (await app.getUrl()).replace("[::1]", "localhost").replace("0.0.0.0", "localhost");

  consumer?.start();
  outbox?.start();
  pendingRefs?.start();
  inboxPurge?.start();
  logger.info({ url, roles: [...roles] }, "instance started");

  let stopping: Promise<void> | undefined;
  const shutdown = (reason: string) => {
    stopping ??= (async () => {
      logger.info({ reason }, "shutdown requested: draining");
      readiness.markDraining();
      // 1. stop taking queue work; finish or hand back in-flight messages
      await consumer?.stop(config.SHUTDOWN_GRACE_MS);
      // 2. stop background loops (outbox releases its leases)
      await Promise.allSettled([outbox?.stop(), pendingRefs?.stop(), inboxPurge?.stop()]);
      // 3. stop HTTP (waits for in-flight requests)
      await app.close().catch((error) => logger.warn({ err: error }, "error closing HTTP server"));
      // 4. release DB pool and SQS client
      await core.close().catch(() => {});
      sqs.destroy();
      logger.info({ reason }, "shutdown complete");
      logger.flush?.();
    })();
    return stopping;
  };

  return { url, core, sqs, logger, metrics, shutdown };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
