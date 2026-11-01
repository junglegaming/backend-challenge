import { hostname } from "node:os";
import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import pino from "pino";
import { Configuration } from "../../config/config";
import { PollingLoop, pause } from "../../shared/application/polling-loop";
import { SyncPointPort } from "../../shared/application/sync-point";
import { UnitOfWork } from "../../shared/application/unit-of-work";
import { SqlOutboxRepository } from "../infrastructure/repositories";
import { SqsTransport } from "../infrastructure/sqs-transport";

@Injectable()
export class OutboxPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = pino();
  private readonly instanceId = hostname();
  private readonly loop: PollingLoop;
  private drainExpired = false;

  constructor(
    private readonly configuration: Configuration,
    private readonly uow: UnitOfWork,
    private readonly outbox: SqlOutboxRepository,
    private readonly transport: SqsTransport,
    private readonly syncPoint: SyncPointPort,
  ) {
    this.loop = new PollingLoop(
      async (signal) => {
        if (!(await this.publishDue())) await pause(250, signal);
      },
      () => this.logger.warn({ event: "outbox_publish_failed", instanceId: this.instanceId }),
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
      await this.syncPoint.reach("publisher.after_claim_before_send", {
        operationId: message.id,
        instanceId: this.instanceId,
        attempt: message.attempts,
      });
    }
    if (this.drainExpired) return 0;
    const confirmed = await this.transport.publish(messages);
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
      this.logger.info({
        event: "outbox_publish_completed",
        eventId: message.id,
        eventType: message.eventType,
        aggregateId: message.aggregateId,
        attempt: message.attempts,
        confirmed: confirmed.has(message.id),
        instanceId: this.instanceId,
      });
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
