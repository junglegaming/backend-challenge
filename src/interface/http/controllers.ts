import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { ValidationError } from '../../application/errors';
import { LogContext } from '../../application/log-context';
import { OpenWallet } from '../../application/open-wallet';
import { WageringQueries } from '../../application/queries';
import { ReconcileWallet } from '../../application/reconcile-wallet';
import { SubmitWagerTransaction, type WagerOutcome } from '../../application/submit-wager-transaction';
import { WagerTransactionStatus } from '../../domain/wager-transaction';
import {
  idempotencyKeySchema,
  openWalletBodySchema,
  parseOrThrow,
  providerIdSchema,
  toSubmitCommand,
  wagerTransactionBodySchema,
} from '../contracts';
import { assertActsFor, type AuthenticatedRequest } from './auth';

const uuid = z.string().uuid();
const limitSchema = z.coerce.number().int().min(1).max(200).default(50);

const parseUuid = (value: string, field: string): string => {
  if (!uuid.safeParse(value).success) throw new ValidationError(`${field} must be a UUID`, { field });
  return value;
};

/**
 * Submission outcome -> HTTP status. Identical on replays, so a provider sees
 * the same answer for the same request:
 *   PROCESSED 200 | PENDING_REFERENCE 202 | REJECTED 422 | FAILED 500
 */
const OUTCOME_STATUS: Record<WagerTransactionStatus, number> = {
  [WagerTransactionStatus.Processed]: 200,
  [WagerTransactionStatus.PendingReference]: 202,
  [WagerTransactionStatus.Pending]: 202,
  [WagerTransactionStatus.Rejected]: 422,
  [WagerTransactionStatus.Failed]: 500,
};

const correlationId = (): string => LogContext.current().correlationId ?? 'unknown';

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly openWallet: OpenWallet,
    private readonly queries: WageringQueries,
    private readonly reconcile: ReconcileWallet,
  ) {}

  @Post()
  @HttpCode(201)
  create(@Body() body: unknown) {
    return this.openWallet.execute(parseOrThrow(openWalletBodySchema, body), correlationId());
  }

  @Get(':walletId')
  get(@Param('walletId') walletId: string) {
    return this.queries.wallet(parseUuid(walletId, 'walletId'));
  }

  @Get(':walletId/ledger')
  ledger(@Param('walletId') walletId: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    const parsedLimit = limitSchema.safeParse(limit);
    if (!parsedLimit.success) throw new ValidationError('limit must be an integer between 1 and 200', { field: 'limit' });
    return this.queries.ledger(parseUuid(walletId, 'walletId'), cursor || undefined, parsedLimit.data);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconciliation(@Param('walletId') walletId: string) {
    return this.reconcile.execute(parseUuid(walletId, 'walletId'));
  }
}

@Controller()
export class WageringController {
  constructor(
    private readonly submit: SubmitWagerTransaction,
    private readonly queries: WageringQueries,
  ) {}

  @Post('wagering/transactions')
  async create(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<WagerOutcome> {
    const key = parseOrThrow(idempotencyKeySchema, idempotencyKey);
    const payload = parseOrThrow(wagerTransactionBodySchema, body);
    assertActsFor(request.identity, payload.providerId);

    const result = await this.submit.execute(toSubmitCommand(payload, key), { source: 'http', correlationId: correlationId() });
    if (result.type !== 'outcome') throw new Error('HTTP submissions never go through the inbox');
    response.status(OUTCOME_STATUS[result.outcome.status]);
    return result.outcome;
  }

  @Get('wagering/transactions/:transactionId')
  get(@Param('transactionId') transactionId: string) {
    return this.queries.transaction(parseUuid(transactionId, 'transactionId'));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  getByExternalId(@Param('providerId') providerId: string, @Param('externalTransactionId') externalTransactionId: string) {
    return this.queries.transactionByExternalId(parseOrThrow(providerIdSchema, providerId), externalTransactionId);
  }
}
