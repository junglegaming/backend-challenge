import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { metrics } from './metrics';
import { AppService } from './app.service';
import { DomainError } from './domain/money';
@Controller()
export class AppController {
  constructor(private readonly app: AppService) {}
  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof DomainError) {
        const status = e.code.includes('CONFLICT')
          ? 409
          : e.code.includes('INSUFFICIENT') || e.code === 'REFERENCE_INVALID'
            ? 422
            : 400;
        throw new HttpException({ code: e.code, message: e.message }, status);
      }
      const error = e as { code?: string; driverError?: { code?: string } };
      const sqlState = error.driverError?.code ?? error.code;
      if (
        sqlState?.startsWith('08') ||
        ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(sqlState ?? '')
      )
        throw new HttpException({ code: 'INFRASTRUCTURE_UNAVAILABLE' }, 503);
      if (sqlState === '23505') throw new HttpException({ code: 'CONFLICT' }, 409);
      throw e;
    }
  }
  @Get('health/live') live() {
    return { status: 'ok' };
  }
  @Get('metrics') metrics() {
    return metrics.render();
  }
  @Get('health/ready') async ready() {
    try {
      await this.app.readiness();
      return { status: 'ready' };
    } catch {
      throw new HttpException({ status: 'unavailable' }, 503);
    }
  }
  @Post('wallets') createWallet(@Body() body: any) {
    return this.run(() => this.app.createWallet(body));
  }
  @Get('wallets/:id') async wallet(@Param('id') id: string) {
    const result = await this.app.wallet(id);
    if (!result) throw new HttpException({ code: 'WALLET_NOT_FOUND' }, 404);
    return result;
  }
  @Get('wallets/:id/ledger') ledger(
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.app.ledger(id, cursor, limit ? Number.parseInt(limit, 10) : 50);
  }
  @Post('wallets/:id/reconciliation') async reconcile(@Param('id') id: string) {
    const r = await this.app.reconcile(id);
    if (!r) throw new HttpException({ code: 'WALLET_NOT_FOUND' }, 404);
    return r;
  }
  @Post('wagering/transactions') async submit(
    @Body() body: any,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.run(() => this.app.submit(body, key ?? ''));
    if ('status' in result) {
      if (result.status === 'PENDING_REFERENCE') response.status(202);
      else if (result.status === 'REJECTED') response.status(422);
    }
    return result;
  }
  @Get('wagering/transactions/:id') async transaction(@Param('id') id: string) {
    const r = await this.app.transaction(id);
    if (!r) throw new HttpException({ code: 'TRANSACTION_NOT_FOUND' }, 404);
    return r;
  }
  @Get('providers/:providerId/wagering/transactions/:externalId') async external(
    @Param('providerId') p: string,
    @Param('externalId') x: string,
  ) {
    const r = await this.app.byExternal(p, x);
    if (!r) throw new HttpException({ code: 'TRANSACTION_NOT_FOUND' }, 404);
    return r;
  }
}
