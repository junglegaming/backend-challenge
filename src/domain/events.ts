import { LedgerDirection, WalletLedgerEntry } from './ledger-entry';
import { MoneyProps } from './money';
import { WagerTransaction } from './wager-transaction';
import { Wallet } from './wallet';

/** Ids que acompanham todo evento. */
export interface EventContext {
  eventId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
}

/**
 * Base dos eventos de integração. Cada evento concreto define `eventType` e
 * `version`; `data` é JSON puro (MoneyProps, com amount em string, e nunca
 * uma instância de Money).
 */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;

  protected constructor(
    ctx: EventContext,
    readonly aggregateId: string,
    readonly data: Readonly<T>,
  ) {
    this.eventId = ctx.eventId;
    this.correlationId = ctx.correlationId;
    this.causationId = ctx.causationId;
    this.occurredAt = ctx.occurredAt;
  }

  /** Envelope gravado no payload da outbox. */
  toJSON() {
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

/** Dados comuns dos eventos de transação. */
export interface WagerTransactionData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  kind: string;
  status: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  failureCode?: string;
  balance?: MoneyProps;
}

function transactionData(tx: WagerTransaction): WagerTransactionData {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    kind: tx.kind,
    status: tx.status,
    money: tx.money.toJSON(),
    referenceExternalTransactionId: tx.referenceExternalTransactionId,
    failureCode: tx.failureCode,
    balance: tx.balanceAfter?.toJSON(),
  };
}

/** Qualquer transação aplicada, inclusive LOSS. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext) {
    return new WagerTransactionProcessed(ctx, tx.id, transactionData(tx));
  }
}

/** Transação rejeitada por regra de negócio. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext) {
    return new WagerTransactionRejected(ctx, tx.id, transactionData(tx));
  }
}

/** A referência ainda não chegou; a transação ficou esperando. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext) {
    return new WagerTransactionPendingReference(ctx, tx.id, transactionData(tx));
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

/** Somente quando o saldo muda. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext) {
    return new WalletBalanceChanged(ctx, wallet.id, {
      walletId: wallet.id,
      transactionId: entry.transactionId,
      direction: entry.direction,
      money: entry.money.toJSON(),
      balanceBefore: entry.balanceBefore.toJSON(),
      balanceAfter: entry.balanceAfter.toJSON(),
      walletVersion: entry.walletVersion,
    });
  }
}
