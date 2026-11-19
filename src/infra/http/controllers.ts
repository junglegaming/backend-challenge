import { Body, Controller, Get, Header, Headers, HttpCode, Inject, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import type { Request, Response } from 'express';
import { OpenWallet } from '../../application/open-wallet';
import { SubmitResult, SubmitWagerTransaction } from '../../application/submit-wager-transaction';
import { ValidationError } from '../../domain/errors';
import { WagerTransactionStatus } from '../../domain/wager-transaction';
import { registry } from '../../observability/metrics';
import { ReadModel } from '../persistence/read-model';
import { queueDepth, QUEUES, type QueueUrls } from '../sqs/queues';
import { correlationIdOf, ProviderAuthGuard, uuidParam } from './http';

@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    private readonly openWallet: OpenWallet,
    private readonly read: ReadModel,
  ) {}

  @Post()
  open(@Body() body: unknown, @Req() req: Request) {
    return this.openWallet.execute(body, correlationIdOf(req));
  }

  @Get(':walletId')
  get(@Param('walletId') walletId: string) {
    return this.read.wallet(uuidParam(walletId, 'walletId'));
  }

  @Get(':walletId/ledger')
  ledger(@Param('walletId') walletId: string, @Query('cursor') cursor?: string, @Query('limit') limit = '50') {
    const size = Number(limit);
    if (!Number.isInteger(size) || size < 1 || size > 200) throw new ValidationError('limit must be an integer between 1 and 200');
    return this.read.ledger(uuidParam(walletId, 'walletId'), cursor, size);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconcile(@Param('walletId') walletId: string) {
    return this.read.reconcile(uuidParam(walletId, 'walletId'));
  }
}

const SUBMIT_STATUS: Record<string, number> = {
  [WagerTransactionStatus.Processed]: 200,
  [WagerTransactionStatus.PendingReference]: 202, // aceita, processamento pendente
  [WagerTransactionStatus.Rejected]: 422, // recusada por regra de negócio (failureCode no corpo)
  [WagerTransactionStatus.Failed]: 422,
};

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    private readonly submit: SubmitWagerTransaction,
    private readonly read: ReadModel,
  ) {}

  @Post('wagering/transactions')
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = (await this.submit.execute({
      idempotencyKey: idempotencyKey ?? '',
      payload: body,
      correlationId: correlationIdOf(req),
    })) as SubmitResult;
    res.status(SUBMIT_STATUS[result.status] ?? 200);
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  get(@Param('transactionId') transactionId: string) {
    return this.read.transaction(uuidParam(transactionId, 'transactionId'));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  getByProvider(@Param('providerId') providerId: string, @Param('externalTransactionId') externalTransactionId: string) {
    return this.read.transactionByProviderRef(providerId, externalTransactionId);
  }
}

/** Sem autenticação, por requisito. */
@Controller()
export class OperationsController {
  constructor(
    private readonly read: ReadModel,
    private readonly sqs: SQSClient,
    @Inject(QUEUES) private readonly queues: QueueUrls,
  ) {}

  /** Liveness: o processo responde. Não toca em dependências (senão um banco fora reinicia tudo). */
  @Get('health/live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: PostgreSQL e SQS alcançáveis. */
  @Get('health/ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const check = (probe: Promise<unknown>) => probe.then(() => 'up', () => 'down');
    const [postgres, sqs] = await Promise.all([check(this.read.ping()), check(queueDepth(this.sqs, this.queues.input))]);
    const ready = postgres === 'up' && sqs === 'up';
    res.status(ready ? 200 : 503);
    return { status: ready ? 'ok' : 'unavailable', checks: { postgres, sqs } };
  }

  @Get('metrics')
  @Header('Content-Type', registry.contentType)
  metrics() {
    return registry.metrics();
  }
}
