import { hostname } from "node:os";
import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Configuration } from "../../config/config";
import { WageringTelemetry } from "../../observability/wagering-telemetry";
import { PollingLoop, pause } from "../../shared/application/polling-loop";
import { SyncPointPort } from "../../shared/application/sync-point";
import { UnitOfWork } from "../../shared/application/unit-of-work";
import { SqlOutboxRepository } from "../infrastructure/repositories";
import { SqsTransport } from "../infrastructure/sqs-transport";

@Injectable()
export class OutboxPublisher implements OnModuleInit, OnModuleDestroy {
  private get logger() {
    return this.telemetry.logger;
  }
  private readonly instanceId = hostname();
  private readonly loop: PollingLoop;
  private drainExpired = false;

  constructor(
    private readonly configuration: Configuration,
    private readonly uow: UnitOfWork,
    private readonly outbox: SqlOutboxRepository,
    private readonly transport: SqsTransport,
    private readonly syncPoint: SyncPointPort,
    private readonly telemetry: WageringTelemetry,
  ) {
    this.loop = new PollingLoop(
      async (signal) => {
        if (!(await this.publishDue())) await pause(250, signal);
      },
      () => this.logger.warning({ event: "outbox_publish_failed", instanceId: this.instanceId }),
    );
  }

  onModuleInit(): void {
    if (this.configuration.values.role === "worker") this.loop.start();
  }

  async publishDue(): Promise<number> {
    const messages = await this.uow.run(async (tx) => {
      const now = new Date();
      const claimed = await this.outbox.claimDue(tx, now, 10);
      for (const message of claimed) {
        message.scheduleRetry(now, {
          leaseMs: this.configuration.values.outbox.leaseMs,
          maxMs: this.configuration.values.outbox.retryMaxMs,
        });
        await this.outbox.save(tx, message);
      }
      return claimed;
    });
    if (!messages.length || this.drainExpired) return 0;
    for (const message of messages) {
      if (message.attempts > 1) this.telemetry.retries.inc({ operation: "outbox" });
      await this.syncPoint.reach("publisher.after_claim_before_send", {
        operationId: message.id,
        instanceId: this.instanceId,
        attempt: message.attempts,
      });
    }
    if (this.drainExpired) return 0;
    let confirmed: Set<string>;
    try {
      confirmed = await this.transport.publish(messages);
    } catch (error) {
      this.telemetry.publishFailures.inc(messages.length);
      throw error;
    }
    this.telemetry.publishFailures.inc(
      messages.filter((message) => !confirmed.has(message.id)).length,
    );
    for (const message of messages) {
      await this.syncPoint.reach("publisher.after_send_before_mark", {
        operationId: message.id,
        instanceId: this.instanceId,
        attempt: message.attempts,
      });
    }
    if (this.drainExpired) return 0;
    await this.uow.run(async (tx) => {
      const now = new Date();
      for (const message of messages) {
        if (confirmed.has(message.id)) await this.outbox.markPublished(tx, message.id, now);
      }
    });
    for (const message of messages) {
      if (confirmed.has(message.id))
        this.telemetry.published.inc({ event_type: message.eventType });
      const payload = message.payload;
      const data = payload.data as Record<string, unknown>;
      const identifier = (value: unknown) => (typeof value === "string" ? value : undefined);
      this.telemetry.context.run(
        {
          channel: "outbox",
          correlationId: identifier(payload.correlationId),
          walletId: identifier(data.walletId),
          providerId: identifier(data.providerId),
          transactionId: identifier(data.transactionId),
        },
        () =>
          this.logger.info({
            event: "outbox_publish_completed",
            eventId: message.id,
            eventType: message.eventType,
            aggregateId: message.aggregateId,
            attempt: message.attempts,
            confirmed: confirmed.has(message.id),
            instanceId: this.instanceId,
          }),
      );
    }
    return messages.length;
  }

  async onModuleDestroy(): Promise<void> {
    this.syncPoint.shutdown();
    const drained = await this.loop.stopWithin(this.configuration.values.consumer.shutdownDrainMs);
    this.drainExpired = !drained;
    this.logger.info({ event: "publisher_stopped", drained, instanceId: this.instanceId });
  }
}
