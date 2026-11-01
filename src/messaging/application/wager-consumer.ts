import { hostname } from "node:os";
import { Message } from "@aws-sdk/client-sqs";
import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Configuration } from "../../config/config";
import { QUEUES } from "../../observability/health/dependencies";
import { WageringTelemetry } from "../../observability/wagering-telemetry";
import { canonicalHash } from "../../shared/application/canonical-json";
import { PollingLoop, pause } from "../../shared/application/polling-loop";
import { SyncPointPort } from "../../shared/application/sync-point";
import { DomainError } from "../../shared/domain/domain-error";
import { Database } from "../../shared/infrastructure/database";
import {
  InboxPayloadConflictError,
  TransientProcessingError,
} from "../../wagering/application/errors";
import {
  SubmissionResult,
  SubmitWagerTransaction,
} from "../../wagering/application/submit-wager-transaction";
import { SqsTransport } from "../infrastructure/sqs-transport";
import { InvalidWagerMessage, parseWagerMessage } from "./wager-message";

@Injectable()
export class WagerConsumer implements OnModuleInit, OnModuleDestroy {
  private get logger() {
    return this.telemetry.logger;
  }
  private readonly instanceId = hostname();
  private readonly loop: PollingLoop;
  private databaseUnavailable = false;
  private probeAttempt = 0;
  private stopping = false;
  private drainExpired = false;
  private readonly outstanding = new Set<Message>();

  constructor(
    private readonly configuration: Configuration,
    private readonly transport: SqsTransport,
    private readonly submit: SubmitWagerTransaction,
    private readonly database: Database,
    private readonly syncPoint: SyncPointPort,
    private readonly telemetry: WageringTelemetry,
  ) {
    this.loop = new PollingLoop(
      (signal) => this.step(signal),
      () => this.logger.warning({ event: "consumer_poll_failed", instanceId: this.instanceId }),
    );
  }
  onModuleInit(): void {
    if (this.configuration.values.role === "consumer") this.loop.start();
  }
  private async step(signal: AbortSignal): Promise<void> {
    if (this.databaseUnavailable) {
      await pause(Math.min(250 * 2 ** this.probeAttempt++, 5000), signal);
      if (signal.aborted) return;
      try {
        const orm = await this.database.orm;
        await orm.em.getConnection().execute("SELECT 1");
        this.databaseUnavailable = false;
        this.probeAttempt = 0;
        this.logger.info({ event: "consumer_database_resumed", instanceId: this.instanceId });
      } catch {
        return;
      }
    }
    const messages = await this.transport.receive(QUEUES.requests, signal);
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      this.outstanding.add(message);
      const groupId = message.Attributes?.MessageGroupId ?? message.MessageId ?? "invalid";
      const group = groups.get(groupId) ?? [];
      group.push(message);
      groups.set(groupId, group);
    }
    const pending = [...groups.values()];
    let next = 0;
    await Promise.all(
      Array.from(
        { length: Math.min(pending.length, this.configuration.values.consumer.concurrency) },
        async () => {
          for (let index = next++; index < pending.length; index = next++) {
            let blocked = false;
            for (const message of pending[index] ?? []) {
              if (this.stopping || this.databaseUnavailable || blocked) {
                await this.release(message);
                this.outstanding.delete(message);
                continue;
              }
              try {
                blocked = !(await this.process(message));
              } catch {
                blocked = true;
                this.logger.warning({
                  event: "consumer_delivery_failed",
                  messageId: message.MessageId,
                  instanceId: this.instanceId,
                });
              } finally {
                this.outstanding.delete(message);
              }
            }
          }
        },
      ),
    );
  }
  private async process(message: Message): Promise<boolean> {
    return this.telemetry.context.run(
      { channel: "sqs", messageId: message.MessageId, correlationId: message.MessageId },
      () => this.processMessage(message),
    );
  }
  private async processMessage(message: Message): Promise<boolean> {
    let messageId = message.MessageId ?? "invalid";
    const attempt = Number(message.Attributes?.ApproximateReceiveCount ?? "1");
    try {
      const envelope = await parseWagerMessage(message.Body ?? "");
      if (message.Attributes?.MessageGroupId !== envelope.data.walletId)
        throw new InvalidWagerMessage("INVALID_MESSAGE");
      messageId = envelope.messageId;
      this.telemetry.context.add({
        messageId,
        correlationId: messageId,
        walletId: envelope.data.walletId,
        providerId: envelope.data.providerId,
      });
      const context = { operationId: messageId, instanceId: this.instanceId, attempt };
      let result: SubmissionResult;
      try {
        result = await this.submit.handle(
          { ...envelope.data, correlationId: messageId, causationId: messageId },
          {
            inbox: { messageId, payloadHash: canonicalHash(envelope.data) },
            sync: context,
          },
        );
      } catch (error) {
        if (error instanceof TransientProcessingError) {
          this.databaseUnavailable = true;
          this.logger.warning({
            event: "consumer_database_paused",
            messageId,
            instanceId: this.instanceId,
          });
        }
        throw error;
      }
      await this.syncPoint.reach("consumer.after_commit_before_ack", context);
      if (this.drainExpired) return false;
      if (result.type === "completed" && result.transaction.status === "FAILED") {
        await this.transport.deadLetter(message, messageId, "PROCESSING_FAILED");
        this.telemetry.dlq.inc({ reason: "PROCESSING_FAILED" });
      }
      await this.transport.acknowledge(QUEUES.requests, message);
      this.logger.info({
        event: "consumer_message_completed",
        messageId,
        walletId: envelope.data.walletId,
        providerId: envelope.data.providerId,
        transactionId: result.type === "completed" ? result.transaction.transactionId : undefined,
        outcome: result.type === "completed" ? result.transaction.status : result.type,
        attempt,
        instanceId: this.instanceId,
      });
      return true;
    } catch (error) {
      if (this.drainExpired) return false;
      const reason =
        error instanceof InvalidWagerMessage
          ? error.reason
          : error instanceof InboxPayloadConflictError
            ? "INBOX_PAYLOAD_CONFLICT"
            : error instanceof DomainError
              ? "INVALID_MESSAGE"
              : undefined;
      if (reason) {
        await this.transport.deadLetter(message, messageId, reason);
        this.telemetry.dlq.inc({ reason });
        await this.transport.acknowledge(QUEUES.requests, message);
        this.logger.warning({
          event: "consumer_message_dead_lettered",
          messageId,
          reason,
          instanceId: this.instanceId,
        });
        return true;
      }
      const config = this.configuration.values.consumer;
      const base = Math.min(
        config.retryBaseSeconds * 2 ** Math.min(attempt - 1, 20),
        config.retryMaxSeconds,
      );
      const seconds = Math.min(config.retryMaxSeconds, Math.ceil(base * (1 + Math.random() * 0.2)));
      await this.transport.visibility(QUEUES.requests, message, seconds);
      this.telemetry.retries.inc({ operation: "consumer" });
      this.logger.warning({
        event: "consumer_message_retry",
        messageId,
        attempt,
        visibilitySeconds: seconds,
        instanceId: this.instanceId,
      });
      return false;
    }
  }
  private async release(message: Message): Promise<void> {
    try {
      await this.transport.visibility(QUEUES.requests, message, 0);
    } catch {
      this.logger.warning({ event: "consumer_release_failed", instanceId: this.instanceId });
    }
  }
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    this.syncPoint.shutdown();
    const drained = await this.loop.stopWithin(this.configuration.values.consumer.shutdownDrainMs);
    if (!drained) {
      this.drainExpired = true;
      await Promise.all([...this.outstanding].map((message) => this.release(message)));
    }
    this.logger.info({
      event: "consumer_stopped",
      drained,
      instanceId: this.instanceId,
    });
  }
}
