import type { Wallet } from "../../wallet/domain/wallet";
import { InsufficientFundsError } from "../../wallet/domain/wallet-errors";
import type { WalletLedgerEntry } from "../../wallet/domain/wallet-ledger-entry";
import { FailureCode } from "./failure-code";
import { InvalidWagerTransactionError } from "./wager-errors";
import type { WagerTransaction } from "./wager-transaction";
import { WagerTransactionKind, WagerTransactionStatus } from "./wager-transaction-kind";

export type ReferenceLookup =
  | { found: false }
  | {
      found: true;
      transaction: WagerTransaction;
      /** A PROCESSED REFUND/ROLLBACK already points at this reference (the DB partial unique index is the final guard). */
      alreadyReversed: boolean;
    };

export interface ProcessWagerInput {
  wallet: Wallet;
  /** PENDING (first attempt) or PENDING_REFERENCE (retry). */
  transaction: WagerTransaction;
  /** Required iff the transaction declares a reference. */
  reference?: ReferenceLookup;
  ledgerEntryId: string;
  at: Date;
  /** When to retry if the reference is still missing. */
  nextReferenceRetryAt: Date;
  /** Retry budget exhausted: a still-missing reference becomes REJECTED(REFERENCE_NOT_FOUND). */
  referenceRetryExhausted: boolean;
}

export type ProcessWagerOutcome =
  | { type: "PROCESSED"; ledgerEntry: WalletLedgerEntry | undefined }
  | { type: "REJECTED"; failureCode: FailureCode }
  | { type: "PENDING_REFERENCE"; firstTime: boolean };

/**
 * Domain service with the business rules of section 7. It mutates the wallet and transaction
 * aggregates in memory; persistence and locking are the application layer's job.
 *
 * Callers must hold the wallet lock: rules such as "balance never negative" and "reverse once"
 * are only meaningful against a serialised view of the wallet.
 */
export class WagerProcessor {
  process(input: ProcessWagerInput): ProcessWagerOutcome {
    const { wallet, transaction: tx, at } = input;
    if (tx.isTerminal()) {
      throw new InvalidWagerTransactionError(`transaction ${tx.id} is already ${tx.status}`);
    }

    if (tx.walletId !== wallet.id)
      throw new InvalidWagerTransactionError("transaction does not target this wallet");
    if (tx.money.currency !== wallet.currency) return this.reject(input, FailureCode.CurrencyMismatch);
    if (tx.playerId !== wallet.playerId) return this.reject(input, FailureCode.WalletPlayerMismatch);

    let reference: WagerTransaction | undefined;
    if (tx.hasReference()) {
      const lookup = input.reference;
      if (!lookup)
        throw new InvalidWagerTransactionError("reference lookup is required for referencing transactions");

      // A reference that is itself waiting on its own reference is not usable yet: keep waiting.
      const usable = lookup.found && lookup.transaction.status !== WagerTransactionStatus.PendingReference;
      if (!usable) return this.waitForReference(input);

      reference = lookup.transaction;
      const failure = this.validateReference(tx, reference, lookup.alreadyReversed);
      // A reference from another wallet is never linked: the composite FK (reference, wallet) forbids it.
      if (failure)
        return this.reject(input, failure, reference.walletId === tx.walletId ? reference.id : undefined);
    }

    if (!tx.affectsBalance()) {
      tx.markProcessed(reference?.id, at, wallet.balance);
      return { type: "PROCESSED", ledgerEntry: undefined };
    }

    const direction = tx.ledgerDirectionFor(reference);
    try {
      const ledgerEntry = wallet.apply(direction, {
        ledgerEntryId: input.ledgerEntryId,
        transactionId: tx.id,
        money: tx.money,
        at,
      });
      tx.markProcessed(reference?.id, at, wallet.balance);
      return { type: "PROCESSED", ledgerEntry };
    } catch (error) {
      if (!(error instanceof InsufficientFundsError)) throw error;
      // Same symptom, different operational meaning: a bet without funds is routine,
      // a reversal that cannot be applied needs a human.
      const code = tx.isReversal() ? FailureCode.ReversalInsufficientFunds : FailureCode.InsufficientFunds;
      return this.reject(input, code, reference?.id);
    }
  }

  private validateReference(
    tx: WagerTransaction,
    ref: WagerTransaction,
    alreadyReversed: boolean,
  ): FailureCode | undefined {
    if (!tx.canReference(ref)) return FailureCode.ReferenceKindNotAllowed;
    const sameScope =
      ref.providerId === tx.providerId &&
      ref.playerId === tx.playerId &&
      ref.walletId === tx.walletId &&
      ref.roundId === tx.roundId &&
      ref.money.currency === tx.money.currency;
    if (!sameScope) return FailureCode.ReferenceMismatch;
    if (ref.status !== WagerTransactionStatus.Processed) return FailureCode.ReferenceNotProcessed;
    if (tx.isReversal()) {
      if (!ref.money.equals(tx.money)) return FailureCode.ReferenceAmountMismatch;
      if (alreadyReversed) return FailureCode.ReferenceAlreadyReversed;
    }
    // Defensive: OPENING is never a valid reference target (not in ALLOWED_REFERENCE_KINDS either).
    if (ref.kind === WagerTransactionKind.Opening) return FailureCode.ReferenceKindNotAllowed;
    return undefined;
  }

  private waitForReference(input: ProcessWagerInput): ProcessWagerOutcome {
    const { transaction: tx, wallet } = input;
    if (tx.status === WagerTransactionStatus.Pending) {
      tx.markPendingReference(input.nextReferenceRetryAt, wallet.balance);
      return { type: "PENDING_REFERENCE", firstTime: true };
    }
    if (input.referenceRetryExhausted) return this.reject(input, FailureCode.ReferenceNotFound);
    tx.scheduleReferenceRetry(input.nextReferenceRetryAt);
    return { type: "PENDING_REFERENCE", firstTime: false };
  }

  private reject(input: ProcessWagerInput, code: FailureCode, referenceId?: string): ProcessWagerOutcome {
    input.transaction.reject(code, input.at, input.wallet.balance, referenceId);
    return { type: "REJECTED", failureCode: code };
  }
}
