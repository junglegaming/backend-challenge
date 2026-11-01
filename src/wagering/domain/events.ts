import {
  EventContext,
  IntegrationEvent,
  IntegrationEventProps,
} from "../../shared/domain/integration-event";
import { MoneyProps } from "../../shared/domain/money";
import { FailureCode } from "./failure-code";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "./wager-transaction";
import { Wallet } from "./wallet";
import { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry";

export interface TransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  money: MoneyProps;
  balance: MoneyProps | null;
  failureCode?: FailureCode;
  referenceTransactionId?: string;
}

function transactionProps(
  tx: WagerTransaction,
  ctx: EventContext,
): IntegrationEventProps<TransactionEventData> {
  return {
    ...ctx,
    aggregateId: tx.id,
    data: {
      transactionId: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      status: tx.status,
      money: tx.money.toJSON(),
      balance: tx.observedBalance?.toJSON() ?? null,
      ...(tx.failureCode === undefined ? {} : { failureCode: tx.failureCode }),
      ...(tx.referenceTransactionId === undefined
        ? {}
        : { referenceTransactionId: tx.referenceTransactionId }),
    },
  };
}

export class WagerTransactionProcessed extends IntegrationEvent<TransactionEventData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;
  private constructor(props: IntegrationEventProps<TransactionEventData>) {
    super(props);
  }
  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed(transactionProps(tx, ctx));
  }
}
export class WagerTransactionRejected extends IntegrationEvent<TransactionEventData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;
  private constructor(props: IntegrationEventProps<TransactionEventData>) {
    super(props);
  }
  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected(transactionProps(tx, ctx));
  }
}
export class WagerTransactionPendingReference extends IntegrationEvent<TransactionEventData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;
  private constructor(props: IntegrationEventProps<TransactionEventData>) {
    super(props);
  }
  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(transactionProps(tx, ctx));
  }
}
export class WagerTransactionFailed extends IntegrationEvent<TransactionEventData> {
  readonly eventType = "WagerTransactionFailed";
  readonly version = 1;
  private constructor(props: IntegrationEventProps<TransactionEventData>) {
    super(props);
  }
  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionFailed {
    return new WagerTransactionFailed(transactionProps(tx, ctx));
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
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;
  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
    super(props);
  }
  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      ...ctx,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      },
    });
  }
}
