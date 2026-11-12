import { Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/config";
import { TransactionRunner } from "../database/transaction-runner";
import type { OutboxMessage } from "../domain/messaging/outbox-message";
import { SqsService } from "../messaging/sqs.service";
import { runWithContext } from "../observability/context";
import { errorFields, logger } from "../observability/logger";
import { metrics } from "../observability/metrics";

/**
 * Transactional Outbox publisher worker.
 *
 * Safe to run on multiple instances concurrently:
 *  1. Claims a batch of due messages using `FOR UPDATE SKIP LOCKED` and stamps
 *     a time-bounded lease (`locked_by`, `locked_until`);
 *  2. Publishes each claimed envelope to SQS outside the DB transaction;
 *  3. Marks the row as published (or schedules an exponential-backoff retry)
 *     only if this worker still holds the lease;
 *  4. If a worker crashes after step 1, its lease expires and another instance
 *     publishes the event.
 */
@Injectable()
export class OutboxPublisherWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private inFlight?: Promise<number>;

  constructor(
    @Inject(TransactionRunner) private readonly txRunner: TransactionRunner,
    @Inject(SqsService) private readonly sqs: SqsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.roles.has("outbox")) {
      return;
    }
    this.start();
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.timer = setInterval(() => {
      if (!this.inFlight) {
        this.inFlight = this.publishBatch().finally(() => {
          this.inFlight = undefined;
        });
      }
    }, this.config.outbox.pollIntervalMs);
    logger.info({ owner: this.config.instanceId }, "Outbox publisher worker started");
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.inFlight) {
      await this.inFlight;
    }
    logger.info({ owner: this.config.instanceId }, "Outbox publisher worker stopped");
  }

  /**
   * Claims and publishes one batch of due outbox messages.
   * Exposed publicly so integration/concurrency tests can trigger deterministic ticks.
   */
  async publishBatch(customOwner?: string): Promise<number> {
    const owner = customOwner ?? this.config.instanceId;
    try {
      const claimed = await this.txRunner.run((ctx) =>
        ctx.outbox.claimDue(owner, this.config.outbox.batchSize, this.config.outbox.leaseMs),
      );

      let publishedCount = 0;
      for (const message of claimed) {
        const ok = await this.publishSingle(message, owner);
        if (ok) {
          publishedCount += 1;
        }
      }

      const lag = await this.txRunner.read((ctx) => ctx.outbox.lagSeconds());
      metrics.outboxLag.set(lag);
      return publishedCount;
    } catch (error) {
      logger.warn({ owner, ...errorFields(error) }, "Outbox batch iteration failed");
      return 0;
    }
  }

  private async publishSingle(message: OutboxMessage, owner: string): Promise<boolean> {
    const correlationId =
      typeof message.payload.correlationId === "string" ? message.payload.correlationId : message.id;

    return runWithContext({ correlationId, channel: "worker" }, async () => {
      try {
        await this.sqs.publishIntegrationEvent(
          message.id,
          message.aggregateId,
          message.eventType,
          message.payload as Record<string, unknown>,
        );
        message.markPublished(new Date());
        await this.txRunner.run((ctx) => ctx.outbox.markPublished(message, owner));
        metrics.outboxPublished.inc({ event_type: message.eventType });
        return true;
      } catch (error) {
        const now = new Date();
        message.scheduleRetry(now);
        const errorMessage = error instanceof Error ? error.message : String(error);
        await this.txRunner
          .run((ctx) => ctx.outbox.scheduleRetry(message, owner, errorMessage))
          .catch((dbErr) => {
            logger.warn({ outboxId: message.id, ...errorFields(dbErr) }, "Failed to record outbox retry");
          });
        metrics.retries.inc({ component: "outbox_publisher", reason: "publish_error" });
        logger.warn(
          { outboxId: message.id, eventType: message.eventType, attempts: message.attempts, ...errorFields(error) },
          "Outbox publish failed; scheduled retry",
        );
        return false;
      }
    });
  }
}

