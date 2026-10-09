import type { MoneyProps } from "../../../../shared/domain/money";
import { type EventContext, IntegrationEvent } from "../../../messaging/domain/integration-event";
import type { LedgerDirection } from "../../../wallet/domain/ledger-direction";
import type { Wallet } from "../../../wallet/domain/wallet";
import type { WalletLedgerEntry } from "../../../wallet/domain/wallet-ledger-entry";
import type { FailureCode } from "../failure-code";
import type { SubmissionChannel, SubmissionFailure, SubmissionFailureCategory } from "../submission-failure";
import type { WagerTransaction } from "../wager-transaction";

/*
 * Every event uses the walletId as aggregateId: the wallet is the consistency boundary, and using it
 * as the SQS MessageGroupId keeps each wallet's event stream ordered for consumers.
 */

interface WagerTransactionRef {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

function transactionRef(tx: WagerTransaction): WagerTransactionRef {
  const ref: WagerTransactionRef = {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
  };
  if (tx.referenceExternalTransactionId)
    ref.referenceExternalTransactionId = tx.referenceExternalTransactionId;
  return ref;
}

function requireDefined<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} is required to build the event`);
  return value;
}

export interface WagerTransactionProcessedData extends WagerTransactionRef {
  status: "PROCESSED";
  referenceTransactionId?: string;
  balance: MoneyProps;
  processedAt: string;
}

/** Any applied transaction, including LOSS (which does not move balance). */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    const data: WagerTransactionProcessedData = {
      ...transactionRef(tx),
      status: "PROCESSED",
      balance: requireDefined(tx.resultBalance, "resultBalance").toJSON(),
      processedAt: requireDefined(tx.processedAt, "processedAt").toISOString(),
    };
    if (tx.referenceTransactionId) data.referenceTransactionId = tx.referenceTransactionId;
    return new WagerTransactionProcessed({ ...ctx, aggregateId: tx.walletId, data });
  }
}

export interface WagerTransactionRejectedData extends WagerTransactionRef {
  status: "REJECTED";
  failureCode: FailureCode;
  balance: MoneyProps;
  rejectedAt: string;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: tx.walletId,
      data: {
        ...transactionRef(tx),
        status: "REJECTED",
        failureCode: requireDefined(tx.failureCode, "failureCode"),
        balance: requireDefined(tx.resultBalance, "resultBalance").toJSON(),
        rejectedAt: requireDefined(tx.processedAt, "processedAt").toISOString(),
      },
    });
  }
}

export interface WagerTransactionPendingReferenceData extends WagerTransactionRef {
  status: "PENDING_REFERENCE";
  nextRetryAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: tx.walletId,
      data: {
        ...transactionRef(tx),
        status: "PENDING_REFERENCE",
        nextRetryAt: requireDefined(tx.nextReferenceRetryAt, "nextReferenceRetryAt").toISOString(),
      },
    });
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

/** Emitted only when the balance actually changes (never for LOSS or REJECTED). */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    if (entry.walletId !== wallet.id) throw new Error("ledger entry does not belong to wallet");
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

export interface WagerTransactionFailedData extends WagerTransactionRef {
  status: "FAILED";
  failureCode: FailureCode;
  failedAt: string;
}

/** A transaction that hit a permanent infrastructure failure (kept FAILED for audit; no balance effect). */
export class WagerTransactionFailed extends IntegrationEvent<WagerTransactionFailedData> {
  readonly eventType = "WagerTransactionFailed";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionFailed {
    return new WagerTransactionFailed({
      ...ctx,
      aggregateId: tx.walletId,
      data: {
        ...transactionRef(tx),
        status: "FAILED",
        failureCode: requireDefined(tx.failureCode, "failureCode"),
        failedAt: requireDefined(tx.processedAt, "processedAt").toISOString(),
      },
    });
  }
}

export interface WagerSubmissionFailedData {
  failureId: string;
  channel: SubmissionChannel;
  reasonCode: string;
  category: SubmissionFailureCategory;
  retryable: boolean;
  providerId?: string;
  externalTransactionId?: string;
  idempotencyKey?: string;
  walletId?: string;
  messageId?: string;
  transactionId?: string;
}

/**
 * A submission that did not become a business outcome (see SubmissionFailure). Lets asynchronous (SQS) providers
 * learn about rejections they never get a response for. aggregateId = walletId when known, else the failure id.
 */
export class WagerSubmissionFailed extends IntegrationEvent<WagerSubmissionFailedData> {
  readonly eventType = "WagerSubmissionFailed";
  readonly version = 1;

  static from(failure: SubmissionFailure, ctx: EventContext): WagerSubmissionFailed {
    const data: WagerSubmissionFailedData = {
      failureId: failure.id,
      channel: failure.channel,
      reasonCode: failure.reasonCode,
      category: failure.category,
      retryable: failure.retryable,
    };
    const optional = {
      providerId: failure.providerId,
      externalTransactionId: failure.externalTransactionId,
      idempotencyKey: failure.idempotencyKey,
      walletId: failure.walletId,
      messageId: failure.messageId,
      transactionId: failure.transactionId,
    };
    for (const [k, v] of Object.entries(optional))
      if (v !== undefined) (data as unknown as Record<string, string>)[k] = v;
    return new WagerSubmissionFailed({ ...ctx, aggregateId: failure.walletId ?? failure.id, data });
  }
}
