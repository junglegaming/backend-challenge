import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '../domain/errors';
import type { FailureCode } from '../domain/failure-code';
import { InboxMessage } from '../domain/inbox-message';
import { Money, type MoneyProps } from '../domain/money';
import { type TransactionScope, UNIT_OF_WORK, type UnitOfWork } from '../domain/ports/repositories';
import { CLOCK, type Clock, ID_GENERATOR, type IdGenerator } from '../domain/ports/system';
import { type ExternalKind, WagerTransaction, WagerTransactionStatus } from '../domain/wager-transaction';
import { ConflictError, NotFoundError, UniqueViolationError, ValidationError } from './errors';
import { LogContext } from './log-context';
import { type Source, STRUCTURED_LOGGER, type StructuredLogger, WAGERING_METRICS, type WageringMetrics } from './ports';
import { sha256Canonical } from './payload-hash';
import { WagerProcessor } from './wager-processor';
import { WALLET_ADMISSION, type WalletAdmission } from './wallet-admission';

export interface SubmitWagerCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: ExternalKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export interface SubmitContext {
  source: Exclude<Source, 'worker'>;
  correlationId: string;
  /** set when the command arrived through a queue: de-duplicated by the persistent inbox */
  inbox?: { consumerName: string; messageId: string };
}

export interface WagerOutcome {
  transactionId: string;
  status: WagerTransactionStatus;
  failureCode?: FailureCode;
  /** balance observed when the outcome was decided (stable across replays) */
  balance: MoneyProps;
  idempotentReplay: boolean;
}

export type SubmitResult = { type: 'outcome'; outcome: WagerOutcome } | { type: 'duplicate-message' };

/** Fields that define "the same request". Transport metadata (header, messageId) never enters the hash. */
export const wagerPayloadHash = (cmd: SubmitWagerCommand, money: Money): string =>
  sha256Canonical({
    providerId: cmd.providerId,
    externalTransactionId: cmd.externalTransactionId,
    playerId: cmd.playerId,
    walletId: cmd.walletId,
    roundId: cmd.roundId,
    gameId: cmd.gameId,
    kind: cmd.kind,
    money: money.toJSON(),
    referenceExternalTransactionId: cmd.referenceExternalTransactionId,
  });

export const toOutcome = (tx: WagerTransaction, idempotentReplay: boolean): WagerOutcome => ({
  transactionId: tx.id,
  status: tx.status,
  ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
  balance: (tx.resultBalance ?? Money.zero(tx.money.currency)).toJSON(),
  idempotentReplay,
});

const MAX_UNIQUE_RACE_RETRIES = 3;

/**
 * Single entry point for provider transactions — HTTP and SQS both call it.
 *
 * Everything happens in one SQL transaction: inbox row (queue only), wallet
 * row lock, transaction row, wallet update, ledger entry and outbox events.
 */
@Injectable()
export class SubmitWagerTransaction {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(WAGERING_METRICS) private readonly metrics: WageringMetrics,
    @Inject(STRUCTURED_LOGGER) private readonly logger: StructuredLogger,
    @Inject(WALLET_ADMISSION) private readonly admission: WalletAdmission,
    private readonly processor: WagerProcessor,
  ) {}

  async execute(cmd: SubmitWagerCommand, ctx: SubmitContext): Promise<SubmitResult> {
    const started = performance.now();
    LogContext.assign({ providerId: cmd.providerId, walletId: cmd.walletId });
    const money = this.parseMoney(cmd.money);
    const payloadHash = wagerPayloadHash(cmd, money);
    // Wait our turn for this wallet in memory, without holding a DB connection.
    const result = await this.admission.run(cmd.walletId, () => this.executeWithRaceRetry(cmd, money, payloadHash, ctx));
    this.record(result, cmd, ctx, started);
    return result;
  }

  private async executeWithRaceRetry(cmd: SubmitWagerCommand, money: Money, payloadHash: string, ctx: SubmitContext): Promise<SubmitResult> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.uow.run((scope) => this.attempt(scope, cmd, money, payloadHash, ctx), { name: 'submit-wager' });
      } catch (error) {
        // Two writers raced on a unique key (e.g. same idempotency key on different
        // wallets). Re-running sees the committed winner and becomes a replay/conflict.
        if (error instanceof UniqueViolationError && attempt < MAX_UNIQUE_RACE_RETRIES) {
          this.metrics.lockConflict('unique-race');
          this.metrics.retry('unit-of-work', 'unique-race');
          continue;
        }
        throw error;
      }
    }
  }

  private async attempt(
    scope: TransactionScope,
    cmd: SubmitWagerCommand,
    money: Money,
    payloadHash: string,
    ctx: SubmitContext,
  ): Promise<SubmitResult> {
    const now = this.clock.now();

    if (ctx.inbox) {
      const message = InboxMessage.receive({ ...ctx.inbox, payloadHash, receivedAt: now });
      message.markProcessed(now);
      if (!(await scope.inbox.tryReceive(message))) {
        const previous = await scope.inbox.find(ctx.inbox.consumerName, ctx.inbox.messageId);
        if (previous && previous.payloadHash !== payloadHash) {
          throw new ConflictError('INBOX_MESSAGE_CONFLICT', 'messageId was already used with a different payload');
        }
        return { type: 'duplicate-message' };
      }
    }

    // Fast path: replays never need the wallet lock.
    const replay = await this.findReplay(scope, cmd.idempotencyKey, payloadHash);
    if (replay) return replay;

    const wallet = await scope.wallets.findByIdForUpdate(cmd.walletId);
    if (!wallet) {
      throw new NotFoundError('WALLET_NOT_FOUND', `Wallet ${cmd.walletId} not found`);
    }

    // Re-check under the lock: a concurrent writer of this wallet may have just committed it.
    const lateReplay = await this.findReplay(scope, cmd.idempotencyKey, payloadHash);
    if (lateReplay) return lateReplay;

    const sameExternalId = await scope.transactions.findByExternalId(cmd.providerId, cmd.externalTransactionId);
    if (sameExternalId) {
      throw new ConflictError(
        'EXTERNAL_TRANSACTION_CONFLICT',
        'externalTransactionId was already submitted with a different Idempotency-Key',
        { transactionId: sameExternalId.id },
      );
    }

    const tx = this.createTransaction(cmd, money, payloadHash, now);
    LogContext.assign({ transactionId: tx.id });
    await this.processor.process(scope, wallet, tx, {
      correlationId: ctx.correlationId,
      causationId: ctx.inbox?.messageId ?? cmd.idempotencyKey,
    });
    return { type: 'outcome', outcome: toOutcome(tx, false) };
  }

  private async findReplay(scope: TransactionScope, key: string, payloadHash: string): Promise<SubmitResult | undefined> {
    const existing = await scope.transactions.findByIdempotencyKey(key);
    if (!existing) return undefined;
    if (!existing.matchesPayload(payloadHash)) {
      throw new ConflictError('IDEMPOTENCY_KEY_CONFLICT', 'Idempotency-Key was already used with a different payload', {
        transactionId: existing.id,
      });
    }
    LogContext.assign({ transactionId: existing.id });
    return { type: 'outcome', outcome: toOutcome(existing, true) };
  }

  private createTransaction(cmd: SubmitWagerCommand, money: Money, payloadHash: string, now: Date): WagerTransaction {
    try {
      return WagerTransaction.create({
        id: this.ids.next(),
        providerId: cmd.providerId,
        externalTransactionId: cmd.externalTransactionId,
        idempotencyKey: cmd.idempotencyKey,
        payloadHash,
        walletId: cmd.walletId,
        playerId: cmd.playerId,
        roundId: cmd.roundId,
        gameId: cmd.gameId,
        kind: cmd.kind,
        money,
        referenceExternalTransactionId: cmd.referenceExternalTransactionId,
        createdAt: now,
      });
    } catch (error) {
      if (error instanceof DomainError) throw new ValidationError(error.message);
      throw error;
    }
  }

  private parseMoney(props: MoneyProps): Money {
    try {
      return Money.from(props);
    } catch (error) {
      if (error instanceof DomainError) throw new ValidationError(error.message, { field: 'money' });
      throw error;
    }
  }

  private record(result: SubmitResult, cmd: SubmitWagerCommand, ctx: SubmitContext, started: number): void {
    this.metrics.processingDuration(ctx.source, (performance.now() - started) / 1000);
    if (result.type === 'duplicate-message') {
      this.metrics.duplicateDetected('inbox');
      this.logger.info('duplicate message ignored');
      return;
    }
    const { outcome } = result;
    if (outcome.idempotentReplay) {
      this.metrics.duplicateDetected('idempotency-replay');
      this.logger.info('idempotent replay', { status: outcome.status });
      return;
    }
    this.metrics.transactionOutcome(outcome.status, cmd.kind, ctx.source, outcome.failureCode);
    this.logger.info('wager transaction settled', {
      kind: cmd.kind,
      status: outcome.status,
      failureCode: outcome.failureCode,
    });
  }
}
