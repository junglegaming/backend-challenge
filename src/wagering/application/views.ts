import { MoneyProps } from "../../shared/domain/money";
import { FailureCode } from "../domain/failure-code";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wager-transaction";
import { Wallet } from "../domain/wallet";
import { WalletLedgerEntry } from "../domain/wallet-ledger-entry";

export interface TransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  status: `${Exclude<WagerTransactionStatus, WagerTransactionStatus.Pending>}`;
  balance: MoneyProps | null;
  failureCode?: FailureCode;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  createdAt: string;
  processedAt?: string;
}

export function transactionView(transaction: WagerTransaction): TransactionView {
  if (transaction.status === WagerTransactionStatus.Pending)
    throw new Error("PENDING cannot be returned or persisted");
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    status: transaction.status,
    balance: transaction.observedBalance?.toJSON() ?? null,
    ...(transaction.failureCode === undefined ? {} : { failureCode: transaction.failureCode }),
    ...(transaction.referenceExternalTransactionId === undefined
      ? {}
      : { referenceExternalTransactionId: transaction.referenceExternalTransactionId }),
    ...(transaction.referenceTransactionId === undefined
      ? {}
      : { referenceTransactionId: transaction.referenceTransactionId }),
    createdAt: transaction.createdAt.toISOString(),
    ...(transaction.processedAt ? { processedAt: transaction.processedAt.toISOString() } : {}),
  };
}
export function walletView(wallet: Wallet) {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}
export function ledgerView(entry: WalletLedgerEntry) {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    walletVersion: entry.walletVersion,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    createdAt: entry.createdAt.toISOString(),
  };
}
