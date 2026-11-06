import type { MoneyProps } from '../../domain/shared/money';
import type { FailureAdvice } from '../../domain/wagering/failure-code';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import type { Wallet } from '../../domain/wallet/wallet';
import { IntegrationEvent } from './integration-event';

export interface EventContext {
  eventId: string;
  occurredAt: Date;
}

interface TransactionData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  kind: string;
  money: MoneyProps;
}

const transactionData = (tx: WagerTransaction): TransactionData => ({
  transactionId: tx.id,
  providerId: tx.providerId,
  externalTransactionId: tx.externalTransactionId,
  idempotencyKey: tx.idempotencyKey,
  walletId: tx.walletId,
  playerId: tx.playerId,
  kind: tx.kind,
  money: tx.money.toJSON(),
});

const base = (tx: WagerTransaction, ctx: EventContext) => ({
  eventId: ctx.eventId,
  aggregateId: tx.walletId,
  correlationId: tx.id,
  occurredAt: ctx.occurredAt,
});

export interface WagerTransactionProcessedData extends TransactionData {
  referenceTransactionId: string | null;
  balance: MoneyProps;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, balance: MoneyProps, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      ...base(tx, ctx),
      data: { ...transactionData(tx), referenceTransactionId: tx.referenceTransactionId ?? null, balance },
    });
  }
}

export interface WagerTransactionRejectedData extends TransactionData {
  failureCode: string;
  advice: FailureAdvice;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, advice: FailureAdvice, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected({
      ...base(tx, ctx),
      data: { ...transactionData(tx), failureCode: tx.failureCode as string, advice },
    });
  }
}

export interface WagerTransactionPendingReferenceData extends TransactionData {
  referenceExternalTransactionId: string | null;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      ...base(tx, ctx),
      data: { ...transactionData(tx), referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null },
    });
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      eventId: ctx.eventId,
      aggregateId: wallet.id,
      correlationId: entry.transactionId,
      occurredAt: ctx.occurredAt,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
