import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { CreateWalletUseCase } from "../application/create-wallet.use-case";
import { QueryWalletUseCase } from "../application/query-wallet.use-case";
import { ReconcileWalletUseCase } from "../application/reconcile-wallet.use-case";
import { parseWithSchema } from "./zod-validation";

const uuidParamSchema = z.string().uuid("Must be a valid UUID");

const createWalletSchema = z.object({
  playerId: z.string().uuid("playerId must be a valid UUID"),
  initialBalance: z.object({
    amount: z.string(),
    currency: z.string(),
  }),
});

const ledgerQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

@Controller("wallets")
export class WalletsController {
  constructor(
    @Inject(CreateWalletUseCase) private readonly createWallet: CreateWalletUseCase,
    @Inject(QueryWalletUseCase) private readonly queryWallet: QueryWalletUseCase,
    @Inject(ReconcileWalletUseCase) private readonly reconcileWallet: ReconcileWalletUseCase,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async openWallet(@Body() body: unknown) {
    const dto = parseWithSchema(createWalletSchema, body);
    return this.createWallet.execute(dto);
  }

  @Get(":walletId")
  async getWallet(@Param("walletId") walletIdParam: string) {
    const walletId = parseWithSchema(uuidParamSchema, walletIdParam);
    return this.queryWallet.getWallet(walletId);
  }

  @Get(":walletId/ledger")
  async getLedger(
    @Param("walletId") walletIdParam: string,
    @Query() query: Record<string, unknown>,
  ) {
    const walletId = parseWithSchema(uuidParamSchema, walletIdParam);
    const { cursor, limit } = parseWithSchema(ledgerQuerySchema, query);
    return this.queryWallet.getLedger(walletId, cursor, limit ?? 50);
  }

  @Post(":walletId/reconciliation")
  @HttpCode(HttpStatus.OK)
  async reconcile(@Param("walletId") walletIdParam: string) {
    const walletId = parseWithSchema(uuidParamSchema, walletIdParam);
    return this.reconcileWallet.execute(walletId);
  }
}
