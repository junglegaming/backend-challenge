import {
  ApplicationError,
  IdempotencyConflictError,
  TransientInfrastructureError,
  ValidationError,
  WalletNotFoundForSubmissionError,
} from "../../../shared/application/errors";
import { type AppLogger, type AppMetrics, logContext } from "../../../shared/application/observability";
import type { UnitOfWork } from "../../../shared/application/unit-of-work";
import type { Clock, IdGenerator } from "../../../shared/domain/ports";
import { OutboxMessage } from "../../messaging/domain/outbox-message";
import { WagerSubmissionFailed } from "../domain/events/wagering-events";
import {
  type RecordSubmissionFailureProps,
  type SubmissionChannel,
  SubmissionFailure,
  SubmissionFailureCategory,
} from "../domain/submission-failure";

export interface FailureClassification {
  reasonCode: string;
  category: SubmissionFailureCategory;
  retryable: boolean;
  detail: string;
}

/** Maps an error that aborted a submission to the audit taxonomy (stable codes, machine-readable). */
export function classifySubmissionError(error: unknown): FailureClassification {
  const detail = error instanceof Error ? error.message : String(error);
  if (error instanceof ValidationError) {
    return {
      reasonCode: error.code,
      category: SubmissionFailureCategory.Validation,
      retryable: false,
      detail,
    };
  }
  if (error instanceof IdempotencyConflictError) {
    const reason = String(error.details?.reason ?? "");
    return {
      reasonCode: error.code,
      category: SubmissionFailureCategory.Conflict,
      retryable: false,
      detail: reason ? `${reason}: ${detail}` : detail,
    };
  }
  if (error instanceof WalletNotFoundForSubmissionError) {
    // Resending the same request works once the wallet exists.
    return {
      reasonCode: error.code,
      category: SubmissionFailureCategory.Unprocessable,
      retryable: true,
      detail,
    };
  }
  if (error instanceof TransientInfrastructureError) {
    return {
      reasonCode: error.code,
      category: SubmissionFailureCategory.Infrastructure,
      retryable: true,
      detail,
    };
  }
  if (error instanceof ApplicationError) {
    return {
      reasonCode: error.code,
      category:
        error.kind === "TRANSIENT"
          ? SubmissionFailureCategory.Infrastructure
          : SubmissionFailureCategory.Validation,
      retryable: error.kind === "TRANSIENT",
      detail,
    };
  }
  return {
    reasonCode: "INTERNAL_ERROR",
    category: SubmissionFailureCategory.Infrastructure,
    retryable: true,
    detail,
  };
}

export type RecordFailureInput = Omit<RecordSubmissionFailureProps, "id" | "occurredAt">;

/**
 * Persists the audit record and its WagerSubmissionFailed event in ONE transaction (separate from the failed
 * one, which already rolled back). Best effort by design: if the database itself is the problem, the original
 * error must still reach the caller — so this never throws, it logs.
 */
export class RecordSubmissionFailure {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly metrics: AppMetrics,
    private readonly logger: AppLogger,
  ) {}

  /**
   * @param options.persist false = count it in metrics only (the caller decided the failure is not worth a row,
   *        e.g. an unattributable HTTP request that no provider could ever query).
   */
  async execute(
    input: RecordFailureInput,
    options: { persist?: boolean } = {},
  ): Promise<SubmissionFailure | undefined> {
    this.metrics.submissionFailure(input.channel, input.reasonCode);
    if (input.category === SubmissionFailureCategory.Conflict) {
      this.metrics.idempotencyConflict(input.channel, input.detail?.split(":")[0] ?? input.reasonCode);
    }
    if (options.persist === false) {
      this.logger.debug({ reasonCode: input.reasonCode }, "unattributable submission failure (metrics only)");
      return undefined;
    }
    try {
      const now = this.clock.now();
      const failure = SubmissionFailure.record({
        ...input,
        correlationId: input.correlationId ?? logContext.get().correlationId,
        id: this.ids.next(),
        occurredAt: now,
      });
      await this.uow.transaction(
        async (scope) => {
          await scope.failures.insert(failure);
          await scope.outbox.add([
            OutboxMessage.enqueue(
              WagerSubmissionFailed.from(failure, {
                eventId: this.ids.next(),
                correlationId: failure.correlationId ?? failure.id,
                causationId: failure.messageId ?? failure.idempotencyKey,
                occurredAt: now,
              }),
            ),
          ]);
        },
        { label: "record-submission-failure", retryTransient: false },
      );
      this.logger.warn(
        {
          failureId: failure.id,
          reasonCode: failure.reasonCode,
          category: failure.category,
          retryable: failure.retryable,
        },
        "submission failure recorded",
      );
      return failure;
    } catch (error) {
      this.logger.error({ err: error, reasonCode: input.reasonCode }, "could not record submission failure");
      return undefined;
    }
  }
}

export interface SubmissionFailureView {
  failureId: string;
  channel: SubmissionChannel;
  reasonCode: string;
  category: SubmissionFailureCategory;
  retryable: boolean;
  idempotencyKey: string | null;
  messageId: string | null;
  transactionId: string | null;
  detail: string | null;
  receiveCount: number | null;
  correlationId: string | null;
  occurredAt: string;
}

export const toFailureView = (f: SubmissionFailure): SubmissionFailureView => ({
  failureId: f.id,
  channel: f.channel,
  reasonCode: f.reasonCode,
  category: f.category,
  retryable: f.retryable,
  idempotencyKey: f.idempotencyKey ?? null,
  messageId: f.messageId ?? null,
  transactionId: f.transactionId ?? null,
  detail: f.detail ?? null,
  receiveCount: f.receiveCount ?? null,
  correlationId: f.correlationId ?? null,
  occurredAt: f.occurredAt.toISOString(),
});

export class ListSubmissionFailures {
  constructor(private readonly uow: UnitOfWork) {}

  async byExternalId(
    providerId: string,
    externalTransactionId: string,
    limit = 50,
  ): Promise<SubmissionFailureView[]> {
    const items = await this.uow.snapshot(
      (s) => s.failures.listByExternalId(providerId, externalTransactionId, limit),
      { label: "list-submission-failures" },
    );
    return items.map(toFailureView);
  }
}
