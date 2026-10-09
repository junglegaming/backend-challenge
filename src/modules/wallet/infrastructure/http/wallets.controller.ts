import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from "@nestjs/common";
import { parseOrThrow } from "../../../../infrastructure/http/validation";
import { logContext } from "../../../../shared/application/observability";
import { RequireScope, Scope } from "../../../auth/provider-auth";
import {
  CreateWalletContract,
  LedgerQueryContract,
  UuidParam,
} from "../../../wagering/infrastructure/contracts";
import {
  CreateWallet,
  GetWallet,
  type LedgerPage,
  ListWalletLedger,
  ReconcileWallet,
  type ReconciliationReport,
  type WalletView,
} from "../../application/wallet-use-cases";

@Controller("wallets")
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWallet,
    private readonly getWallet: GetWallet,
    private readonly listLedger: ListWalletLedger,
    private readonly reconcileWallet: ReconcileWallet,
  ) {}

  /** Back-office only: a positive opening balance creates money (OPENING credit). */
  @Post()
  @RequireScope(Scope.WalletsManage)
  @HttpCode(HttpStatus.CREATED)
  create(@Body() body: unknown): Promise<WalletView> {
    const input = parseOrThrow(CreateWalletContract, body, "wallet");
    return this.createWallet.execute({ ...input, correlationId: logContext.get().correlationId ?? "n/a" });
  }

  @Get(":walletId")
  @RequireScope(Scope.WalletsRead)
  get(@Param("walletId") walletId: string): Promise<WalletView> {
    return this.getWallet.execute(parseOrThrow(UuidParam, walletId, "walletId"));
  }

  @Get(":walletId/ledger")
  @RequireScope(Scope.WalletsRead)
  ledger(@Param("walletId") walletId: string, @Query() query: unknown): Promise<LedgerPage> {
    const id = parseOrThrow(UuidParam, walletId, "walletId");
    const { cursor, limit } = parseOrThrow(LedgerQueryContract, query, "query");
    return this.listLedger.execute(id, cursor, limit);
  }

  /** Read-only check; divergences are reported, logged and counted — never corrected silently. */
  @Post(":walletId/reconciliation")
  @RequireScope(Scope.WalletsManage)
  @HttpCode(HttpStatus.OK)
  reconcile(@Param("walletId") walletId: string): Promise<ReconciliationReport> {
    return this.reconcileWallet.execute(parseOrThrow(UuidParam, walletId, "walletId"));
  }
}
