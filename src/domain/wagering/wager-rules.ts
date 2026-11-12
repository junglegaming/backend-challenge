import { FailureCode } from "../shared/failure-code";
import type { Wallet } from "../wallet/wallet";
import { LedgerDirection } from "../wallet/wallet-ledger-entry";
import { type WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "./wager-transaction";

/** What must happen to a transaction, given the wallet and its reference. */
export type WagerDecision =
  /** Apply it. `direction` is undefined for LOSS (no balance movement). */
  | { outcome: "apply"; direction?: LedgerDirection }
  /** Terminal business rejection. */
  | { outcome: "reject"; failureCode: FailureCode }
  /** The reference is not available yet: park as PENDING_REFERENCE. */
  | { outcome: "wait" };

export interface WagerRulesInput {
  transaction: WagerTransaction;
  wallet: Wallet;
  /** Transaction resolved by (providerId, referenceExternalTransactionId), if any. */
  reference: WagerTransaction | null;
  /** True when the reference was already reversed by a PROCESSED REFUND/ROLLBACK. */
  referenceAlreadyReversed: boolean;
}

/** Which kinds each operation is allowed to reference. */
const ALLOWED_REFERENCE_KINDS: Readonly<Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>>> = {
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};

const REVERSAL_KINDS: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

/**
 * Pure business rules for BET / WIN / LOSS / REFUND / ROLLBACK.
 *
 * It only *decides*; applying the decision (moving money, writing the ledger,
 * persisting) is the use case's job. Keeping it side-effect free makes every
 * rule unit-testable without a database.
 *
 * Checks run from the cheapest/most fundamental to the most specific:
 *   ownership → currency → reference → balance.
 */
export const WagerRules = {
  decide(input: WagerRulesInput): WagerDecision {
    const { transaction: tx, wallet } = input;

    if (wallet.playerId !== tx.playerId) {
      return reject(FailureCode.PlayerMismatch);
    }
    if (wallet.currency !== tx.money.currency) {
      return reject(FailureCode.CurrencyMismatch);
    }

    if (tx.referenceExternalTransactionId) {
      const referenceDecision = checkReference(input);
      if (referenceDecision) {
        return referenceDecision;
      }
    }

    if (!tx.affectsBalance()) {
      return { outcome: "apply" };
    }

    const direction = tx.ledgerDirectionFor(input.reference ?? undefined);
    if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
      return reject(
        tx.kind === WagerTransactionKind.Bet
          ? FailureCode.InsufficientFunds
          : FailureCode.ReversalInsufficientFunds,
      );
    }
    return { outcome: "apply", direction };
  },
};

/** Returns a decision when the reference blocks the transaction, or null if it is valid. */
function checkReference(input: WagerRulesInput): WagerDecision | null {
  const { transaction: tx, reference } = input;

  // Not arrived yet, or arrived but still waiting for its own reference.
  if (!reference || !reference.isTerminal()) {
    return { outcome: "wait" };
  }

  const sameContext =
    reference.providerId === tx.providerId &&
    reference.playerId === tx.playerId &&
    reference.walletId === tx.walletId &&
    reference.money.currency === tx.money.currency &&
    reference.roundId === tx.roundId;
  if (!sameContext) {
    return reject(FailureCode.ReferenceMismatch);
  }

  if (!ALLOWED_REFERENCE_KINDS[tx.kind]?.includes(reference.kind)) {
    return reject(FailureCode.ReferenceInvalidKind);
  }

  if (reference.status !== WagerTransactionStatus.Processed) {
    return reject(FailureCode.ReferenceNotProcessed);
  }

  if (REVERSAL_KINDS.has(tx.kind)) {
    if (!reference.money.equals(tx.money)) {
      return reject(FailureCode.AmountMismatch);
    }
    if (input.referenceAlreadyReversed) {
      return reject(FailureCode.ReferenceAlreadyReversed);
    }
  }
  return null;
}

function reject(failureCode: FailureCode): WagerDecision {
  return { outcome: "reject", failureCode };
}

