import type { FailureCode } from '../failure-code';
import type { MoneyProps } from '../money';
import type { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../wager-transaction';
import type { Wallet } from '../wallet';
import type { LedgerDirection, WalletLedgerEntry } from '../wallet-ledger-entry';
import { type EventContext, IntegrationEvent, type IntegrationEventProps } from './integration-event';

/** Common identification of a wager transaction inside event payloads. */
interface TransactionRef {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

const transactionRef = (tx: WagerTransaction): TransactionRef => ({
  transactionId: tx.id,
  providerId: tx.providerId,
  externalTransactionId: tx.externalTransactionId,
  walletId: tx.walletId,
  playerId: tx.playerId,
  roundId: tx.roundId,
  gameId: tx.gameId,
  kind: tx.kind,
  money: tx.money.toJSON(),
  ...(tx.referenceExternalTransactionId ? { referenceExternalTransactionId: tx.referenceExternalTransactionId } : {}),
});

// ---------------------------------------------------------------------------

export interface WagerTransactionProcessedData extends TransactionRef {
  status: WagerTransactionStatus.Processed;
  referenceTransactionId?: string;
  balance: MoneyProps;
  processedAt: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) {
    super(props);
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed(
      IntegrationEvent.props(tx.id, ctx, {
        ...transactionRef(tx),
        status: tx.status as WagerTransactionStatus.Processed,
        ...(tx.referenceTransactionId ? { referenceTransactionId: tx.referenceTransactionId } : {}),
        balance: tx.resultBalance!.toJSON(),
        processedAt: tx.processedAt!.toISOString(),
      }),
    );
  }
}

// ---------------------------------------------------------------------------

export interface WagerTransactionRejectedData extends TransactionRef {
  status: WagerTransactionStatus.Rejected;
  failureCode: FailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) {
    super(props);
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected(
      IntegrationEvent.props(tx.id, ctx, {
        ...transactionRef(tx),
        status: tx.status as WagerTransactionStatus.Rejected,
        failureCode: tx.failureCode!,
      }),
    );
  }
}

// ---------------------------------------------------------------------------

export interface WagerTransactionPendingReferenceData extends TransactionRef {
  status: WagerTransactionStatus.PendingReference;
  referenceExternalTransactionId: string;
  nextCheckAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionPendingReferenceData>) {
    super(props);
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(
      IntegrationEvent.props(tx.id, ctx, {
        ...transactionRef(tx),
        status: tx.status as WagerTransactionStatus.PendingReference,
        referenceExternalTransactionId: tx.referenceExternalTransactionId!,
        nextCheckAt: tx.nextReferenceCheckAt!.toISOString(),
      }),
    );
  }
}

// ---------------------------------------------------------------------------

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

  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
    super(props);
  }

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged(
      IntegrationEvent.props(wallet.id, ctx, {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      }),
    );
  }
}
