import { Body, Controller, Get, Headers, HttpStatus, Inject, Param, Post, Res } from "@nestjs/common";
import { z } from "zod";
import { ProcessWagerTransactionUseCase } from "../application/process-wager-transaction.use-case";
import { QueryWalletUseCase } from "../application/query-wallet.use-case";
import { ValidationError } from "../domain/shared/errors";
import {
  SUBMITTABLE_KINDS,
  type WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wagering/wager-transaction";
import { parseWithSchema } from "./zod-validation";

const uuidParamSchema = z.string().uuid("Must be a valid UUID");

const submitWagerSchema = z.object({
  providerId: z.string().trim().min(1).max(64),
  externalTransactionId: z.string().trim().min(1).max(128),
  playerId: z.string().uuid("playerId must be a valid UUID"),
  walletId: z.string().uuid("walletId must be a valid UUID"),
  roundId: z.string().trim().min(1).max(128),
  gameId: z.string().trim().min(1).max(128),
  kind: z.enum(SUBMITTABLE_KINDS),
  money: z.object({
    amount: z.string(),
    currency: z.string(),
  }),
  referenceExternalTransactionId: z.string().trim().min(1).max(128).optional(),
});

interface ExpressLikeResponse {
  status: (code: number) => { json: (body: unknown) => void };
}

@Controller()
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransactionUseCase)
    private readonly processWager: ProcessWagerTransactionUseCase,
    @Inject(QueryWalletUseCase)
    private readonly queryWallet: QueryWalletUseCase,
  ) {}

  @Post("wagering/transactions")
  async submitTransaction(
    @Headers("idempotency-key") idempotencyKeyHeader: string | undefined,
    @Body() body: unknown,
    @Res() res: ExpressLikeResponse,
  ): Promise<void> {
    const idempotencyKey = idempotencyKeyHeader?.trim();
    if (!idempotencyKey) {
      throw new ValidationError("Header Idempotency-Key is required", [
        { path: "headers.idempotency-key", message: "Required" },
      ]);
    }

    const dto = parseWithSchema(submitWagerSchema, body);
    const result = await this.processWager.execute({
      providerId: dto.providerId,
      externalTransactionId: dto.externalTransactionId,
      idempotencyKey,
      playerId: dto.playerId,
      walletId: dto.walletId,
      roundId: dto.roundId,
      gameId: dto.gameId,
      kind: dto.kind as WagerTransactionKind,
      money: dto.money,
      referenceExternalTransactionId: dto.referenceExternalTransactionId,
      channel: "http",
    });

    const httpStatus = resolveHttpStatus(result.status, result.idempotentReplay);
    res.status(httpStatus).json(result);
  }

  @Get("wagering/transactions/:transactionId")
  async getById(@Param("transactionId") transactionIdParam: string) {
    const transactionId = parseWithSchema(uuidParamSchema, transactionIdParam);
    return this.queryWallet.getTransactionById(transactionId);
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async getByProviderAndExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    if (!providerId?.trim() || !externalTransactionId?.trim()) {
      throw new ValidationError("providerId and externalTransactionId are required");
    }
    return this.queryWallet.getTransactionByExternalId(providerId, externalTransactionId);
  }
}

/**
 * Distinct HTTP status codes per outcome so providers never have to parse error strings:
 *  - PROCESSED (new)          -> 201 Created
 *  - PROCESSED (replay)       -> 200 OK
 *  - PENDING_REFERENCE        -> 202 Accepted
 *  - REJECTED (business rule) -> 422 Unprocessable Entity
 */
function resolveHttpStatus(status: WagerTransactionStatus, isReplay: boolean): number {
  switch (status) {
    case WagerTransactionStatus.Processed:
      return isReplay ? HttpStatus.OK : HttpStatus.CREATED;
    case WagerTransactionStatus.PendingReference:
      return HttpStatus.ACCEPTED;
    case WagerTransactionStatus.Rejected:
      return HttpStatus.UNPROCESSABLE_ENTITY;
    default:
      return HttpStatus.INTERNAL_SERVER_ERROR;
  }
}

