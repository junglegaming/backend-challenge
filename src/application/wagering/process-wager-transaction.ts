import { Money, type MoneyProps } from '../../domain/shared/money';
import { FailureAdvice, FailureCode, failureAdvice } from '../../domain/wagering/failure-code';
import type { WagerTransactionKind } from '../../domain/wagering/wager-enums';
import { WagerTransactionStatus } from '../../domain/wagering/wager-enums';
import { WagerRulesService } from '../../domain/wagering/wager-rules.service';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { IdempotencyConflictError, InvalidRequestError, WalletNotFoundError } from '../errors';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../events/wagering-events';
import type { Clock, IdGenerator } from '../ports/clock-and-ids.port';
import type { StoredTransaction, UnitOfWork, WageringRepositories } from '../ports/wagering-repositories.port';
import { assertStorableMoney, assertUuid } from './validation';

export interface ProcessWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

export interface ProcessWagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  /** Wallet balance right after this transaction (PROCESSED only). */
  balance?: MoneyProps;
  failureCode?: FailureCode;
  advice?: FailureAdvice;
  idempotentReplay: boolean;
}

const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/**
 * One SQL transaction, in this order:
 *   1. INSERT ... ON CONFLICT DO NOTHING of the PENDING transaction (idempotency + provider/external uniqueness);
 *   2. conflict → replay the original result, or 409 when the payload differs;
 *   3. SELECT ... FOR UPDATE of the wallet (only that wallet is serialized);
 *   4. business rules (pure domain service);
 *   5. transaction outcome + balance + ledger + version + outbox, then COMMIT.
 * A business rejection is an outcome, not an exception: it is committed and audited.
 */
export class ProcessWagerTransaction {
  private readonly rules = new WagerRulesService();

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: ProcessWagerTransactionCommand): Promise<ProcessWagerTransactionResult> {
    const transaction = this.build(command);

    return this.unitOfWork.run(async (repositories) => {
      const { transactions, wallets } = repositories;

      if (!(await transactions.insertIfAbsent(transaction))) {
        return this.replay(repositories, transaction);
      }

      const wallet = await wallets.lockById(transaction.walletId);
      if (!wallet) throw new WalletNotFoundError(transaction.walletId);

      const reference = transaction.requiresReference() && transaction.referenceExternalTransactionId
        ? (await transactions.findByProviderAndExternalId(transaction.providerId, transaction.referenceExternalTransactionId))
            ?.transaction
        : undefined;
      const referenceAlreadyReversed = reference ? await transactions.isReversed(reference.id) : false;

      const now = this.clock.now();
      const versionBefore = wallet.version;
      const outcome = this.rules.process({
        transaction,
        wallet,
        reference,
        referenceAlreadyReversed,
        entryId: this.ids.next(),
        now,
      });
      const ctx = () => ({ eventId: this.ids.next(), occurredAt: now });

      switch (outcome.status) {
        case WagerTransactionStatus.Processed: {
          if (outcome.entry) {
            await repositories.ledger.append(outcome.entry);
            await wallets.saveBalance(wallet, versionBefore);
          }
          await transactions.saveOutcome(transaction, wallet.balance);
          await repositories.outbox.enqueue(WagerTransactionProcessed.from(transaction, wallet.balance.toJSON(), ctx()));
          if (outcome.entry) {
            await repositories.outbox.enqueue(WalletBalanceChanged.from(wallet, outcome.entry, ctx()));
          }
          return {
            transactionId: transaction.id,
            status: WagerTransactionStatus.Processed,
            balance: wallet.balance.toJSON(),
            idempotentReplay: false,
          };
        }
        case WagerTransactionStatus.Rejected: {
          const advice = failureAdvice(outcome.failureCode);
          await transactions.saveOutcome(transaction, undefined);
          await repositories.outbox.enqueue(WagerTransactionRejected.from(transaction, advice, ctx()));
          return {
            transactionId: transaction.id,
            status: WagerTransactionStatus.Rejected,
            failureCode: outcome.failureCode,
            advice,
            idempotentReplay: false,
          };
        }
        case WagerTransactionStatus.PendingReference: {
          await transactions.saveOutcome(transaction, undefined);
          await repositories.outbox.enqueue(WagerTransactionPendingReference.from(transaction, ctx()));
          return {
            transactionId: transaction.id,
            status: WagerTransactionStatus.PendingReference,
            idempotentReplay: false,
          };
        }
      }
    });
  }

  private build(command: ProcessWagerTransactionCommand): WagerTransaction {
    const key = command.idempotencyKey;
    if (typeof key !== 'string' || key.trim() === '') {
      throw new InvalidRequestError('Idempotency-Key header is required');
    }
    if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw new InvalidRequestError(`Idempotency-Key must have at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`);
    }
    assertUuid('playerId', command.playerId);
    assertUuid('walletId', command.walletId);
    const money = Money.from(command.money);
    assertStorableMoney('money.amount', money);

    return WagerTransaction.create({
      id: this.ids.next(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: key,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: this.clock.now(),
    });
  }

  /** The insert was a no-op: the key (or the provider transaction) already exists. */
  private async replay(
    { transactions }: WageringRepositories,
    incoming: WagerTransaction,
  ): Promise<ProcessWagerTransactionResult> {
    const existing = await transactions.findByIdempotencyKey(incoming.idempotencyKey);
    if (existing) {
      if (!existing.transaction.matchesPayload(incoming.payloadHash)) {
        throw new IdempotencyConflictError(
          `Idempotency-Key ${incoming.idempotencyKey} was already used with a different payload`,
        );
      }
      return this.toResult(existing);
    }
    const sameProviderTransaction = await transactions.findByProviderAndExternalId(
      incoming.providerId,
      incoming.externalTransactionId,
    );
    if (sameProviderTransaction) {
      throw new IdempotencyConflictError(
        `${incoming.providerId}/${incoming.externalTransactionId} was already submitted with another Idempotency-Key`,
      );
    }
    // Nothing conflicted, so the wallet is what made the guarded insert a no-op.
    throw new WalletNotFoundError(incoming.walletId);
  }

  private toResult({ transaction, balanceSnapshot }: StoredTransaction): ProcessWagerTransactionResult {
    const base = { transactionId: transaction.id, status: transaction.status, idempotentReplay: true };
    const failureCode = transaction.failureCode;
    return {
      ...base,
      ...(balanceSnapshot ? { balance: balanceSnapshot.toJSON() } : {}),
      ...(failureCode ? { failureCode, advice: failureAdvice(failureCode) } : {}),
    };
  }
}
