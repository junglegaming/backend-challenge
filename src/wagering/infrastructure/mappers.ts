import { Money } from "../../shared/domain/money";
import { WagerTransaction } from "../domain/wager-transaction";
import { Wallet } from "../domain/wallet";
import { WalletLedgerEntry } from "../domain/wallet-ledger-entry";
import { LedgerRecord, WagerTransactionRecord, WalletRecord } from "./records";

export function walletFromRecord(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    ...record,
    balance: Money.from({ amount: record.balance, currency: record.currency }),
  });
}
export function walletToRecord(wallet: Wallet): WalletRecord {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.toString(),
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}
export function transactionFromRecord(record: WagerTransactionRecord): WagerTransaction {
  if (record.observedBalance != null && !record.observedCurrency)
    throw new Error("Invalid observed money mapping");
  return WagerTransaction.rehydrate({
    ...record,
    referenceExternalTransactionId: record.referenceExternalTransactionId ?? undefined,
    referenceTransactionId: record.referenceTransactionId ?? undefined,
    failureCode: record.failureCode ?? undefined,
    processedAt: record.processedAt ?? undefined,
    referenceDeadlineAt: record.referenceDeadlineAt ?? undefined,
    nextAttemptAt: record.nextReferenceAttemptAt ?? undefined,
    money: Money.from({ amount: record.amount, currency: record.currency }),
    observedBalance:
      record.observedBalance == null
        ? null
        : Money.from({ amount: record.observedBalance, currency: record.observedCurrency ?? "" }),
  });
}
export function transactionToRecord(transaction: WagerTransaction): WagerTransactionRecord {
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    payloadHash: transaction.payloadHash,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    amount: transaction.money.toString(),
    currency: transaction.money.currency,
    status: transaction.status,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId,
    referenceTransactionId: transaction.referenceTransactionId,
    failureCode: transaction.failureCode,
    observedBalance: transaction.observedBalance?.toString(),
    observedCurrency: transaction.observedBalance?.currency,
    referenceDeadlineAt: transaction.referenceDeadlineAt,
    nextReferenceAttemptAt: transaction.nextAttemptAt,
    referenceAttempts: transaction.referenceAttempts,
    createdAt: transaction.createdAt,
    updatedAt: transaction.processedAt ?? transaction.createdAt,
    processedAt: transaction.processedAt,
  };
}
export function ledgerFromRecord(record: LedgerRecord): WalletLedgerEntry {
  const money = (amount: string) => Money.from({ amount, currency: record.currency });
  return WalletLedgerEntry.rehydrate({
    ...record,
    money: money(record.amount),
    balanceBefore: money(record.balanceBefore),
    balanceAfter: money(record.balanceAfter),
  });
}
export function ledgerToRecord(entry: WalletLedgerEntry): LedgerRecord {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    walletVersion: entry.walletVersion,
    direction: entry.direction,
    amount: entry.money.toString(),
    currency: entry.money.currency,
    balanceBefore: entry.balanceBefore.toString(),
    balanceAfter: entry.balanceAfter.toString(),
    createdAt: entry.createdAt,
  };
}
