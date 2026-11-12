import type { Message as SqsWireMessage } from "@aws-sdk/client-sqs";
import { Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { z } from "zod";
import { ProcessWagerTransactionUseCase } from "../application/process-wager-transaction.use-case";
import { APP_CONFIG, type AppConfig } from "../config/config";
import {
  ConflictError,
  DomainError,
  NotFoundError,
  TransientError,
  ValidationError,
} from "../domain/shared/errors";
import { SUBMITTABLE_KINDS, type WagerTransactionKind } from "../domain/wagering/wager-transaction";
import { runWithContext } from "../observability/context";
import { errorFields, logger } from "../observability/logger";
import { metrics } from "../observability/metrics";
import { SqsService } from "./sqs.service";

export const SQS_CONSUMER_NAME = "wager-transactions-consumer";

const sqsEnvelopeSchema = z.object({
  messageId: z.string().min(1),
  type: z.literal("WagerTransactionRequested"),
  occurredAt: z.string().min(1),
  correlationId: z.string().optional(),
  data: z.object({
    providerId: z.string().min(1),
    externalTransactionId: z.string().min(1),
    idempotencyKey: z.string().min(1).optional(),
    playerId: z.string().uuid(),
    walletId: z.string().uuid(),
    roundId: z.string().min(1),
    gameId: z.string().min(1),
    kind: z.enum(SUBMITTABLE_KINDS),
    money: z.object({
      amount: z.string(),
      currency: z.string(),
    }),
    referenceExternalTransactionId: z.string().min(1).optional(),
  }),
});

/**
 * Background SQS consumer for `wager-transactions.fifo`.
 *
 * Guarantees:
 *  - Calls the exact same `ProcessWagerTransactionUseCase` as the HTTP controller;
 *  - Persistent inbox deduplication by `(consumerName, messageId)` inside the SQL transaction;
 *  - Sends SQS `DeleteMessage` (ack) **strictly after** the SQL transaction commits;
 *  - Distinguishes:
 *      * Business outcomes (`PROCESSED`, `REJECTED`, `PENDING_REFERENCE`, idempotent replay) -> ack;
 *      * Transient errors (`TransientError`, lock conflicts, DB downtime) -> backoff visibility timeout
 *        up to `maxReceiveCount`, then dead-letter;
 *      * Permanent errors (malformed JSON/schema, unknown wallet, idempotency conflict) -> dead-letter immediately;
 *  - On `SIGTERM` / `OnModuleDestroy`, stops polling and waits for in-flight messages to finish
 *    (releasing visibility if any message could not finish).
 */
@Injectable()
export class WagerSqsConsumer implements OnApplicationBootstrap, OnModuleDestroy {
  private running = false;
  private loopPromise?: Promise<void>;
  private readonly inFlightReceipts = new Set<string>();

  constructor(
    @Inject(SqsService) private readonly sqs: SqsService,
    @Inject(ProcessWagerTransactionUseCase)
    private readonly wagerUseCase: ProcessWagerTransactionUseCase,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.roles.has("consumer")) {
      return;
    }
    this.start();
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.loopPromise = this.pollLoop();
    logger.info({ consumer: SQS_CONSUMER_NAME }, "SQS wager consumer started");
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    await this.loopPromise;

    // If any receipt handle is still tracked during forced shutdown, return visibility to 0.
    for (const receiptHandle of this.inFlightReceipts) {
      try {
        await this.sqs.changeWagerMessageVisibility(receiptHandle, 0);
      } catch {
        // Best-effort visibility release on shutdown.
      }
    }
    this.inFlightReceipts.clear();
    logger.info({ consumer: SQS_CONSUMER_NAME }, "SQS wager consumer stopped gracefully");
  }

  /** Processes a single SQS wire message. Exposed for deterministic integration testing. */
  async handleMessage(wireMsg: SqsWireMessage): Promise<"acked" | "retried" | "dlq"> {
    const receiptHandle = wireMsg.ReceiptHandle;
    if (!receiptHandle) {
      return "acked";
    }

    this.inFlightReceipts.add(receiptHandle);
    const receiveCount = Number.parseInt(wireMsg.Attributes?.ApproximateReceiveCount ?? "1", 10) || 1;
    const rawBody = wireMsg.Body ?? "";

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawBody);
    } catch {
      await this.moveToDlq(wireMsg, "INVALID_JSON");
      this.inFlightReceipts.delete(receiptHandle);
      return "dlq";
    }

    const parsedEnvelope = sqsEnvelopeSchema.safeParse(parsedJson);
    if (!parsedEnvelope.success) {
      await this.moveToDlq(wireMsg, "INVALID_ENVELOPE_SCHEMA");
      this.inFlightReceipts.delete(receiptHandle);
      return "dlq";
    }

    const envelope = parsedEnvelope.data;
    const correlationId =
      envelope.correlationId ??
      wireMsg.MessageAttributes?.CorrelationId?.StringValue ??
      envelope.messageId;

    return runWithContext(
      {
        correlationId,
        messageId: envelope.messageId,
        walletId: envelope.data.walletId.toLowerCase(),
        providerId: envelope.data.providerId,
        channel: "sqs",
      },
      async () => {
        try {
          const idempotencyKey =
            envelope.data.idempotencyKey ??
            `${envelope.data.providerId}:${envelope.data.externalTransactionId}`;

          await this.wagerUseCase.execute({
            providerId: envelope.data.providerId,
            externalTransactionId: envelope.data.externalTransactionId,
            idempotencyKey,
            playerId: envelope.data.playerId,
            walletId: envelope.data.walletId,
            roundId: envelope.data.roundId,
            gameId: envelope.data.gameId,
            kind: envelope.data.kind as WagerTransactionKind,
            money: envelope.data.money,
            referenceExternalTransactionId: envelope.data.referenceExternalTransactionId,
            channel: "sqs",
            inbox: {
              consumerName: SQS_CONSUMER_NAME,
              messageId: envelope.messageId,
            },
          });

          // Strictly after SQL COMMIT: acknowledge the message in SQS.
          await this.sqs.ackWagerMessage(receiptHandle);
          return "acked";
        } catch (error) {
          return await this.handleFailure(wireMsg, envelope.messageId, receiveCount, error);
        } finally {
          this.inFlightReceipts.delete(receiptHandle);
        }
      },
    );
  }

  private async handleFailure(
    wireMsg: SqsWireMessage,
    messageId: string,
    receiveCount: number,
    error: unknown,
  ): Promise<"retried" | "dlq"> {
    const receiptHandle = wireMsg.ReceiptHandle!;

    // Permanent errors: invalid money/domain contract, non-existent wallet, or conflicting idempotency payload.
    if (
      error instanceof ValidationError ||
      error instanceof DomainError ||
      error instanceof ConflictError ||
      error instanceof NotFoundError
    ) {
      const reason = error.code;
      logger.warn({ messageId, reason, ...errorFields(error) }, "Permanent SQS message failure; moving to DLQ");
      await this.moveToDlq(wireMsg, reason);
      return "dlq";
    }

    // Transient infrastructure error (or unexpected runtime failure): retry with exponential backoff up to maxReceiveCount.
    const isTransient = error instanceof TransientError;
    if (receiveCount >= this.config.sqs.maxReceiveCount) {
      const reason = isTransient ? "MAX_RETRIES_EXCEEDED" : "UNEXPECTED_ERROR_MAX_RETRIES";
      logger.error(
        { messageId, receiveCount, ...errorFields(error, true) },
        "SQS message exhausted retry limit; moving to DLQ",
      );
      await this.moveToDlq(wireMsg, reason);
      return "dlq";
    }

    const backoffSeconds = Math.min(2 ** (receiveCount - 1), 30);
    metrics.retries.inc({
      component: "sqs_consumer",
      reason: isTransient ? "transient_error" : "unexpected_error",
    });
    logger.warn(
      { messageId, receiveCount, backoffSeconds, ...errorFields(error) },
      "Transient failure processing SQS message; scheduling retry",
    );

    try {
      await this.sqs.changeWagerMessageVisibility(receiptHandle, backoffSeconds);
    } catch (visibilityError) {
      logger.warn({ messageId, ...errorFields(visibilityError) }, "Failed to update SQS visibility timeout");
    }
    return "retried";
  }

  private async moveToDlq(wireMsg: SqsWireMessage, reason: string): Promise<void> {
    const receiptHandle = wireMsg.ReceiptHandle;
    if (!receiptHandle) {
      return;
    }
    const groupId = wireMsg.Attributes?.MessageGroupId ?? "dlq";
    const dedupId = wireMsg.Attributes?.MessageDeduplicationId ?? wireMsg.MessageId ?? `${Date.now()}`;
    await this.sqs.sendToDlqAndAck(wireMsg.Body ?? "", receiptHandle, groupId, dedupId, reason);
    metrics.deadLettered.inc({ reason });
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const messages = await this.sqs.receiveWagerMessages(10, 1);
        if (!this.running) {
          // Returned from long poll after stop() was called: release visibility of fetched messages.
          for (const msg of messages) {
            if (msg.ReceiptHandle) {
              await this.sqs.changeWagerMessageVisibility(msg.ReceiptHandle, 0).catch(() => undefined);
            }
          }
          break;
        }
        for (const message of messages) {
          if (!this.running) {
            if (message.ReceiptHandle) {
              await this.sqs.changeWagerMessageVisibility(message.ReceiptHandle, 0).catch(() => undefined);
            }
            continue;
          }
          await this.handleMessage(message);
        }
      } catch (error) {
        if (this.running) {
          logger.warn({ ...errorFields(error) }, "SQS poll iteration failed; backing off");
          await sleep(500);
        }
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

