import { Body, Controller, Get, Headers, HttpStatus, Param, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { parseOrThrow } from "../../../../infrastructure/http/validation";
import { NotFoundError, TransientInfrastructureError } from "../../../../shared/application/errors";
import { logContext } from "../../../../shared/application/observability";
import {
  canAccessProvider,
  Principal,
  type ProviderPrincipal,
  RequireScope,
  Scope,
} from "../../../auth/provider-auth";
import { ProcessWagerTransaction, type SubmitWagerResult } from "../../application/process-wager-transaction";
import {
  classifySubmissionError,
  ListSubmissionFailures,
  RecordSubmissionFailure,
  type SubmissionFailureView,
} from "../../application/submission-failures";
import { GetWagerTransaction, type WagerTransactionView } from "../../application/wager-queries";
import { computeWagerPayloadHash } from "../../domain/payload-hash";
import type { ExternalWagerKind } from "../../domain/wager-transaction-kind";
import { WagerTransactionStatus } from "../../domain/wager-transaction-kind";
import {
  ExternalIdContract,
  IdempotencyKeyContract,
  ProviderIdContract,
  UuidParam,
  WagerPayloadContract,
} from "../contracts";

/**
 * Transaction outcome → HTTP status (identical for first execution and replays; `idempotentReplay`
 * and the `Idempotent-Replayed` header tell them apart):
 *   PROCESSED → 201, PENDING_REFERENCE → 202, REJECTED → 422 and FAILED → 422 (terminal, carry failureCode).
 */
const OUTCOME_STATUS: Record<WagerTransactionStatus, number> = {
  [WagerTransactionStatus.Processed]: HttpStatus.CREATED,
  [WagerTransactionStatus.PendingReference]: HttpStatus.ACCEPTED,
  [WagerTransactionStatus.Pending]: HttpStatus.ACCEPTED,
  [WagerTransactionStatus.Rejected]: HttpStatus.UNPROCESSABLE_ENTITY,
  [WagerTransactionStatus.Failed]: HttpStatus.UNPROCESSABLE_ENTITY,
};

const FailuresQuery = z.strictObject({ limit: z.coerce.number().int().min(1).max(100).default(50) });

@Controller()
export class WageringController {
  constructor(
    private readonly processWager: ProcessWagerTransaction,
    private readonly getWager: GetWagerTransaction,
    private readonly recordFailure: RecordSubmissionFailure,
    private readonly listFailures: ListSubmissionFailures,
  ) {}

  @Post("wagering/transactions")
  @RequireScope(Scope.WagersSubmit)
  async submit(
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Omit<SubmitWagerResult, "duplicateMessage">> {
    try {
      const key = parseOrThrow(IdempotencyKeyContract, idempotencyKey, "Idempotency-Key header");
      const payload = parseOrThrow(WagerPayloadContract, body, "wager transaction");
      const { correlationId = key } = logContext.get();

      const result = await this.processWager.execute({
        ...payload,
        kind: payload.kind as ExternalWagerKind,
        idempotencyKey: key,
        channel: "http",
        correlationId,
        causationId: key,
      });

      res.status(OUTCOME_STATUS[result.status]);
      if (result.idempotentReplay) res.setHeader("Idempotent-Replayed", "true");
      const { duplicateMessage: _ignored, ...response } = result;
      return response;
    } catch (error) {
      await this.audit(error, idempotencyKey, body);
      throw error;
    }
  }

  /** Audit trail for one provider transaction: why earlier submissions were refused (newest first). */
  @Get("providers/:providerId/wagering/transactions/:externalTransactionId/failures")
  @RequireScope(Scope.WagersRead)
  failures(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
    @Query() query: unknown,
  ): Promise<SubmissionFailureView[]> {
    const { limit } = parseOrThrow(FailuresQuery, query, "query");
    return this.listFailures.byExternalId(providerId, externalTransactionId, limit);
  }

  /** Another provider's transaction answers 404, exactly like a missing one: ids cannot be probed. */
  @Get("wagering/transactions/:transactionId")
  @RequireScope(Scope.WagersRead)
  async byId(
    @Param("transactionId") transactionId: string,
    @Principal() principal: ProviderPrincipal,
  ): Promise<WagerTransactionView> {
    const id = parseOrThrow(UuidParam, transactionId, "transactionId");
    const view = await this.getWager.byId(id);
    if (!canAccessProvider(principal, view.providerId)) throw new NotFoundError("transaction", id);
    return view;
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  @RequireScope(Scope.WagersRead)
  byExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    return this.getWager.byProviderExternalId(providerId, externalTransactionId);
  }

  /**
   * Transient failures (503) are not audited on HTTP: the caller already got a retryable answer synchronously,
   * metrics count them, and writing an audit row per attempt during a database incident would only add load.
   *
   * Only *attributable* failures are stored (valid providerId and externalTransactionId): they are the only ones a
   * provider can ever query, and storing anonymous garbage would let any client turn cheap invalid requests into
   * database rows, outbox events and broker messages. The rest is counted in metrics only.
   */
  private async audit(error: unknown, idempotencyKey: string | undefined, body: unknown): Promise<void> {
    if (error instanceof TransientInfrastructureError) return;
    const raw = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    const parsed = WagerPayloadContract.safeParse(body);
    const attributable =
      ProviderIdContract.safeParse(raw.providerId).success &&
      ExternalIdContract.safeParse(raw.externalTransactionId).success;
    const classification = classifySubmissionError(error);
    await this.recordFailure.execute(
      {
        channel: "http",
        ...classification,
        providerId: str(raw.providerId),
        externalTransactionId: str(raw.externalTransactionId),
        idempotencyKey,
        walletId: str(raw.walletId),
        payloadHash: parsed.success ? computeWagerPayloadHash(parsed.data) : undefined,
      },
      { persist: attributable },
    );
  }
}
