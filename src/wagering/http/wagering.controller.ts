import { Body, Controller, Get, Param, Post, Query, Req, Res } from "@nestjs/common";
import { Scopes } from "../../identity/authorization";
import type { HttpReply, HttpRequest } from "../../shared/http/http-contract";
import { ApiError } from "../../shared/http/http-contract";
import { OpenWallet } from "../application/open-wallet";
import { ReconcileWallet, WageringQueries } from "../application/queries";
import { SubmitWagerTransaction } from "../application/submit-wager-transaction";
import { OpenWalletDto, WagerTransactionDto } from "./dtos";
import { ledgerCursor, parseLedgerQuery } from "./ledger-cursor";

function uuid(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
    throw new ApiError(400, "VALIDATION_FAILED", "Invalid resource identifier");
  return value;
}
function found<T>(value: T | null): T {
  if (value === null) throw new ApiError(404, "NOT_FOUND", "Resource not found");
  return value;
}
function bindProvider(request: HttpRequest, providerId: string, allowOperator = false) {
  if (allowOperator && request.identity?.scopes.includes("wallets.admin")) return;
  if (request.identity?.providerId !== providerId)
    throw new ApiError(
      403,
      "PROVIDER_MISMATCH",
      "The token does not allow access to this provider",
    );
}

@Controller()
export class WageringController {
  constructor(
    private readonly open: OpenWallet,
    private readonly submit: SubmitWagerTransaction,
    private readonly queries: WageringQueries,
    private readonly reconcile: ReconcileWallet,
  ) {}

  @Post("wallets")
  @Scopes("wallets.admin")
  openWallet(@Body() body: OpenWalletDto, @Req() request: HttpRequest) {
    return this.open.handle({ ...body, correlationId: request.correlationId });
  }

  @Get("wallets/:walletId")
  @Scopes("wallets.admin")
  async wallet(@Param("walletId") walletId: string) {
    return found(await this.queries.wallet(uuid(walletId)));
  }

  @Get("wallets/:walletId/ledger")
  @Scopes("wallets.admin")
  async ledger(@Param("walletId") walletId: string, @Query() query: Record<string, unknown>) {
    uuid(walletId);
    const { limit, afterVersion } = parseLedgerQuery(walletId, query);
    const rows = found(await this.queries.ledgerPage(walletId, afterVersion, limit + 1));
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: rows.length > limit && last ? ledgerCursor(walletId, last.walletVersion) : null,
    };
  }

  @Post("wallets/:walletId/reconciliation")
  @Scopes("wallets.admin")
  async reconciliation(
    @Param("walletId") walletId: string,
    @Res({ passthrough: true }) reply: HttpReply,
  ) {
    reply.status(200);
    return found(await this.reconcile.handle(uuid(walletId)));
  }

  @Post("wagering/transactions")
  @Scopes("wagering")
  async submitTransaction(
    @Body() body: WagerTransactionDto,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) reply: HttpReply,
  ) {
    bindProvider(request, body.providerId);
    const key = request.headers["idempotency-key"];
    if (key === undefined)
      throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key is required");
    if (typeof key !== "string" || !/^[\x20-\x7e]{1,255}$/.test(key))
      throw new ApiError(400, "VALIDATION_FAILED", "Invalid Idempotency-Key");
    const result = await this.submit.handle({
      ...body,
      idempotencyKey: key,
      correlationId: request.correlationId,
    });
    if (result.type === "idempotency_conflict")
      throw new ApiError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Idempotency key already used with a different payload",
      );
    if (result.type === "external_transaction_conflict")
      throw new ApiError(
        409,
        "EXTERNAL_TRANSACTION_CONFLICT",
        "External transaction already exists",
      );
    if (result.type !== "completed") throw new Error("Unexpected HTTP submission outcome");
    const transaction = result.transaction;
    reply.status(
      { PROCESSED: 200, PENDING_REFERENCE: 202, REJECTED: 422, FAILED: 500 }[transaction.status],
    );
    return {
      transactionId: transaction.transactionId,
      status: transaction.status,
      ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}),
      balance: transaction.balance,
      idempotentReplay: result.idempotentReplay,
    };
  }

  @Get("wagering/transactions/:transactionId")
  @Scopes("wagering", "wallets.admin")
  async transaction(@Param("transactionId") transactionId: string, @Req() request: HttpRequest) {
    const transaction = found(await this.queries.transaction(uuid(transactionId)));
    bindProvider(request, transaction.providerId, true);
    return transaction;
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  @Scopes("wagering", "wallets.admin")
  async providerTransaction(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalId: string,
    @Req() request: HttpRequest,
  ) {
    bindProvider(request, providerId, true);
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(providerId) || !/^[!-~]{1,128}$/.test(externalId))
      throw new ApiError(400, "VALIDATION_FAILED", "Invalid transaction identifier");
    return found(await this.queries.providerTransaction(providerId, externalId));
  }
}
