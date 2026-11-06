import { Body, Controller, Headers, HttpCode, HttpStatus, Inject, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { OpenWallet } from '../../application/wagering/open-wallet';
import type { ProcessWagerTransaction } from '../../application/wagering/process-wager-transaction';
import { WagerTransactionStatus } from '../../domain/wagering/wager-enums';
import { OPEN_WALLET, PROCESS_WAGER_TRANSACTION } from './tokens';

type Json = Record<string, unknown>;

@Controller()
export class WageringController {
  constructor(
    @Inject(OPEN_WALLET) private readonly openWallet: OpenWallet,
    @Inject(PROCESS_WAGER_TRANSACTION) private readonly processWager: ProcessWagerTransaction,
  ) {}

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
