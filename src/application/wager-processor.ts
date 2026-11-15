import { Inject, Injectable } from '@nestjs/common';
import type { EventContext, IntegrationEvent } from '../domain/events/integration-event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../domain/events/wagering-events';
import { FailureCode } from '../domain/failure-code';
import { backoffDelayMs, OutboxMessage } from '../domain/outbox-message';
import type { TransactionScope } from '../domain/ports/repositories';
import { CLOCK, type Clock, ID_GENERATOR, type IdGenerator } from '../domain/ports/system';
import { type SettlementDecision, WagerSettlement } from '../domain/wager-settlement';
import { type WagerTransaction, WagerTransactionStatus } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import { PENDING_REFERENCE_POLICY, type PendingReferencePolicy } from './ports';

export interface ProcessingContext {
  correlationId: string;
  causationId?: string;
}

/**
 * Applies a transaction to its (already row-locked) wallet and records every
 * side effect — transaction row, wallet row, ledger entry, outbox events —
 * through the given TransactionScope, i.e. inside the caller's SQL
 * transaction. Shared by the HTTP/SQS submission and the pending-reference
 * worker so both paths obey exactly the same rules.
 */
@Injectable()
export class WagerProcessor {
  private readonly settlement = new WagerSettlement();

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(PENDING_REFERENCE_POLICY) private readonly policy: PendingReferencePolicy,
  ) {}

  async process(scope: TransactionScope, wallet: Wallet, tx: WagerTransaction, ctx: ProcessingContext): Promise<SettlementDecision> {
    const now = this.clock.now();
    const enteringPending = tx.status === WagerTransactionStatus.Pending;

    const reference = tx.referenceExternalTransactionId
      ? await scope.transactions.findByExternalId(tx.providerId, tx.referenceExternalTransactionId)
      : undefined;
    const referenceAlreadyReversed =
      reference !== undefined && tx.isReversal() && reference.status === WagerTransactionStatus.Processed
        ? await scope.transactions.isReversed(reference.id)
        : false;

    let decision = this.settlement.settle({
      wallet,
      transaction: tx,
      reference,
      referenceAlreadyReversed,
      ledgerEntryId: this.ids.next(),
      now,
    });

    if (decision.type === 'awaiting-reference') {
      decision = this.park(tx, wallet, now);
    }

    // Order matters for FK checks: transaction row first, then wallet + ledger.
    await scope.transactions.save(tx);
    if (decision.type === 'processed' && decision.entry) {
      await scope.wallets.save(wallet);
    }
    if (tx.isTerminal()) {
      await scope.transactions.wakeDependents(tx.providerId, tx.externalTransactionId);
    }

    const events = this.eventsFor(decision, tx, wallet, enteringPending, {
      newId: () => this.ids.next(),
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: now,
    });
    if (events.length > 0) {
      await scope.outbox.add(events.map((event) => OutboxMessage.enqueue(event)));
    }
    return decision;
  }

  /** Retry with exponential backoff, or give up once the budget is spent. */
  private park(tx: WagerTransaction, wallet: Wallet, now: Date): SettlementDecision {
    const isRetry = tx.status === WagerTransactionStatus.PendingReference;
    if (isRetry && tx.referenceAttempts + 1 >= this.policy.maxAttempts) {
      tx.reject(FailureCode.ReferenceNotFound, now, wallet.balance);
      return { type: 'rejected', failureCode: FailureCode.ReferenceNotFound };
    }
    const attempt = isRetry ? tx.referenceAttempts + 1 : 0;
    const delay = backoffDelayMs(attempt + 1, this.policy);
    tx.markPendingReference(new Date(now.getTime() + delay), now, wallet.balance);
    return { type: 'awaiting-reference' };
  }

  private eventsFor(
    decision: SettlementDecision,
    tx: WagerTransaction,
    wallet: Wallet,
    enteringPending: boolean,
    ctx: EventContext,
  ): IntegrationEvent<unknown>[] {
    switch (decision.type) {
      case 'processed':
        return decision.entry
          ? [WagerTransactionProcessed.from(tx, ctx), WalletBalanceChanged.from(wallet, decision.entry, ctx)]
          : [WagerTransactionProcessed.from(tx, ctx)];
      case 'rejected':
        return [WagerTransactionRejected.from(tx, ctx)];
      case 'awaiting-reference':
        // Published once, when the transaction is first parked — not on every retry.
        return enteringPending ? [WagerTransactionPendingReference.from(tx, ctx)] : [];
    }
  }
}
