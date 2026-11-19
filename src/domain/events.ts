import { FailureCode } from './errors';
import { newId } from './id';
import { LedgerDirection, WalletLedgerEntry } from './ledger-entry';
import { MoneyProps } from './money';
import { WagerTransaction } from './wager-transaction';
import { Wallet } from './wallet';

export interface EventContext {
  correlationId: string;
  causationId?: string;
}

export interface IntegrationEventProps<T> extends EventContext {
  eventId: string;
  aggregateId: string;
  occurredAt: Date;
  data: T;
}

export interface IntegrationEventEnvelope<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string; // ISO-8601
  version: number;
  data: T;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = Object.freeze(props.data);
  }

  /** Envelope serializado gravado no payload da outbox. */
  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      causationId: this.causationId,
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
  }
}

// aggregateId é sempre a wallet: é a unidade de concorrência e o MessageGroupId na fila de eventos.
const envelope = <T>(tx: WagerTransaction, at: Date, ctx: EventContext, data: T): IntegrationEventProps<T> => ({
  eventId: newId(),
  aggregateId: tx.walletId,
  correlationId: ctx.correlationId,
  causationId: ctx.causationId,
  occurredAt: at,
  data,
});

interface TransactionData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
}

const transactionData = (tx: WagerTransaction): TransactionData => ({
  transactionId: tx.id,
  providerId: tx.providerId,
  externalTransactionId: tx.externalTransactionId,
  walletId: tx.walletId,
  playerId: tx.playerId,
  roundId: tx.roundId,
  gameId: tx.gameId,
  kind: tx.kind,
  money: tx.money.toJSON(),
});

export interface WagerTransactionProcessedData extends TransactionData {
  referenceTransactionId?: string;
  balance: MoneyProps;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, wallet: Wallet, at: Date, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed(
      envelope(tx, at, ctx, { ...transactionData(tx), referenceTransactionId: tx.referenceTransactionId, balance: wallet.balance.toJSON() }),
    );
  }
}

export interface WagerTransactionRejectedData extends TransactionData {
  failureCode: FailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, at: Date, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected(envelope(tx, at, ctx, { ...transactionData(tx), failureCode: tx.failureCode! }));
  }
}

export interface WagerTransactionPendingReferenceData extends TransactionData {
  referenceExternalTransactionId: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, at: Date, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(
      envelope(tx, at, ctx, { ...transactionData(tx), referenceExternalTransactionId: tx.referenceExternalTransactionId! }),
    );
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
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
      eventId: newId(),
      aggregateId: wallet.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: entry.createdAt,
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
