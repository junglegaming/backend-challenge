import { InsufficientFundsError } from './errors';
import { FailureCode } from './failure-code';
import { type WagerTransaction, WagerTransactionStatus } from './wager-transaction';
import type { Wallet } from './wallet';
import { LedgerDirection, type WalletLedgerEntry } from './wallet-ledger-entry';

export interface SettlementInput {
  wallet: Wallet;
  transaction: WagerTransaction;
  /** resolved by (providerId, referenceExternalTransactionId), when the transaction has one */
  reference: WagerTransaction | undefined;
  /** a PROCESSED REFUND/ROLLBACK already points at `reference` */
  referenceAlreadyReversed: boolean;
  ledgerEntryId: string;
  now: Date;
}

export type SettlementDecision =
  | { type: 'processed'; entry: WalletLedgerEntry | undefined }
  | { type: 'rejected'; failureCode: FailureCode }
  /** the reference is not (yet) available; the caller decides between retry and give-up */
  | { type: 'awaiting-reference' };

/**
 * Pure domain service holding the wagering rules (section 7). It mutates the
 * wallet / transaction aggregates in memory; persistence is the caller's job.
 * For 'awaiting-reference' nothing is mutated.
 */
export class WagerSettlement {
  settle(input: SettlementInput): SettlementDecision {
    const { wallet, transaction: tx, reference, now } = input;

    const violation = this.checkOwnership(wallet, tx) ?? (tx.hasReference() ? this.checkReference(input) : undefined);
    if (violation === 'awaiting-reference') {
      return { type: 'awaiting-reference' };
    }
    if (violation) {
      tx.reject(violation, now, wallet.balance);
      return { type: 'rejected', failureCode: violation };
    }

    if (!tx.affectsBalance()) {
      tx.markProcessed(reference?.id, now, wallet.balance);
      return { type: 'processed', entry: undefined };
    }

    const direction = tx.ledgerDirectionFor(reference);
    const movement = { entryId: input.ledgerEntryId, transactionId: tx.id, money: tx.money, at: now };
    try {
      const entry = direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
      tx.markProcessed(reference?.id, now, wallet.balance);
      return { type: 'processed', entry };
    } catch (error) {
      if (!(error instanceof InsufficientFundsError)) throw error;
      // A reversal that cannot be honoured is operationally different from a bet without funds.
      const code = tx.isReversal() ? FailureCode.ReversalInsufficientFunds : FailureCode.InsufficientFunds;
      tx.reject(code, now, wallet.balance);
      return { type: 'rejected', failureCode: code };
    }
  }

  private checkOwnership(wallet: Wallet, tx: WagerTransaction): FailureCode | undefined {
    if (!tx.money.hasCurrency(wallet.currency)) return FailureCode.CurrencyMismatch;
    if (tx.playerId !== wallet.playerId) return FailureCode.WalletPlayerMismatch;
    return undefined;
  }

  private checkReference(input: SettlementInput): FailureCode | 'awaiting-reference' | undefined {
    const { transaction: tx, reference } = input;
    if (!reference) return 'awaiting-reference';

    switch (reference.status) {
      case WagerTransactionStatus.Pending:
      case WagerTransactionStatus.PendingReference:
        // The reference exists but has not been applied yet: wait for it.
        return 'awaiting-reference';
      case WagerTransactionStatus.Rejected:
      case WagerTransactionStatus.Failed:
        return FailureCode.ReferenceNotProcessed;
      case WagerTransactionStatus.Processed:
        break;
    }

    const sameContext =
      reference.providerId === tx.providerId &&
      reference.playerId === tx.playerId &&
      reference.walletId === tx.walletId &&
      reference.money.currency === tx.money.currency &&
      reference.roundId === tx.roundId;
    if (!sameContext) return FailureCode.ReferenceMismatch;

    if (!tx.canReference(reference.kind)) return FailureCode.ReferenceKindNotAllowed;

    if (tx.isReversal()) {
      // Partial reversals are out of scope.
      if (!reference.money.equals(tx.money)) return FailureCode.ReferenceAmountMismatch;
      if (input.referenceAlreadyReversed) return FailureCode.ReferenceAlreadyReversed;
    }
    return undefined;
  }
}
