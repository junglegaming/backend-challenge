import type { Money } from '../shared/money';
import { LedgerDirection } from '../wallet/ledger-direction';
import type { Wallet } from '../wallet/wallet';
import type { WalletLedgerEntry } from '../wallet/wallet-ledger-entry';
import { InsufficientFundsError } from '../wallet/wallet.errors';
import { FailureCode } from './failure-code';
import { WagerTransactionKind, WagerTransactionStatus } from './wager-enums';
import type { WagerTransaction } from './wager-transaction';
import { InvalidTransactionError, InvalidTransactionStateError } from './wagering.errors';

export interface ProcessWagerInput {
  transaction: WagerTransaction;
  wallet: Wallet;
  /** Resolved by (providerId, referenceExternalTransactionId); undefined when it has not arrived yet. */
  reference: WagerTransaction | undefined;
  /** True when another PROCESSED REFUND/ROLLBACK already targets `reference`. */
  referenceAlreadyReversed: boolean;
  entryId: string;
  now: Date;
}

export type ProcessWagerResult =
  | { status: WagerTransactionStatus.Processed; entry: WalletLedgerEntry | undefined }
  | { status: WagerTransactionStatus.Rejected; failureCode: FailureCode }
  | { status: WagerTransactionStatus.PendingReference };

const K = WagerTransactionKind;

/** Kinds a ROLLBACK may revert / a REFUND may revert. */
const ROLLBACKABLE: readonly WagerTransactionKind[] = [K.Bet, K.Win, K.Refund];
const REFUNDABLE: readonly WagerTransactionKind[] = [K.Bet];

/**
 * Pure domain service with the business rules of section 7.
 * No I/O: the caller loads the wallet/reference (under the wallet lock) and persists the outcome.
 * It mutates the passed aggregates (transaction + wallet) only when the outcome is applied.
 */
export class WagerRulesService {
  process(input: ProcessWagerInput): ProcessWagerResult {
    const { transaction: tx, wallet } = input;

    if (tx.kind === K.Opening) {
      throw new InvalidTransactionError('OPENING is internal and handled by the wallet opening flow');
    }
    if (tx.isTerminal()) {
      throw new InvalidTransactionStateError(`transaction ${tx.id} is already ${tx.status}`);
    }
    if (tx.walletId !== wallet.id) {
      throw new InvalidTransactionError('transaction does not belong to the given wallet');
    }
    if (tx.playerId !== wallet.playerId) {
      return this.reject(tx, FailureCode.WalletPlayerMismatch);
    }
    if (tx.money.currency !== wallet.currency) {
      return this.reject(tx, FailureCode.CurrencyMismatch);
    }

    switch (tx.kind) {
      case K.Bet:
        return this.applyDebit(input, undefined, FailureCode.InsufficientFunds);
      case K.Win:
        return this.applyCredit(input, undefined);
      case K.Loss:
        tx.markProcessed(undefined, input.now);
        return { status: WagerTransactionStatus.Processed, entry: undefined };
      case K.Refund:
      case K.Rollback:
        return this.processReversal(input);
    }
  }

  private processReversal(input: ProcessWagerInput): ProcessWagerResult {
    const { transaction: tx, reference } = input;

    if (!reference) {
      tx.markPendingReference();
      return { status: WagerTransactionStatus.PendingReference };
    }
    if (
      reference.providerId !== tx.providerId ||
      reference.playerId !== tx.playerId ||
      reference.walletId !== tx.walletId ||
      reference.money.currency !== tx.money.currency ||
      reference.roundId !== tx.roundId
    ) {
      return this.reject(tx, FailureCode.ReferenceMismatch);
    }
    const allowed = tx.kind === K.Refund ? REFUNDABLE : ROLLBACKABLE;
    if (!allowed.includes(reference.kind)) {
      return this.reject(tx, FailureCode.InvalidReferenceKind);
    }
    if (reference.status === WagerTransactionStatus.Pending || reference.status === WagerTransactionStatus.PendingReference) {
      // the reference is known but not applied yet: wait for it like a missing one
      tx.markPendingReference();
      return { status: WagerTransactionStatus.PendingReference };
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      return this.reject(tx, FailureCode.ReferenceNotProcessed);
    }
    if (input.referenceAlreadyReversed) {
      return this.reject(tx, FailureCode.AlreadyReversed);
    }
    if (!tx.money.equals(reference.money)) {
      return this.reject(tx, FailureCode.AmountMismatch);
    }

    return tx.ledgerDirectionFor(reference) === LedgerDirection.Debit
      ? this.applyDebit(input, reference, FailureCode.ReversalWouldOverdraw)
      : this.applyCredit(input, reference);
  }

  private applyDebit(input: ProcessWagerInput, reference: WagerTransaction | undefined, overdrawCode: FailureCode): ProcessWagerResult {
    const { transaction: tx, wallet } = input;
    try {
      const entry = wallet.debit(this.movement(input));
      tx.markProcessed(reference?.id, input.now);
      return { status: WagerTransactionStatus.Processed, entry };
    } catch (error) {
      if (error instanceof InsufficientFundsError) return this.reject(tx, overdrawCode);
      throw error;
    }
  }

  private applyCredit(input: ProcessWagerInput, reference: WagerTransaction | undefined): ProcessWagerResult {
    const entry = input.wallet.credit(this.movement(input));
    input.transaction.markProcessed(reference?.id, input.now);
    return { status: WagerTransactionStatus.Processed, entry };
  }

  private movement(input: ProcessWagerInput): { entryId: string; transactionId: string; money: Money; at: Date } {
    return {
      entryId: input.entryId,
      transactionId: input.transaction.id,
      money: input.transaction.money,
      at: input.now,
    };
  }

  private reject(tx: WagerTransaction, code: FailureCode): ProcessWagerResult {
    tx.reject(code);
    return { status: WagerTransactionStatus.Rejected, failureCode: code };
  }
}
