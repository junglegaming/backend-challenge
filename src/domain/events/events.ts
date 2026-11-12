import type { MoneyProps } from "../money/money";
import type { FailureCode } from "../shared/failure-code";
import type { WagerTransaction, WagerTransactionKind } from "../wagering/wager-transaction";
import type { Wallet } from "../wallet/wallet";
import type { LedgerDirection, WalletLedgerEntry } from "../wallet/wallet-ledger-entry";
import { type EventContext, IntegrationEvent } from "./integration-event";

/** Fields shared by every wager transaction event. */
interface WagerTransactionEventData {
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

function wagerData(tx: WagerTransaction): WagerTransactionEventData {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    ...(tx.referenceExternalTransactionId
      ? { referenceExternalTransactionId: tx.referenceExternalTransactionId }
      : {}),
  };
}

// ---------------------------------------------------------------------------

export interface WagerTransactionProcessedData extends WagerTransactionEventData {
  referenceTransactionId?: string;
  balanceAfter: MoneyProps;
  processedAt: string;
}

/** Any transaction applied, including LOSS (which does not move money). */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  static from(tx: WagerTransaction, wallet: Wallet, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed(
      IntegrationEvent.baseProps(tx.id, ctx, {
        ...wagerData(tx),
        ...(tx.referenceTransactionId ? { referenceTransactionId: tx.referenceTransactionId } : {}),
        balanceAfter: wallet.balance.toJSON(),
        processedAt: ctx.occurredAt.toISOString(),
      }),
    );
  }
}

// ---------------------------------------------------------------------------

export interface WagerTransactionRejectedData extends WagerTransactionEventData {
  failureCode: FailureCode;
}

/** Transaction rejected by a business rule. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  static from(tx: WagerTransaction, failureCode: FailureCode, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected(
      IntegrationEvent.baseProps(tx.id, ctx, { ...wagerData(tx), failureCode }),
    );
  }
}

// ---------------------------------------------------------------------------

export interface WagerTransactionPendingReferenceData extends WagerTransactionEventData {
  referenceExternalTransactionId: string;
}

/** Transaction parked because its reference has not arrived yet. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(
      IntegrationEvent.baseProps(tx.id, ctx, {
        ...wagerData(tx),
        referenceExternalTransactionId: tx.referenceExternalTransactionId ?? "",
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

/** Emitted only when the balance actually changes (one per ledger entry). */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged(
      IntegrationEvent.baseProps(wallet.id, ctx, {
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

