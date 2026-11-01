import { InvalidTransactionStateError } from "../../shared/domain/domain-error";
import { FailureCode } from "./failure-code";
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  WagerTransaction,
} from "./wager-transaction";
import { Wallet } from "./wallet";
import { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry";

export interface SettlementInput {
  transaction: WagerTransaction;
  wallet: Wallet | null;
  reference: WagerTransaction | null;
  referenceHasProcessedReversal: boolean;
  deadlineReached: boolean;
  now: Date;
  referenceTtlMs?: number;
  referenceRetryJitter?: number;
}
export type SettlementOutcome =
  | { type: "processed"; ledgerEntry?: WalletLedgerEntry }
  | { type: "rejected"; code: FailureCode }
  | { type: "pending" };

export function settle(input: SettlementInput): SettlementOutcome {
  const { transaction: tx, wallet, reference: ref, now } = input;
  const reject = (code: FailureCode): SettlementOutcome => {
    tx.reject(code, now, wallet?.balance ?? null, ref?.id);
    return { type: "rejected", code };
  };
  if (tx.isTerminal()) {
    // Replays belong to the application path and must never re-evaluate the domain.
    throw new InvalidTransactionStateError("Transaction is terminal");
  }
  if (!wallet) return reject(FailureCode.WalletNotFound);
  if (tx.playerId !== wallet.playerId) return reject(FailureCode.PlayerWalletMismatch);
  if (tx.money.currency !== wallet.currency) return reject(FailureCode.CurrencyMismatch);
  if ([Kind.Bet, Kind.Win, Kind.Refund, Kind.Rollback].includes(tx.kind) && tx.money.isZero()) {
    return reject(FailureCode.AmountNotPositive);
  }
  const pending = (expiredCode: FailureCode): SettlementOutcome => {
    if (input.deadlineReached) return reject(expiredCode);
    tx.markPendingReference(now, wallet.balance, input.referenceTtlMs, input.referenceRetryJitter);
    return { type: "pending" };
  };
  if (tx.referenceExternalTransactionId !== undefined) {
    if (!ref) return pending(FailureCode.ReferenceNotFound);
    const allowed = tx.kind === Kind.Rollback ? [Kind.Bet, Kind.Win, Kind.Refund] : [Kind.Bet];
    if (!allowed.includes(ref.kind)) return reject(FailureCode.ReferenceKindNotAllowed);
    if (
      tx.providerId !== ref.providerId ||
      tx.playerId !== ref.playerId ||
      tx.walletId.toLowerCase() !== ref.walletId.toLowerCase() ||
      tx.money.currency !== ref.money.currency ||
      tx.roundId !== ref.roundId
    )
      return reject(FailureCode.ReferenceScopeMismatch);
    if (tx.requiresReference() && !tx.money.equals(ref.money))
      return reject(FailureCode.ReferenceAmountMismatch);
    if ([Status.Pending, Status.PendingReference].includes(ref.status))
      return pending(FailureCode.ReferenceNotProcessed);
    if ([Status.Rejected, Status.Failed].includes(ref.status))
      return reject(FailureCode.ReferenceNotProcessed);
    if (tx.requiresReference() && input.referenceHasProcessedReversal)
      return reject(FailureCode.ReferenceAlreadyReversed);
  }
  if (tx.kind === Kind.Loss) {
    tx.markProcessed(ref?.id, now, wallet.balance);
    return { type: "processed" };
  }
  const direction = tx.ledgerDirectionFor(ref ?? undefined);
  if (direction === LedgerDirection.Debit && wallet.balance.isLessThan(tx.money)) {
    return reject(
      tx.kind === Kind.Rollback
        ? FailureCode.ReversalInsufficientFunds
        : FailureCode.InsufficientFunds,
    );
  }
  const movement = { transactionId: tx.id, entryId: tx.id, money: tx.money, at: now };
  const ledgerEntry =
    direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
  tx.markProcessed(ref?.id, now, wallet.balance);
  return { type: "processed", ...(ledgerEntry ? { ledgerEntry } : {}) };
}
