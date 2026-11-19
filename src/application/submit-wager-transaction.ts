import { z } from 'zod';
import { config } from '../config';
import { FailureCode, ValidationError } from '../domain/errors';
import { newId } from '../domain/id';
import { InboxMessage } from '../domain/messaging';
import { Money, MoneyProps } from '../domain/money';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import { logger } from '../observability/logger';
import { metrics } from '../observability/metrics';
import { IdempotencyConflictError, MessageIdConflictError, UniqueViolationError, WalletNotFoundError } from './errors';
import { payloadHash } from './payload-hash';
import { UnitOfWork } from './ports';
import { settle } from './settle';

// Sem caracteres de controle: o Postgres recusa \u0000 em `text`, o que viraria um falso erro transitório.
const text = z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/, 'control characters are not allowed');

/** Contrato de entrada, compartilhado por HTTP e SQS. OPENING é interno e não é aceito. */
const submissionSchema = z.strictObject({
  providerId: text,
  externalTransactionId: text,
  playerId: z.uuid(),
  walletId: z.uuid(),
  roundId: text,
  gameId: text,
  kind: z.enum(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']),
  money: z.strictObject({ amount: z.string(), currency: z.string() }),
  referenceExternalTransactionId: text.optional(),
});

export type Submission = z.infer<typeof submissionSchema>;

export interface SubmitCommand {
  idempotencyKey: string;
  /** Campos de negócio ainda não validados. */
  payload: unknown;
  correlationId: string;
  /** Presente quando a entrada é a fila: participa da mesma transação SQL (inbox). */
  inbox?: { messageId: string; payloadHash: string };
}

export interface SubmitResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

export type SubmitOutcome = SubmitResult | { duplicateMessage: true };

export class SubmitWagerTransaction {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(command: SubmitCommand): Promise<SubmitOutcome> {
    const stopTimer = metrics.processingSeconds.startTimer({ source: command.inbox ? 'sqs' : 'http' });
    try {
      if (typeof command.idempotencyKey !== 'string' || command.idempotencyKey.length < 1 || command.idempotencyKey.length > 255) {
        throw new ValidationError('Idempotency-Key is required (1 to 255 characters)');
      }
      const parsed = submissionSchema.safeParse(command.payload);
      if (!parsed.success) throw new ValidationError(z.prettifyError(parsed.error));
      const submission = parsed.data;
      const money = Money.from(submission.money);
      const hash = payloadHash(submission);

      try {
        return await this.attempt(command, submission, money, hash);
      } catch (error) {
        // Corrida entre duas requisições com a mesma key em wallets diferentes: o unique do banco
        // barrou a segunda. Na nova tentativa ela enxerga a primeira e vira replay ou conflito.
        if (!(error instanceof UniqueViolationError)) throw error;
        metrics.retries.inc({ source: 'idempotency_race' });
        return await this.attempt(command, submission, money, hash);
      }
    } finally {
      stopTimer();
    }
  }

  private async attempt(command: SubmitCommand, submission: Submission, money: Money, hash: string): Promise<SubmitOutcome> {
    // Métricas e logs são emitidos só depois do commit: uma transação desfeita não conta.
    const afterCommit: (() => void)[] = [];
    const outcome = await this.uow.run<SubmitOutcome>(async (store) => {
      const now = new Date();

      let inbox: InboxMessage | undefined;
      if (command.inbox) {
        inbox = InboxMessage.receive({ ...command.inbox, consumerName: config.consumerName, receivedAt: now });
        const received = await store.insertInbox(inbox);
        if (received === 'conflict') throw new MessageIdConflictError(`messageId ${inbox.messageId} was already used with different content`);
        if (received === 'duplicate') {
          afterCommit.push(() => metrics.duplicates.inc({ type: 'inbox_redelivery' }));
          return { duplicateMessage: true };
        }
      }

      // O lock da wallet vem ANTES da busca de idempotência: N requisições idênticas formam fila
      // aqui, a primeira grava, e as demais já encontram a transação ao passar.
      const wallet = await store.lockWallet(submission.walletId);
      if (!wallet || wallet.playerId !== submission.playerId) {
        throw new WalletNotFoundError(`wallet ${submission.walletId} not found for this player`);
      }

      const existing =
        (await store.findTransactionByKey(command.idempotencyKey)) ??
        (await store.findTransactionByProviderRef(submission.providerId, submission.externalTransactionId));
      if (existing) {
        if (existing.idempotencyKey !== command.idempotencyKey || !existing.matchesPayload(hash)) {
          metrics.duplicates.inc({ type: 'payload_conflict' });
          throw new IdempotencyConflictError('idempotency key or external transaction id already used with a different payload');
        }
        afterCommit.push(() => {
          metrics.duplicates.inc({ type: 'idempotent_replay' });
          logger.info(
            { correlationId: command.correlationId, messageId: command.inbox?.messageId, transactionId: existing.id, walletId: existing.walletId, providerId: existing.providerId },
            'idempotent replay',
          );
        });
        inbox?.markProcessed(now);
        if (inbox) await store.markInboxProcessed(inbox);
        return toResult(existing, wallet, true);
      }

      const tx = WagerTransaction.create({
        id: newId(),
        idempotencyKey: command.idempotencyKey,
        payloadHash: hash,
        providerId: submission.providerId,
        externalTransactionId: submission.externalTransactionId,
        walletId: submission.walletId,
        playerId: submission.playerId,
        roundId: submission.roundId,
        gameId: submission.gameId,
        kind: submission.kind as WagerTransactionKind,
        money,
        referenceExternalTransactionId: submission.referenceExternalTransactionId,
        createdAt: now,
      });
      const report = await settle(
        tx,
        wallet,
        store,
        now,
        { correlationId: command.correlationId, causationId: command.inbox?.messageId, messageId: command.inbox?.messageId },
        config.pendingReference.maxAttempts,
      );
      afterCommit.push(report);

      inbox?.markProcessed(now);
      if (inbox) await store.markInboxProcessed(inbox);
      return toResult(tx, wallet, false);
    });
    afterCommit.forEach((emit) => emit());
    return outcome;
  }
}

/** Replay devolve o saldo observado quando a transação foi resolvida, não o saldo de agora. */
const toResult = (tx: WagerTransaction, wallet: Wallet, idempotentReplay: boolean): SubmitResult => ({
  transactionId: tx.id,
  status: tx.status,
  balance: (tx.resultingBalance ?? wallet.balance).toJSON(),
  failureCode: tx.failureCode,
  idempotentReplay,
});
