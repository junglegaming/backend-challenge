import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { OpenWallet } from '../../application/wagering/open-wallet';
import type { ProcessWagerTransaction } from '../../application/wagering/process-wager-transaction';
import { GetTransaction, GetWallet, ListLedger, ReconcileWallet } from '../../application/wagering/wallet-queries';
import { WagerTransactionStatus } from '../../domain/wagering/wager-enums';
import { OPEN_WALLET, PROCESS_WAGER_TRANSACTION } from './tokens';
import { updateContext } from '../../application/observability/context';

type Json = Record<string, unknown>;

@Controller()
export class WageringController {
  constructor(
    @Inject(OPEN_WALLET) private readonly openWallet: OpenWallet,
    @Inject(PROCESS_WAGER_TRANSACTION) private readonly processWager: ProcessWagerTransaction,
    @Inject(GetWallet) private readonly getWallet: GetWallet,
    @Inject(ListLedger) private readonly listLedger: ListLedger,
    @Inject(GetTransaction) private readonly getTransaction: GetTransaction,
    @Inject(ReconcileWallet) private readonly reconcileWallet: ReconcileWallet,
  ) {}

  @Get('wallets/:id')
  wallet(@Param('id') id: string): Promise<unknown> {
    updateContext({ walletId: id });
    return this.getWallet.execute(id);
  }

  @Get('wallets/:id/ledger')
  ledger(@Param('id') id: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string): Promise<unknown> {
    updateContext({ walletId: id });
    return this.listLedger.execute(id, { cursor, limit });
  }

  @Post('wallets/:id/reconciliation')
  @HttpCode(HttpStatus.OK)
  reconciliation(@Param('id') id: string): Promise<unknown> {
    updateContext({ walletId: id });
    return this.reconcileWallet.execute(id);
  }

  @Get('wagering/transactions/:id')
  transaction(@Param('id') id: string): Promise<unknown> {
    updateContext({ transactionId: id });
    return this.getTransaction.byId(id);
  }

  @Get('providers/:providerId/wagering/transactions/:externalId')
  providerTransaction(@Param('providerId') providerId: string, @Param('externalId') externalId: string): Promise<unknown> {
    updateContext({ providerId });
    return this.getTransaction.byProvider(providerId, externalId);
  }

  @Post('wallets')
  @HttpCode(HttpStatus.CREATED)
  async createWallet(@Body() body: Json | undefined): Promise<unknown> {
    const input = (body ?? {}) as Json;
    return this.openWallet.execute({ playerId: input.playerId as string, initialBalance: input.initialBalance as never });
  }

  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: Json | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const input = (body ?? {}) as Json;
    const result = await this.processWager.execute({
      idempotencyKey: idempotencyKey as string,
      providerId: input.providerId as string,
      externalTransactionId: input.externalTransactionId as string,
      playerId: input.playerId as string,
      walletId: input.walletId as string,
      roundId: input.roundId as string,
      gameId: input.gameId as string,
      kind: input.kind as never,
      money: input.money as never,
      referenceExternalTransactionId: input.referenceExternalTransactionId as string | undefined,
    });

    res.status(statusFor(result.status));
    return result;
  }
}

/** Business outcome → HTTP status (see ARCHITECTURE.md, ADR-006). */
export function statusFor(status: WagerTransactionStatus): number {
  switch (status) {
    case WagerTransactionStatus.Processed:
      return HttpStatus.OK;
    case WagerTransactionStatus.PendingReference:
    case WagerTransactionStatus.Pending:
      return HttpStatus.ACCEPTED;
    case WagerTransactionStatus.Rejected:
      return HttpStatus.UNPROCESSABLE_ENTITY;
    case WagerTransactionStatus.Failed:
      return HttpStatus.INTERNAL_SERVER_ERROR;
  }
}
